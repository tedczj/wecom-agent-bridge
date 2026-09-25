import type { Store } from '../store.ts';
import { invariant, errorCode, record } from '../errors.ts';
import { sha256 } from './requests.ts';
import type { ControllerSession } from './registry.ts';
import type { ControllerToolHandler } from '../controllers/runtime.ts';

export interface ToolAuditRecord {
  seq: number; role: 'bridge' | 'route'; controllerId: string; generation: number; tool: string; callId: string;
  argumentsSha256: string; resultSha256?: string; status: 'started' | 'returned' | 'denied'; code?: string;
  answerRef?: string; start?: number; limit?: number; bridgeEnvelopeChecked?: boolean;
  bridgeProjectionChecked?: boolean;
}
/** Audit only IDs, hashes and bounded range metadata; never persist tool bodies in ordinary logs. */
export function auditTools(store: Store, requestId: string, actor: ControllerSession, maxShortChars: number, handler: ControllerToolHandler, maxCalls = 256): ControllerToolHandler {
  return async (name, args, callId) => {
    const key = 'tool-audit:' + requestId;
    const entries = store.value<ToolAuditRecord[]>(key) ?? [];
    invariant(entries.length < 256, 'TOOL_AUDIT_LIMIT');
    invariant(entries.length < maxCalls, 'CONTROLLER_DECISION_LIMIT');
    const audit: ToolAuditRecord = { seq: entries.length + 1, role: actor.role, controllerId: actor.controller_id, generation: actor.generation,
      tool: name, callId, argumentsSha256: sha256(JSON.stringify(args)), status: 'started' };
    if (name === 'read_answer_range' || name === 'read_answer_outline') {
      if (typeof args.answerRef === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(args.answerRef)) audit.answerRef = args.answerRef;
      if (typeof args.start === 'number' && Number.isSafeInteger(args.start) && args.start >= 0) audit.start = args.start;
      if (typeof args.limit === 'number' && Number.isSafeInteger(args.limit) && args.limit >= 4 && args.limit <= 16384) audit.limit = args.limit;
    }
    store.put(key, [...entries, audit]);
    try {
      const result = await handler(name, args, callId);
      if (actor.role === 'bridge' && name === 'route_delegate') {
        const envelope = record(result);
        invariant(Object.keys(envelope).every(key => ['requestId', 'status', 'businessSessionKey', 'answerRef', 'shortText', 'recapState'].includes(key)) &&
          typeof envelope.shortText === 'string' && Array.from(envelope.shortText).length <= maxShortChars, 'BRIDGE_RESULT_PROJECTION');
        audit.bridgeEnvelopeChecked = true;
      }
      if (actor.role === 'bridge' && ['list_interactions', 'search_interactions'].includes(name)) {
        invariant(Array.isArray(result) && result.length <= 30 && result.every(value => {
          const row = record(value);
          return Object.keys(row).every(key => ['requestId', 'ingressSeq', 'query', 'kind', 'status', 'answerRef', 'shortText', 'recapState', 'directoryIdentity', 'businessSessionKey', 'producerRole'].includes(key)) &&
            typeof row.shortText === 'string' && Array.from(row.shortText).length <= maxShortChars;
        }), 'BRIDGE_HISTORY_PROJECTION');
        audit.bridgeProjectionChecked = true;
      }
      audit.resultSha256 = sha256(JSON.stringify(result)); audit.status = 'returned'; return result;
    } catch (error) { audit.status = 'denied'; audit.code = errorCode(error); throw error; }
    finally {
      const current = store.value<ToolAuditRecord[]>(key)!;
      current[audit.seq - 1] = audit;
      store.put(key, current);
    }
  };
}
