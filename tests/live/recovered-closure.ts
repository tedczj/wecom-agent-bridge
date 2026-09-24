import { readdirSync, realpathSync } from 'node:fs';
import path from 'node:path';
import type { Store } from '../../src/store.ts';
import type { ControllerPolicyWireAudit } from '../../src/controllers/factory.ts';
import { readControlled, processAlive } from '../../src/fsutil.ts';
import { invariant, record } from '../../src/errors.ts';
import { sha256 } from '../../src/orchestration/requests.ts';

export interface RecoveredControllerClosure {
  requestId: string; controllerId: string; threadId: string; processId: number;
  markerSha256: string; boundarySha256: string; observedAt: number;
  basis: 'archived process marker and observed PID/group exit; no native turn completion claimed';
}
const verified = new WeakSet<object>();
export const verifiedRecoveredClosure = (value: RecoveredControllerClosure): boolean => verified.has(value);

/** Only for the actual SIGKILL fixture. Never infer closure from a completed job or a model's text. */
export async function recoveredControllerClosure(store: Store, workRoot: string, command: string, evidenceRoot: string, requestId: string): Promise<RecoveredControllerClosure> {
  const boundaryBytes = await readControlled(evidenceRoot, path.join(evidenceRoot, 'kill-boundary.json'), 16384);
  const boundary = record(JSON.parse(boundaryBytes.toString('utf8')));
  invariant(boundary.taskId === requestId && boundary.fault === 'actual SIGKILL of bridge host process only' &&
    Number.isSafeInteger(boundary.parentPid) && Number(boundary.parentPid) > 0 && !processAlive(Number(boundary.parentPid)) &&
    Array.isArray(boundary.nativeGroups) && boundary.nativeGroups.every(pid => Number.isSafeInteger(pid) && pid > 0), 'LIVE_CLOSURE_BOUNDARY');
  const policy = store.value<ControllerPolicyWireAudit>('controller-policy-wire:bridge:' + requestId);
  invariant(policy?.valid && policy.requestId === requestId && policy.role === 'bridge' && /^[0-9a-f-]{36}$/.test(policy.controllerId), 'LIVE_CLOSURE_POLICY');
  const request = store.db.prepare('SELECT phase,conversation_scope FROM orchestration_requests WHERE request_id=?').get(requestId);
  const actor = store.db.prepare('SELECT role,state,conversation_scope,native_ref_json FROM controller_sessions WHERE controller_id=?').get(policy.controllerId);
  invariant(request?.phase === 'interrupted' && actor?.role === 'bridge' && ['failed', 'retired'].includes(String(actor.state)) &&
    actor.conversation_scope === request.conversation_scope && typeof actor.native_ref_json === 'string' && JSON.parse(actor.native_ref_json).threadId === policy.threadId, 'LIVE_CLOSURE_OWNER');
  const directory = path.join(workRoot, 'bridge', policy.controllerId);
  const names = readdirSync(directory).filter(name => /^process\.json\.stopped-[0-9a-f-]{36}$/.test(name));
  invariant(names.length === 1, 'LIVE_CLOSURE_AMBIGUOUS');
  const bytes = await readControlled(workRoot, path.join(directory, names[0]!), 16384), marker = record(JSON.parse(bytes.toString('utf8')));
  invariant(marker.controllerId === policy.controllerId && marker.role === 'bridge' && marker.binary === realpathSync(command) &&
    typeof marker.token === 'string' && names[0] === 'process.json.stopped-' + marker.token && Number.isSafeInteger(marker.pid) &&
    Number(marker.pid) > 0 && boundary.nativeGroups.includes(marker.pid) &&
    !processAlive(Number(marker.pid)) && !processAlive(-Number(marker.pid)), 'LIVE_CLOSURE_PROCESS');
  const proof: RecoveredControllerClosure = Object.freeze({ requestId, controllerId: policy.controllerId, threadId: policy.threadId,
    processId: Number(marker.pid), markerSha256: sha256(bytes), boundarySha256: sha256(boundaryBytes), observedAt: Date.now(),
    basis: 'archived process marker and observed PID/group exit; no native turn completion claimed' });
  verified.add(proof); return proof;
}
