import { createHash, randomUUID } from 'node:crypto';
import type { Store } from '../store.ts';
import type { Incoming, Route } from '../types.ts';
import { invariant } from '../errors.ts';

export const sha256 = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');
export function conversationScope(route: Route): string {
  return sha256(JSON.stringify([route.kind, route.channelId, route.targetId, route.senderId]));
}
export type RequestPhase = 'accepted' | 'media_preparing' | 'bridge_planning' | 'route_planning' |
  'awaiting_business' | 'result_processing' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
export interface OriginalRequest {
  request_id: string; ingress_seq: number; conversation_scope: string; raw_query: string;
  raw_query_sha256: string; request_hash: string; phase: RequestPhase; source_request_id: string | null;
  job_task_id: string | null; attachments_json: string; received_at: number; route_json: string;
  hash_version: 'legacy-v3' | 'raw-v4'; input_provenance: 'decoded-original' | 'legacy-normalized';
}
export class RequestStore {
  constructor(private store: Store) {}
  get(id: string, scope: string): OriginalRequest {
    const row = this.store.db.prepare('SELECT * FROM orchestration_requests WHERE request_id=? AND conversation_scope=?').get(id, scope) as OriginalRequest | undefined;
    invariant(row, 'REQUEST_NOT_FOUND'); return row;
  }
  accept(incoming: Incoming): { request: OriginalRequest; duplicate: boolean } {
    invariant(typeof incoming.text === 'string' && Buffer.byteLength(incoming.text) <= 65536 && !incoming.text.includes('\0') &&
      Buffer.from(incoming.text, 'utf8').toString('utf8') === incoming.text, 'INPUT_TEXT');
    return this.store.atomic(() => {
      const scope = conversationScope(incoming.route), digest = sha256(JSON.stringify([incoming.route, incoming.text, incoming.media]));
      const old = this.store.db.prepare('SELECT * FROM orchestration_requests WHERE channel_id=? AND message_id=?').get(incoming.route.channelId, incoming.messageId) as OriginalRequest | undefined;
      if (old) {
        // Legacy dedup keeps its original hash semantics; never bless old normalized text as raw.
        const text = old.hash_version === 'legacy-v3' ? incoming.text.trim() || (incoming.media.length ? '请分析这张图片' : incoming.text) : incoming.text;
        const expected = sha256(JSON.stringify([incoming.route, text, incoming.media]));
        invariant(old.request_hash === expected && old.conversation_scope === scope, 'REQUEST_ID_CONFLICT');
        return { request: old, duplicate: true };
      }
      const id = randomUUID(), now = Date.now();
      this.store.db.prepare(`INSERT INTO orchestration_requests(request_id,channel_id,message_id,conversation_scope,route_json,raw_query,
        raw_query_sha256,request_hash,hash_version,input_provenance,attachments_json,phase,received_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,'raw-v4','decoded-original',?,'accepted',?,?)`).run(id, incoming.route.channelId, incoming.messageId,
        scope, JSON.stringify(incoming.route), incoming.text, sha256(incoming.text), digest, JSON.stringify(incoming.media), incoming.receivedAt, now);
      return { request: this.get(id, scope), duplicate: false };
    });
  }
  transition(id: string, scope: string, expected: RequestPhase[], phase: RequestPhase, failureCode?: string): void {
    invariant(expected.length > 0, 'REQUEST_PHASE');
    const next: Record<RequestPhase, RequestPhase[]> = {
      accepted: ['media_preparing', 'bridge_planning', 'completed', 'failed', 'cancelled', 'interrupted'],
      media_preparing: ['bridge_planning', 'failed', 'cancelled', 'interrupted'],
      bridge_planning: ['route_planning', 'completed', 'failed', 'cancelled', 'interrupted'],
      route_planning: ['awaiting_business', 'result_processing', 'completed', 'failed', 'cancelled', 'interrupted'],
      awaiting_business: ['result_processing', 'failed', 'cancelled', 'interrupted'],
      result_processing: ['completed', 'failed', 'cancelled', 'interrupted'],
      completed: [], failed: [], cancelled: [], interrupted: [],
    };
    invariant(expected.every(previous => next[previous].includes(phase)), 'REQUEST_PHASE_TRANSITION');
    const result = this.store.db.prepare(`UPDATE orchestration_requests SET phase=?,failure_code=?,updated_at=?
      WHERE request_id=? AND conversation_scope=? AND phase IN (${expected.map(() => '?').join(',')})`)
      .run(phase, failureCode ?? null, Date.now(), id, scope, ...expected);
    invariant(result.changes === 1, 'REQUEST_PHASE_CONFLICT');
  }
  bindJob(id: string, scope: string, jobTaskId: string): void {
    this.store.atomic(() => {
      const request = this.get(id, scope), job = this.store.get(jobTaskId);
      invariant(conversationScope(JSON.parse(job.route_json)) === scope && job.kind === 'agent', 'REQUEST_JOB_OWNER');
      invariant(!request.job_task_id || request.job_task_id === jobTaskId, 'DUPLICATE_BUSINESS_SUBMIT');
      invariant(['route_planning', 'awaiting_business'].includes(request.phase), 'REQUEST_PHASE_CONFLICT');
      this.store.db.prepare("UPDATE orchestration_requests SET job_task_id=?,phase='awaiting_business',updated_at=? WHERE request_id=?")
        .run(jobTaskId, Date.now(), id);
    });
  }
  /** A control choice supplies parameters only; the source text remains immutable. */
  referencePending(controlId: string, sourceId: string, scope: string, now = Date.now()): OriginalRequest {
    return this.store.atomic(() => {
      const control = this.get(controlId, scope), source = this.get(sourceId, scope);
      invariant(control.ingress_seq > source.ingress_seq && (!source.job_task_id || this.store.get(source.job_task_id).kind === 'command') && source.phase === 'completed' &&
        now >= source.received_at, 'SOURCE_REQUEST_NOT_PENDING');
      const snapshot = this.store.db.prepare('SELECT route_snapshot_json FROM orchestration_requests WHERE request_id=?').get(sourceId) as { route_snapshot_json: string | null };
      const pending = snapshot.route_snapshot_json ? JSON.parse(snapshot.route_snapshot_json) : undefined;
      invariant(pending?.pendingSelection === true && Number.isSafeInteger(pending.expiresAt) && now < pending.expiresAt, 'SOURCE_REQUEST_NOT_PENDING');
      invariant(!this.store.db.prepare('SELECT 1 FROM orchestration_requests WHERE source_request_id=?').get(sourceId), 'SOURCE_REQUEST_ALREADY_REFERENCED');
      this.store.db.prepare('UPDATE orchestration_requests SET source_request_id=?,updated_at=? WHERE request_id=? AND source_request_id IS NULL').run(sourceId, now, controlId);
      return source;
    });
  }
}
