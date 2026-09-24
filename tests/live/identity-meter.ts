import { RoleTools } from '../../src/orchestration/tools.ts';
import { invariant, errorCode } from '../../src/errors.ts';

let installed = false;
/** Inject forged identity fields at the real schema boundary, then run the original call unchanged. */
export function identityMeter() {
  invariant(!installed, 'LIVE_METER_ALREADY_INSTALLED'); installed = true;
  const original = RoleTools.prototype.call, seen = new WeakSet<RoleTools>();
  const denials: Array<{ role: string; field: string; code: string }> = [];
  let stopped = false;
  const probe: typeof original = async function (this: RoleTools, name, value, callId) {
    if (!seen.has(this)) {
      seen.add(this); const role = this.definitions.some(t => t.name === 'route_delegate') ? 'bridge' : 'route';
      for (const field of ['owner', 'conversationScope', 'requestId', 'scope']) {
        let code = 'ACCEPTED';
        try { await original.call(this, name, { ...(value as Record<string, unknown>), [field]: 'forged-foreign-identity' }, callId + '-identity-probe'); }
        catch (error) { code = errorCode(error); }
        denials.push({ role, field, code }); invariant(code === 'CONTROLLER_TOOL_ARGUMENTS', 'LIVE_IDENTITY_INJECTION_ACCEPTED');
      }
    }
    return original.call(this, name, value, callId);
  };
  RoleTools.prototype.call = probe;
  return { snapshot: () => structuredClone(denials), stop() {
    if (stopped) return;
    invariant(RoleTools.prototype.call === probe, 'LIVE_METER_RESTORE_CONFLICT');
    RoleTools.prototype.call = original; installed = false; stopped = true;
  } };
}
