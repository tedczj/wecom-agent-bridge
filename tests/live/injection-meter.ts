import { RoleTools } from '../../src/orchestration/tools.ts';
import { errorCode, invariant } from '../../src/errors.ts';
import { sha256 } from '../../src/orchestration/requests.ts';

let installed = false;
/** Probe real host instances, then forward their actual model call unchanged. */
export function injectionMeter(marker: string, canary: string) {
  invariant(!installed, 'LIVE_METER_ALREADY_INSTALLED'); installed = true;
  const original = RoleTools.prototype.call, seen = new WeakSet<RoleTools>();
  const schemas: Array<{ role: string; tools: RoleTools['definitions'] }> = [];
  const denials: Array<{ role: string; tool: string; code: string }> = [];
  const returns: Array<{ role: string; tool: string; resultSha256: string; injectionSeen: boolean; canarySeen: boolean }> = [];
  let stopped = false;
  const observed: typeof original = async function (this: RoleTools, name, args, callId) {
    const role = this.definitions.some(tool => tool.name === 'route_delegate') ? 'bridge' : 'route';
    if (!seen.has(this)) {
      seen.add(this); schemas.push({ role, tools: structuredClone(this.definitions) });
      const probes: Array<[string, Record<string, unknown>]> = [['exec_command', { cmd: 'rejected-before-dispatch' }]];
      if (role === 'bridge') probes.push(['read_answer_range', { answerRef: 'synthetic', start: 0 }],
        ['route_delegate', { directoryRef: 'synthetic', intentKind: 'work', query: 'forged' }],
        ['route_delegate', { directoryRef: 'synthetic', intentKind: 'work', context: 'forged' }]);
      for (const [tool, value] of probes) {
        let code = 'ACCEPTED';
        try { await original.call(this, tool, value, callId + '-injection-probe-' + denials.length); } catch (error) { code = errorCode(error); }
        denials.push({ role, tool, code });
        invariant(code === (tool === 'route_delegate' ? 'CONTROLLER_TOOL_ARGUMENTS' : 'CONTROLLER_TOOL_DENIED'), 'LIVE_INJECTION_PROBE_ACCEPTED');
      }
    }
    const result = await original.call(this, name, args, callId), text = JSON.stringify(result);
    returns.push({ role, tool: name, resultSha256: sha256(text), injectionSeen: text.includes(marker), canarySeen: text.includes(canary) });
    return result;
  };
  RoleTools.prototype.call = observed;
  return { snapshot: () => structuredClone({ schemas, denials, returns }), stop() {
    if (stopped) return; invariant(RoleTools.prototype.call === observed, 'LIVE_METER_RESTORE_CONFLICT');
    RoleTools.prototype.call = original; installed = false; stopped = true;
  } };
}
