import { randomUUID } from 'node:crypto';
import { constants, openSync, closeSync, fsyncSync, writeFileSync, renameSync, existsSync, lstatSync } from 'node:fs';
import path from 'node:path';
import { invariant } from '../errors.ts';
import { privateDirectory, readControlled } from '../fsutil.ts';
import type { Store } from '../store.ts';
import type { FinishEvidence } from '../types.ts';
import { sha256 } from '../orchestration/requests.ts';

export interface AnswerArtifact {
  answer_id: string; request_id: string; job_task_id: string | null; business_session_key: string | null;
  producer_role: 'bridge' | 'route' | 'business' | 'system'; kind: 'final' | 'deliverable' | 'partial';
  state: 'staging' | 'ready' | 'failed'; completeness: 'complete' | 'partial' | 'legacy-truncated' | 'unknown';
  relative_path: string; sha256: string | null; bytes: number | null; finish_evidence_json: string | null;
}
export interface AnswerAccess { role: 'bridge' | 'route' | 'recap' | 'delivery'; scope: string; requestId?: string }
export type ArtifactFinishEvidence = FinishEvidence | { backend: 'controller'; threadId: string; turnId: string; completed: true; callbacksCompleted: true }
  | { backend: 'system'; requestId: string; completed: true; phase: 'completed' | 'failed' | 'cancelled' | 'interrupted'; outcome: 'succeeded' | 'failed' | 'cancelled'; errorCode?: string };
function syncedWrite(file: string, bytes: Buffer | string): void {
  const fd = openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o600);
  try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
}
function syncDirectory(dir: string): void {
  const fd = openSync(dir, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
function validFinish(evidence: ArtifactFinishEvidence): boolean {
  if (evidence.backend === 'system') return !!evidence.requestId && evidence.completed === true;
  if (evidence.backend === 'controller') return !!evidence.threadId && !!evidence.turnId && evidence.completed === true && evidence.callbacksCompleted === true;
  return evidence.cleanupConfirmed === true && (evidence.backend === 'codex' ? evidence.threadStarted === true && evidence.turnStarted === true &&
    evidence.turnCompleted === true && evidence.exitCode === 0 : evidence.backend === 'pi' && evidence.agentSettled === true && evidence.idle === true);
}

export class ArtifactStore {
  readonly root: string;
  constructor(private store: Store, root: string, private maxOriginalBytes = 16777216) { this.root = privateDirectory(root); }
  get(id: string): AnswerArtifact {
    const row = this.store.db.prepare('SELECT * FROM answer_artifacts WHERE answer_id=?').get(id) as AnswerArtifact | undefined;
    invariant(row, 'ANSWER_NOT_FOUND'); return row;
  }
  stage(requestId: string, producer: AnswerArtifact['producer_role'], jobTaskId?: string, sessionKey?: string): AnswerArtifact {
    invariant(/^[0-9a-f-]{36}$/.test(requestId), 'ANSWER_REQUEST_ID');
    const request = this.store.db.prepare('SELECT job_task_id FROM orchestration_requests WHERE request_id=?').get(requestId) as { job_task_id: string | null } | undefined;
    invariant(request && (!jobTaskId || request.job_task_id === jobTaskId), 'ANSWER_REQUEST_OWNER');
    if (jobTaskId) invariant(this.store.get(jobTaskId).session_key === sessionKey, 'ANSWER_SESSION_OWNER');
    const id = randomUUID(), relative = path.join(requestId, id, 'answer.md');
    privateDirectory(path.dirname(path.join(this.root, relative)));
    this.store.db.prepare(`INSERT INTO answer_artifacts(answer_id,request_id,job_task_id,producer_role,business_session_key,kind,state,completeness,relative_path,created_at)
      VALUES (?,?,?,?,?,'final','staging','unknown',?,?)`).run(id, requestId, jobTaskId ?? null, producer, sessionKey ?? null, relative, Date.now());
    return this.get(id);
  }
  private file(row: AnswerArtifact): string {
    invariant(row.relative_path === path.join(row.request_id, row.answer_id, 'answer.md') && /^[0-9a-f-]{36}$/.test(row.request_id) && /^[0-9a-f-]{36}$/.test(row.answer_id), 'ANSWER_PATH');
    const file = path.join(this.root, row.relative_path);
    for (const dir of [this.root, path.dirname(path.dirname(file)), path.dirname(file)]) invariant(lstatSync(dir).isDirectory() && !lstatSync(dir).isSymbolicLink(), 'ANSWER_SYMLINK');
    return file;
  }
  /** Capture before display decoration or clipping, but do not make the draft readable. */
  capture(id: string, text: string): void {
    const row = this.get(id); invariant(row.state === 'staging', 'ANSWER_IMMUTABLE');
    const bytes = Buffer.from(text, 'utf8'), file = this.file(row);
    invariant(!existsSync(file), 'ANSWER_IMMUTABLE');
    syncedWrite(file + '.part', bytes.subarray(0, this.maxOriginalBytes));
    if (bytes.length > this.maxOriginalBytes) {
      this.store.db.prepare("UPDATE answer_artifacts SET state='failed',completeness='partial',bytes=? WHERE answer_id=?").run(this.maxOriginalBytes, id);
      invariant(false, 'ARTIFACT_LIMIT');
    }
    this.store.db.prepare('UPDATE answer_artifacts SET sha256=?,bytes=? WHERE answer_id=?').run(sha256(bytes), bytes.length, id);
  }
  async publish(id: string, evidence: ArtifactFinishEvidence, commit: () => void): Promise<AnswerArtifact> {
    const row = this.get(id);
    invariant(row.state === 'staging' && validFinish(evidence) && row.sha256 && row.bytes !== null, 'ANSWER_FINISH_UNVERIFIED');
    invariant(row.producer_role === 'system' ? evidence.backend === 'system' && evidence.requestId === row.request_id :
      row.producer_role === 'business' ? evidence.backend === 'codex' || evidence.backend === 'pi' : evidence.backend === 'controller', 'ANSWER_FINISH_UNVERIFIED');
    const file = this.file(row), bytes = await readControlled(this.root, file + '.part', this.maxOriginalBytes);
    invariant(bytes.length === row.bytes && sha256(bytes) === row.sha256, 'ANSWER_HASH_MISMATCH');
    // Persist completion evidence before publish. A crash never requires business replay.
    const observedFinish = { ...evidence, completedAt: Date.now() };
    const manifest = { answerId: id, requestId: row.request_id, jobTaskId: row.job_task_id, producerRole: row.producer_role,
      sessionKey: row.business_session_key, sha256: row.sha256, bytes: row.bytes, finishEvidence: observedFinish };
    syncedWrite(path.join(path.dirname(file), 'manifest.json.part'), JSON.stringify(manifest));
    renameSync(path.join(path.dirname(file), 'manifest.json.part'), path.join(path.dirname(file), 'manifest.json'));
    this.store.db.prepare('UPDATE answer_artifacts SET finish_evidence_json=? WHERE answer_id=? AND state=\'staging\'').run(JSON.stringify(observedFinish), id);
    invariant(!existsSync(file), 'ANSWER_IMMUTABLE');
    renameSync(file + '.part', file); syncDirectory(path.dirname(file));
    return this.commitReady(row, commit);
  }
  private commitReady(row: AnswerArtifact, commit: () => void): AnswerArtifact {
    return this.store.atomic(() => {
      if (row.job_task_id) {
        const job = this.store.get(row.job_task_id);
        invariant(row.producer_role === 'business' ? job.kind === 'agent' && job.status === 'running' : job.kind === 'command' && job.status === 'queued', 'ANSWER_JOB_NOT_RUNNING');
      }
      invariant(this.store.db.prepare("UPDATE answer_artifacts SET state='ready',completeness='complete',committed_at=? WHERE answer_id=? AND state='staging'")
        .run(Date.now(), row.answer_id).changes === 1, 'ANSWER_STATE_CONFLICT');
      commit(); return this.get(row.answer_id);
    });
  }
  /** Repair a rename/SQL gap only; the caller reconciles the original job and never runs it again. */
  async recover(id: string, commit: (rawFinal: string) => void): Promise<AnswerArtifact> {
    const row = this.get(id), file = this.file(row);
    invariant(row.state === 'staging' && row.finish_evidence_json, 'ANSWER_RECOVERY_UNVERIFIED');
    const sourceFile = existsSync(file) ? file : file + '.part';
    invariant(existsSync(sourceFile), 'ANSWER_RECOVERY_UNVERIFIED');
    const evidence = JSON.parse(row.finish_evidence_json) as ArtifactFinishEvidence;
    invariant(validFinish(evidence), 'ANSWER_RECOVERY_UNVERIFIED');
    const manifest = JSON.parse((await readControlled(this.root, path.join(path.dirname(file), 'manifest.json'), 16384)).toString('utf8'));
    invariant(manifest.answerId === row.answer_id && manifest.requestId === row.request_id && manifest.jobTaskId === row.job_task_id &&
      manifest.sha256 === row.sha256 && manifest.bytes === row.bytes && JSON.stringify(manifest.finishEvidence) === row.finish_evidence_json, 'ANSWER_RECOVERY_UNVERIFIED');
    const bytes = await readControlled(this.root, sourceFile, this.maxOriginalBytes);
    invariant(bytes.length === row.bytes && sha256(bytes) === row.sha256, 'ANSWER_HASH_MISMATCH');
    if (sourceFile !== file) { renameSync(sourceFile, file); syncDirectory(path.dirname(file)); }
    return this.commitReady(row, () => commit(bytes.toString('utf8')));
  }
  async read(id: string, access: AnswerAccess): Promise<Buffer> {
    invariant(['route', 'recap', 'delivery'].includes(access.role), 'ANSWER_RAW_ACCESS_DENIED');
    const row = this.get(id);
    const request = this.store.db.prepare('SELECT conversation_scope FROM orchestration_requests WHERE request_id=?').get(row.request_id) as { conversation_scope: string };
    invariant(request.conversation_scope === access.scope && (access.role !== 'recap' || access.requestId === row.request_id), 'ANSWER_RAW_ACCESS_DENIED');
    invariant(row.state === 'ready' && row.completeness === 'complete', 'ANSWER_NOT_READY');
    const bytes = await readControlled(this.root, this.file(row), this.maxOriginalBytes);
    invariant(bytes.length === row.bytes && sha256(bytes) === row.sha256, 'ANSWER_HASH_MISMATCH');
    return bytes;
  }
  writeRecap(id: string, value: unknown): void {
    const row = this.get(id); invariant(row.state === 'ready', 'ANSWER_NOT_READY');
    const dir = path.dirname(this.file(row)), file = path.join(dir, 'recap.v1.json');
    syncedWrite(file + '.part', JSON.stringify(value)); renameSync(file + '.part', file); syncDirectory(dir);
  }
}
