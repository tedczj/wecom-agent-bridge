import { constants, realpathSync } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import path from 'node:path';
import { invariant, BridgeError } from '../errors.ts';
import { inside } from '../fsutil.ts';
import type { Target } from '../routing/catalog.ts';
import { historyRevision, type CandidateMetadata } from './catalog.ts';
import { JsonlProjection, type ProjectedRecord } from './jsonl-projection.ts';

export interface HistoryMessage {
  nativeEventId: string; role: 'user' | 'assistant'; source: string;
  purpose: 'user-input' | 'assistant-final' | 'assistant-commentary' | 'automation' | 'unknown';
  timestamp: number | null; text: string;
}
export interface HistoryPage { messages: HistoryMessage[]; nextCursor?: string; contentTruncated: boolean; omittedKinds: string[]; observedThrough: string }
export type HistoryOrder = 'oldest-first' | 'newest-first';
export interface NativeEvidence {
  nativeId: string; cwd: string; activity: 'idle' | 'active' | 'interrupted' | 'unknown'; incomplete: boolean;
  model?: string; reasoning?: string; lastCompletedAt: number | null; lastTurnId?: string;
  sourceRevision: string; unknownEvents: boolean; turnOrderValid: boolean; page: HistoryPage;
}
const time = (value: unknown): number | null => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? Date.parse(value) : null;
const object = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const visibleText = (value: unknown): string => typeof value === 'string' ? value : Array.isArray(value) ? value.flatMap(part => {
  const item = object(part); return item && ['text', 'input_text', 'output_text'].includes(String(item.type)) && typeof item.text === 'string' ? [item.text] : [];
}).join('\n') : '';
function clipped(text: string, bytes: number): string {
  const data = Buffer.from(text); let end = Math.min(bytes, data.length);
  while (end < data.length && (data[end]! & 0xc0) === 0x80) end--;
  return data.subarray(0, end).toString('utf8');
}

export class NativeReader {
  async readWindow(target: Target, candidate: CandidateMetadata, cursor?: string, signal?: AbortSignal, order: HistoryOrder = 'oldest-first'): Promise<HistoryPage> {
    return (await this.inspect(target, candidate, cursor, signal, order)).page;
  }
  async inspect(target: Target, candidate: CandidateMetadata, cursor?: string, signal?: AbortSignal, order: HistoryOrder = 'oldest-first'): Promise<NativeEvidence> {
    const nativeId = candidate.ref.kind === 'codex' ? candidate.ref.threadId : candidate.ref.sessionId;
    let position = order === 'newest-first' ? Infinity : 0;
    if (cursor) {
      invariant(cursor.length <= 256 && /^[a-zA-Z0-9_-]+$/.test(cursor), 'HISTORY_CURSOR');
      let value: Record<string, unknown> | undefined;
      try { value = object(JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))); } catch { /* fail below */ }
      invariant(value && value.n === nativeId && value.r === candidate.sourceRevision && (value.o ?? 'oldest-first') === order && Number.isSafeInteger(value.p) && (value.p as number) >= 0, 'HISTORY_CURSOR');
      position = value.p as number;
    }
    const root = target.config.backend === 'codex' ? path.join(target.config.codex.home, 'sessions') : target.config.agent.sessionRoot;
    invariant(target.config.backend === candidate.ref.kind && path.isAbsolute(candidate.file) && inside(root, candidate.file), 'HISTORY_PATH');
    for (let parent = path.dirname(candidate.file); inside(root, parent); parent = path.dirname(parent)) {
      invariant(!(await lstat(parent)).isSymbolicLink(), 'HISTORY_PATH'); if (parent === root) break;
    }
    invariant(historyRevision(candidate.file) === candidate.sourceRevision, 'HISTORY_CHANGED');
    const handle = await open(candidate.file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const startStat = await handle.stat();
      invariant(startStat.isFile() && startStat.size <= 256 * 1024 * 1024, 'HISTORY_FILE_LIMIT');
      const evidence: NativeEvidence = { nativeId, cwd: target.directory.path, activity: 'unknown', incomplete: false,
        lastCompletedAt: null, sourceRevision: candidate.sourceRevision, unknownEvents: false, turnOrderValid: true,
        page: { messages: [], contentTruncated: false, omittedKinds: [], observedThrough: candidate.sourceRevision } };
      const omittedKinds = new Set<string>();
      let records = 0, ordinal = 0, bytesVisible = 0, piChars = 0, finalSeen = false, nextPosition: number | undefined, activeTurn: string | undefined;
      const recentPositions: number[] = [];
      const piRows = new Map<string, { parentId: string | null; message?: HistoryMessage }>(); let piLeaf: string | undefined;
      const message = (role: 'user' | 'assistant', text: string, row: Record<string, unknown>, source: string, purpose: HistoryMessage['purpose'], eventId?: string) => {
        if (!text) return;
        const index = ordinal++;
        if (order === 'newest-first') {
          if (index >= position) return;
          const body = clipped(text, 16384);
          evidence.page.contentTruncated ||= body !== text;
          evidence.page.messages.push({ role, text: body, nativeEventId: eventId ?? String(row.id ?? 'record:' + records), source, purpose, timestamp: time(row.timestamp) });
          recentPositions.push(index); bytesVisible += Buffer.byteLength(body);
          while (evidence.page.messages.length > 10 || bytesVisible > 16384) {
            bytesVisible -= Buffer.byteLength(evidence.page.messages.shift()!.text); recentPositions.shift();
          }
          return;
        }
        if (index < position) return;
        if (evidence.page.messages.length >= 10 || bytesVisible >= 16384) { nextPosition ??= index; return; }
        const body = clipped(text, 16384 - bytesVisible);
        if (!body && text) { nextPosition ??= index; return; }
        bytesVisible += Buffer.byteLength(body); evidence.page.contentTruncated ||= body !== text;
        evidence.page.messages.push({ role, text: body, nativeEventId: eventId ?? String(row.id ?? 'record:' + records), source, purpose, timestamp: time(row.timestamp) });
      };
      const receive = ({ value: row, omittedPaths }: ProjectedRecord) => {
        invariant(++records <= 100000, 'HISTORY_EVENT_LIMIT');
        if (omittedPaths.length) { evidence.page.contentTruncated = true; omittedKinds.add('oversized-string'); }
        if (records === 1) {
          const header = target.config.backend === 'codex' ? object(row.payload) : row;
          invariant(target.config.backend === 'codex' ? row.type === 'session_meta' : row.type === 'session' && row.version === 3, 'HISTORY_HEADER');
          invariant(header && header.id === nativeId && typeof header.cwd === 'string' && realpathSync(header.cwd) === target.directory.path, 'HISTORY_SCOPE');
          return;
        }
        if (target.config.backend === 'pi') {
          invariant(typeof row.id === 'string' && !piRows.has(row.id) && (row.parentId === null || typeof row.parentId === 'string'), 'HISTORY_BRANCH');
          const entry = object(row.message), role = entry?.role;
          const original = entry ? visibleText(entry.content) : '', retained = piChars < 4194304 ? original.slice(0, 2000) : '';
          piChars += retained.length;
          if (original !== retained) { evidence.page.contentTruncated = true; omittedKinds.add('pi-message-projection'); }
          const item = entry && (role === 'assistant' || role === 'user') ? { nativeEventId: row.id, role, text: retained, source: 'pi-native',
            purpose: 'unknown' as const, timestamp: time(row.timestamp) } as HistoryMessage : undefined;
          piRows.set(row.id, { parentId: row.parentId as string | null, message: item }); piLeaf = row.id;
          return; // Native assistant messages never prove RPC agent_settled.
        }
        const payload = object(row.payload);
        if (row.type === 'turn_context') {
          invariant(payload && typeof payload.cwd === 'string' && realpathSync(payload.cwd) === target.directory.path, 'HISTORY_SCOPE');
          if (typeof payload.model === 'string') evidence.model = payload.model;
          if (typeof payload.effort === 'string') evidence.reasoning = payload.effort;
          else if (typeof object(payload.effort)?.effort === 'string') evidence.reasoning = object(payload.effort)!.effort as string;
        } else if (row.type === 'response_item') {
          invariant(payload && typeof payload.type === 'string', 'HISTORY_FORMAT');
          if (payload.type === 'message' && (payload.role === 'assistant' || payload.role === 'user')) {
            const purpose = payload.source === 'automation' ? 'automation' : payload.role === 'user' ? 'unknown' : payload.phase === 'final_answer' ? 'assistant-final' : payload.phase === 'commentary' ? 'assistant-commentary' : 'unknown';
            message(payload.role, visibleText(payload.content), row, 'codex-response-item', purpose, typeof payload.id === 'string' ? payload.id : undefined);
            if (purpose === 'assistant-final') finalSeen = true;
          } else omittedKinds.add(payload.type === 'reasoning' ? 'reasoning' : 'tool-or-non-message');
        } else if (row.type === 'event_msg') {
          invariant(payload && typeof payload.type === 'string', 'HISTORY_FORMAT');
          if (['task_started', 'turn_started'].includes(payload.type)) {
            if (evidence.activity === 'active') evidence.turnOrderValid = false;
            evidence.activity = 'active'; finalSeen = false;
            activeTurn = typeof payload.turn_id === 'string' ? payload.turn_id : undefined;
          } else if (['task_complete', 'turn_complete'].includes(payload.type)) {
            const valid = evidence.activity === 'active' && (!activeTurn || payload.turn_id === activeTurn) && Boolean(visibleText(payload.last_agent_message).trim());
            if (!valid) evidence.turnOrderValid = false;
            evidence.activity = valid ? 'idle' : 'unknown';
            if (valid) { evidence.lastCompletedAt = time(row.timestamp); evidence.lastTurnId = activeTurn; }
            if (!finalSeen) message('assistant', visibleText(payload.last_agent_message), row, 'codex-completion-event', 'assistant-final');
          } else if (['turn_aborted', 'error'].includes(payload.type)) evidence.activity = 'interrupted';
          else if (payload.type === 'user_message') {
            // Do not infer a genuine user/automation source from the text itself.
            message('user', visibleText(payload.message), row, 'codex-event', payload.source === 'user' ? 'user-input' : payload.source === 'automation' ? 'automation' : 'unknown');
          } else if (payload.type === 'thread_settings_applied') {
            const settings = object(payload.thread_settings);
            invariant(payload.thread_id === nativeId && settings && typeof settings.cwd === 'string' && realpathSync(settings.cwd) === target.directory.path, 'HISTORY_SCOPE');
            if (typeof settings.model === 'string') evidence.model = settings.model;
            if (typeof settings.reasoning_effort === 'string') evidence.reasoning = settings.reasoning_effort;
          } else if (payload.type === 'item_completed') {
            const item = object(payload.item);
            invariant(payload.thread_id === nativeId && typeof payload.turn_id === 'string' && item && typeof item.type === 'string', 'HISTORY_FORMAT');
            // Installed 0.155.1 emits UI mirrors alongside response_item. Their
            // prose is not extra user work or independent completion evidence.
            omittedKinds.add('ui-item-mirror');
          } else if (!['token_count', 'agent_reasoning', 'agent_message', 'context_compacted', 'warning', 'agent_reasoning_raw_content', 'agent_reasoning_section_break'].includes(payload.type)) {
            evidence.unknownEvents = true; omittedKinds.add('unknown-event');
          }
        } else if (row.type === 'world_state') {
          invariant(payload && object(payload.state) && typeof payload.full === 'boolean', 'HISTORY_FORMAT');
          omittedKinds.add('runtime-instruction-projection');
        } else if (row.type === 'token_usage_record') {
          invariant(payload?.thread_id === nativeId && object(payload.usage), 'HISTORY_FORMAT'); omittedKinds.add('usage');
        } else if (row.type !== 'compacted') { evidence.unknownEvents = true; omittedKinds.add('unknown-record'); }
      };
      const parser = new JsonlProjection(receive), decoder = new TextDecoder('utf-8', { fatal: true }), deadline = Date.now() + 10000;
      let offset = 0;
      while (offset < startStat.size) {
        invariant(!signal?.aborted, 'HISTORY_ABORTED'); invariant(Date.now() < deadline, 'HISTORY_DEADLINE');
        const buffer = Buffer.alloc(Math.min(65536, startStat.size - offset));
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset); invariant(bytesRead > 0, 'HISTORY_CHANGED');
        let text: string; try { text = decoder.decode(buffer.subarray(0, bytesRead), { stream: true }); } catch { throw new BridgeError('HISTORY_FORMAT'); }
        if (offset === 0) text = text.replace(/^\uFEFF/, '');
        parser.push(text); offset += bytesRead;
      }
      try { parser.push(decoder.decode()); } catch (error) { if (error instanceof BridgeError) throw error; throw new BridgeError('HISTORY_FORMAT'); }
      evidence.incomplete = parser.end().incomplete;
      invariant(records > 0, 'HISTORY_HEADER');
      if (evidence.incomplete) evidence.activity = 'active';
      if (target.config.backend === 'pi') {
        const branch: Array<{ id: string; message?: HistoryMessage }> = [], seen = new Set<string>(); let current = piLeaf;
        while (current) {
          invariant(!seen.has(current) && piRows.has(current), 'HISTORY_BRANCH'); seen.add(current);
          const entry = piRows.get(current)!; branch.push({ id: current, message: entry.message }); current = entry.parentId ?? undefined;
        }
        for (const entry of branch.reverse()) if (entry.message) {
          const item = entry.message; message(item.role, item.text, { id: entry.id, timestamp: item.timestamp === null ? undefined : new Date(item.timestamp).toISOString() }, item.source, item.purpose);
        }
      }
      const endStat = await handle.stat();
      invariant(startStat.dev === endStat.dev && startStat.ino === endStat.ino && startStat.size === endStat.size && startStat.mtimeMs === endStat.mtimeMs &&
        historyRevision(candidate.file) === candidate.sourceRevision, 'HISTORY_CHANGED');
      if (!evidence.turnOrderValid) omittedKinds.add('unverified-turn-order');
      evidence.page.omittedKinds = [...omittedKinds];
      if (order === 'newest-first') {
        evidence.page.messages.reverse();
        nextPosition = recentPositions[0] && recentPositions[0] > 0 ? recentPositions[0] : undefined;
      }
      if (nextPosition !== undefined) evidence.page.nextCursor = Buffer.from(JSON.stringify({ n: nativeId, r: candidate.sourceRevision, p: nextPosition, ...(order === 'newest-first' ? { o: order } : {}) })).toString('base64url');
      return evidence;
    } finally { await handle.close(); }
  }
}
