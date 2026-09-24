import { CodexBackend } from '../../src/codex.ts';
import { RecapService, type AnswerRecap } from '../../src/answers/recap.ts';
import { CodexRecapModel } from '../../src/answers/codex-recap.ts';
import type { Store } from '../../src/store.ts';
import { invariant, BridgeError } from '../../src/errors.ts';

let installed = false;
/** The first model service call fails; the explicit retry uses the original service and real model. */
export function recapFaultMeter(store: Store) {
  invariant(!installed, 'LIVE_METER_ALREADY_INSTALLED'); installed = true;
  const businessRun = CodexBackend.prototype.run, recapRun = RecapService.prototype.run, summarize = CodexRecapModel.prototype.summarize;
  let businessCalls = 0, recapAttempts = 0, realRecapCalls = 0, injected = false, stopped = false;
  let target: { service: RecapService; answerId: string; scope: string } | undefined;
  const countedBusiness: typeof businessRun = function (this: CodexBackend, ...args) { businessCalls++; return businessRun.apply(this, args); };
  const captured: typeof recapRun = function (this: RecapService, ...args) {
    if (!target && store.db.prepare('SELECT producer_role FROM answer_artifacts WHERE answer_id=?').get(args[0])?.producer_role === 'business')
      target = { service: this, answerId: args[0], scope: args[1] };
    return recapRun.apply(this, args);
  };
  const fault: typeof summarize = function (this: CodexRecapModel, ...args) {
    recapAttempts++;
    if (target && !injected) {
      invariant(args[0].audit && args[0].audit.answerId === target.answerId, 'LIVE_RECAP_INJECTION_IDENTITY');
      store.put('live-recap-injection:' + args[0].audit.callId, { ...args[0].audit, stage: args[0].stage,
        boundary: 'before-CodexRecapModel.summarize', nativeCalled: false, failureCode: 'LIVE_RECAP_SERVICE_FAULT' });
      injected = true; return Promise.reject(new BridgeError('LIVE_RECAP_SERVICE_FAULT'));
    }
    realRecapCalls++; return summarize.apply(this, args);
  };
  CodexBackend.prototype.run = countedBusiness; RecapService.prototype.run = captured; CodexRecapModel.prototype.summarize = fault;
  return { snapshot: () => ({ businessCalls, recapAttempts, realRecapCalls, injected, answerId: target?.answerId }),
    async retry(signal?: AbortSignal): Promise<AnswerRecap> { invariant(!stopped && target && injected, 'LIVE_RECAP_RETRY_NOT_READY'); return recapRun.call(target.service, target.answerId, target.scope, signal); },
    stop() {
      if (stopped) return;
      invariant(CodexBackend.prototype.run === countedBusiness && RecapService.prototype.run === captured && CodexRecapModel.prototype.summarize === fault, 'LIVE_METER_RESTORE_CONFLICT');
      CodexBackend.prototype.run = businessRun; RecapService.prototype.run = recapRun; CodexRecapModel.prototype.summarize = summarize;
      stopped = true; installed = false;
    } };
}
