import type { Store } from '../../src/store.ts';
import type { ToolAuditRecord } from '../../src/orchestration/audit.ts';
import type { ControllerToolResultAudit, ControllerPolicyWireAudit } from '../../src/controllers/factory.ts';
import { verifiedRecoveredClosure, type RecoveredControllerClosure } from './recovered-closure.ts';

/** Check the actual serialized Bridge tool results against host projections and a completed restricted turn. */
export function bridgeDisclosure(store: Store, requestIds: string[], recovered: readonly RecoveredControllerClosure[] = []): { complete: boolean; pass: boolean; actual: unknown } {
  const allowed = new Set(['search_interactions', 'list_interactions', 'list_directories', 'search_directories', 'remember_alias', 'propose_directory', 'clarify_directory', 'route_delegate']);
  const rows = requestIds.map(requestId => {
    const turn = store.value<{ controllerId: string; threadId: string; turnId: string; policyVerified: boolean }>('controller-turn:bridge:' + requestId);
    const policy = store.value<ControllerPolicyWireAudit>('controller-policy-wire:bridge:' + requestId);
    const closure = recovered.find(row => verifiedRecoveredClosure(row) && row.requestId === requestId && row.controllerId === policy?.controllerId && row.threadId === policy?.threadId);
    const ended = store.value<{ controllerId: string; threadId: string; cleanupConfirmed: boolean; outcome: string }>('controller-ended:bridge:' + requestId);
    const phase = policy && (ended || closure) ? store.db.prepare('SELECT phase FROM orchestration_requests WHERE request_id=?').get(requestId)?.phase : undefined;
    const aborted = !!policy && policy.valid && (phase === 'interrupted' && !!closure || !!ended && ended.cleanupConfirmed && ended.outcome === 'failed' &&
      ['cancelled', 'interrupted', 'failed'].includes(String(phase)) && ended.controllerId === policy.controllerId && ended.threadId === policy.threadId);
    const identity = turn ?? (aborted ? { ...policy, policyVerified: true } : undefined);
    const policyMatches = !policy ? !!turn : policy.valid && policy.requestId === requestId && policy.role === 'bridge' &&
      policy.threadId === identity?.threadId && policy.turnId === identity?.turnId && policy.controllerId === identity?.controllerId &&
      policy.evidence?.threadId === policy.threadId && policy.evidence.turnId === policy.turnId && policy.evidence.dynamicToolsOnly === true &&
      policy.evidence.nativeAutoCompaction === 'disabled' && policy.evidence.toolNames.every(tool => allowed.has(tool));
    const audit = (store.value<ToolAuditRecord[]>('tool-audit:' + requestId) ?? []).filter(row => row.role === 'bridge');
    const recordedWire = store.value<ControllerToolResultAudit[]>('controller-tool-wire:bridge:' + requestId);
    const returned = audit.filter(row => row.status === 'returned');
    const noTools = !!turn && !!policy && policyMatches && audit.length === 0 && (!recordedWire || recordedWire.length === 0);
    const wire = recordedWire ?? ((aborted || noTools) && returned.length === 0 ? [] : undefined);
    const complete = !!identity && !!wire && (audit.length > 0 || noTools);
    const abandoned = audit.filter(row => row.status === 'started' && aborted && !!closure && row.resultSha256 === undefined && !wire?.some(sent => sent.callId === row.callId));
    const pass = complete && identity!.policyVerified && policyMatches && audit.every(row => (row.status !== 'started' || abandoned.includes(row)) && row.controllerId === identity!.controllerId && allowed.has(row.tool)) &&
      returned.length === wire!.length && new Set(wire!.map(row => row.callId)).size === wire!.length &&
      returned.every(row => allowed.has(row.tool) && (row.tool !== 'route_delegate' || row.bridgeEnvelopeChecked === true) &&
        (!['list_interactions', 'search_interactions'].includes(row.tool) || row.bridgeProjectionChecked === true) && wire!.some(sent =>
          sent.controllerId === row.controllerId && sent.controllerId === identity!.controllerId && sent.threadId === identity!.threadId &&
          sent.turnId === identity!.turnId && sent.callId === row.callId && sent.tool === row.tool && sent.resultSha256 === row.resultSha256));
    return { requestId, complete, pass, turn, policy, ended, closure, phase, abandonedCallIds: abandoned.map(row => row.callId),
      results: wire?.map(row => ({ tool: row.tool, callId: row.callId, resultSha256: row.resultSha256 })) };
  });
  return { complete: rows.length > 0 && rows.every(row => row.complete), pass: rows.length > 0 && rows.every(row => row.pass), actual: rows };
}
