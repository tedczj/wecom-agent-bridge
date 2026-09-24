import type { Store } from '../../src/store.ts';
import type { RecapAttempt } from '../../src/answers/recap.ts';
import type { RecapCallAudit } from '../../src/answers/codex-recap.ts';
import type { ControllerPolicyWireAudit, ControllerPromptAudit } from '../../src/controllers/factory.ts';

/** Verify every admitted recap call against its actual restricted native turn and cleanup. */
export function recapExecutionEvidence(store: Store, requestId: string, recapId: string, answerId: string, sourceSha256: string) {
  const attempts = store.value<RecapAttempt[]>('recap-attempts:' + recapId) ?? [];
  const expected = attempts.flatMap(attempt => (attempt.modelCallIds ?? []).map(callId => ({ callId, ordinal: attempt.ordinal })));
  const all = store.db.prepare("SELECT value FROM routing_state WHERE key LIKE 'recap-call:%' AND json_extract(value,'$.recapId')=?").all(recapId);
  const injections = store.db.prepare("SELECT value FROM routing_state WHERE key LIKE 'live-recap-injection:%' AND json_extract(value,'$.recapId')=?").all(recapId);
  const calls = expected.map(({ callId, ordinal }) => {
    const call = store.value<RecapCallAudit>('recap-call:' + callId);
    const prompt = store.value<ControllerPromptAudit>('controller-wire:recap:' + callId);
    const policy = store.value<ControllerPolicyWireAudit>('controller-policy-wire:recap:' + callId);
    const returned = store.value<unknown[]>('controller-tool-wire:recap:' + callId) ?? [];
    const injection = store.value<Record<string, unknown>>('live-recap-injection:' + callId), attempt = attempts.find(row => row.ordinal === ordinal);
    if (injection) {
      const pass = !call && !prompt && !policy && returned.length === 0 && injection.callId === callId && injection.requestId === requestId &&
        injection.recapId === recapId && injection.answerId === answerId && injection.sourceSha256 === sourceSha256 && injection.attempt === ordinal &&
        injection.boundary === 'before-CodexRecapModel.summarize' && injection.nativeCalled === false && injection.failureCode === 'LIVE_RECAP_SERVICE_FAULT' &&
        ordinal === 1 && attempt?.state === 'failed' && attempt.failureCode === 'LIVE_RECAP_SERVICE_FAULT' && attempt.modelCallIds?.length === 1;
      return { callId, complete: pass, pass, injectedBeforeNative: true, injection };
    }
    const complete = !!call && !!prompt && !!policy && call.state === 'completed' && call.cleanupConfirmed;
    const pass = complete && call!.callId === callId && call!.recapId === recapId && call!.answerId === answerId && call!.requestId === requestId &&
      call!.sourceSha256 === sourceSha256 && call!.attempt === ordinal && call!.policyVerified === true && !!call!.resultSha256 &&
      prompt!.kind === 'prompt' && prompt!.role === 'recap' && prompt!.controllerId === callId && prompt!.requestId === callId &&
      prompt!.sourceRequestId === requestId && prompt!.threadId === call!.threadId && prompt!.textSha256 === call!.promptSha256 && prompt!.attachmentHashes.length === 0 &&
      policy!.valid && policy!.role === 'recap' && policy!.controllerId === callId && policy!.requestId === callId &&
      policy!.threadId === call!.threadId && policy!.turnId === call!.turnId && policy!.evidence?.threadId === call!.threadId &&
      policy!.evidence.turnId === call!.turnId && policy!.evidence.dynamicToolsOnly && policy!.evidence.nativeAutoCompaction === 'disabled' &&
      policy!.evidence.toolNames.length === 0 && returned.length === 0;
    return { callId, complete, pass, call, policy, prompt };
  });
  const complete = attempts.length > 0 && attempts.every((attempt, i) => attempt.ordinal === i + 1 && Array.isArray(attempt.modelCallIds) && attempt.state !== 'pending') &&
    expected.length > 0 && new Set(expected.map(row => row.callId)).size === expected.length && all.length + injections.length === expected.length && calls.every(call => call.complete);
  return { complete, pass: complete && calls.every(call => call.pass), attempts, calls };
}
