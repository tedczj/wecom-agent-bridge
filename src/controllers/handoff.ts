import type { Store } from '../store.ts';
import { invariant, record } from '../errors.ts';
import { listInteractions } from '../answers/projection.ts';
import { sha256 } from '../orchestration/requests.ts';

export interface ConversationState {
  activeWorkspace?: string;
  queryFocus?: { directoryRef: string; sessionKey?: string; requestId?: string; sessionRef?: string };
  pendingSelection?: { sourceRequestId: string; expiresAt: number; optionRefs: string[] };
  aliases?: Record<string, string>;
}
export interface ControllerHandoff {
  version: 1;
  l0: { conversationScope: string; directoryIdentity: string | null; conversation: ConversationState;
    bindings: Array<{ directoryIdentity: string; sessionKey: string; profileDigest: string; version: number }>;
    pendingRequests: Array<{ requestId: string; phase: string; jobTaskId: string | null }>;
    blocked: boolean };
  narrative: { sourceRequestIds: string[]; records: Array<{ requestId: string; queryExcerpt: string; querySha256: string; shortText: string; status: string }> };
  sha256: string;
}

export function readConversationState(store: Store, scope: string): ConversationState {
  const value = store.value<unknown>('orchestration:conversation:' + scope);
  if (value === undefined) return {};
  const state = record(value);
  invariant(Object.keys(state).every(k => ['activeWorkspace', 'queryFocus', 'pendingSelection', 'aliases'].includes(k)), 'CONVERSATION_STATE');
  invariant(state.activeWorkspace === undefined || typeof state.activeWorkspace === 'string', 'CONVERSATION_STATE');
  if (state.queryFocus !== undefined) {
    const focus = record(state.queryFocus);
    invariant(Object.keys(focus).every(k => ['directoryRef', 'sessionKey', 'requestId', 'sessionRef'].includes(k)) && typeof focus.directoryRef === 'string' &&
      [focus.sessionKey, focus.requestId, focus.sessionRef].every(v => v === undefined || typeof v === 'string'), 'CONVERSATION_STATE');
  }
  if (state.pendingSelection !== undefined) {
    const pending = record(state.pendingSelection);
    invariant(Object.keys(pending).every(k => ['sourceRequestId', 'expiresAt', 'optionRefs'].includes(k)) && typeof pending.sourceRequestId === 'string' &&
      Number.isSafeInteger(pending.expiresAt) && Array.isArray(pending.optionRefs) && pending.optionRefs.every(v => typeof v === 'string'), 'CONVERSATION_STATE');
  }
  if (state.aliases !== undefined) invariant(Object.values(record(state.aliases)).every(v => typeof v === 'string'), 'CONVERSATION_STATE');
  return state as ConversationState;
}

/** Build from program state and safe projections; no native transcript or raw answer is queried. */
export function buildHandoff(store: Store, scope: string, directoryIdentity: string | null): ControllerHandoff {
  const bindings = store.db.prepare(`SELECT directory_identity,session_key,profile_digest,version FROM business_bindings
    WHERE conversation_scope=? ORDER BY directory_identity,backend_home_key,profile_digest LIMIT 1001`).all(scope) as Array<Record<string, unknown>>;
  invariant(bindings.length <= 1000, 'HANDOFF_OVERSIZED');
  const pending = store.db.prepare(`SELECT request_id,phase,job_task_id FROM orchestration_requests WHERE conversation_scope=?
    AND phase NOT IN ('completed','failed','cancelled','interrupted') ORDER BY ingress_seq LIMIT 1001`).all(scope) as Array<Record<string, unknown>>;
  invariant(pending.length <= 1000, 'HANDOFF_OVERSIZED');
  const interactions = listInteractions(store, scope, { directoryIdentity: directoryIdentity ?? undefined, limit: 6 });
  const value = {
    version: 1 as const,
    l0: { conversationScope: scope, directoryIdentity, conversation: readConversationState(store, scope),
      bindings: bindings.map(row => ({ directoryIdentity: row.directory_identity as string, sessionKey: row.session_key as string,
        profileDigest: row.profile_digest as string, version: row.version as number })),
      pendingRequests: pending.map(row => ({ requestId: row.request_id as string, phase: row.phase as string, jobTaskId: row.job_task_id as string | null })),
      blocked: store.blocked() },
    narrative: { sourceRequestIds: interactions.map(row => row.requestId), records: interactions.map(row => ({ requestId: row.requestId,
      queryExcerpt: Array.from(row.query).slice(0, 2000).join(''), querySha256: sha256(row.query), shortText: row.shortText, status: row.status })) },
  };
  const serialized = JSON.stringify(value);
  invariant(Buffer.byteLength(serialized) <= 65536, 'HANDOFF_OVERSIZED');
  return { ...value, sha256: sha256(serialized) };
}
