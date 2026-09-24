import { ControllerManager } from '../../src/controllers/manager.ts';
import { CodexBackend } from '../../src/codex.ts';
import { RoleTools } from '../../src/orchestration/tools.ts';
import { sha256 } from '../../src/orchestration/requests.ts';
import { invariant } from '../../src/errors.ts';

let installed = false;
/** Test-runner injection: duplicate one real host handler call; all model/runtime/backend methods still execute normally. */
export function duplicateMeter() {
  invariant(!installed, 'LIVE_METER_ALREADY_INSTALLED'); installed = true;
  const managerRun = ControllerManager.prototype.run, businessRun = CodexBackend.prototype.run, toolCall = RoleTools.prototype.call;
  const calls: Array<{ role: string; requestId?: string; textSha256: string }> = [];
  const replay: Array<{ requestId: unknown; businessSessionKey: unknown; resultSha256: string }> = [];
  let businessSubmits = 0, injected = false, stopped = false;
  const countedManager: typeof managerRun = function (this: ControllerManager, ...args) {
    calls.push({ role: args[0].role, requestId: args[0].requestId, textSha256: sha256(args[1]) });
    return managerRun.apply(this, args);
  };
  const countedBusiness: typeof businessRun = function (this: CodexBackend, ...args) { businessSubmits++; return businessRun.apply(this, args); };
  const duplicate: typeof toolCall = async function (this: RoleTools, name, args, callId) {
    if (name !== 'business_execute' || injected) return toolCall.call(this, name, args, callId);
    injected = true;
    const results = await Promise.all([toolCall.call(this, name, args, callId), toolCall.call(this, name, args, callId + '-duplicate')]);
    for (const value of results) {
      const result = value as { requestId?: unknown; businessSessionKey?: unknown };
      replay.push({ requestId: result?.requestId, businessSessionKey: result?.businessSessionKey, resultSha256: sha256(JSON.stringify(value)) });
    }
    return results[0];
  };
  ControllerManager.prototype.run = countedManager; CodexBackend.prototype.run = countedBusiness; RoleTools.prototype.call = duplicate;
  return {
    snapshot: () => structuredClone({ calls, businessSubmits, injected, replay }),
    stop() {
      if (stopped) return;
      invariant(ControllerManager.prototype.run === countedManager && CodexBackend.prototype.run === countedBusiness && RoleTools.prototype.call === duplicate, 'LIVE_METER_RESTORE_CONFLICT');
      ControllerManager.prototype.run = managerRun; CodexBackend.prototype.run = businessRun; RoleTools.prototype.call = toolCall;
      stopped = true; installed = false;
    },
  };
}
