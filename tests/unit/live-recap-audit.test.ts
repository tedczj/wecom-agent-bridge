import test from 'node:test';
import assert from 'node:assert/strict';
import { setup } from '../helpers.ts';
import { recapExecutionEvidence } from '../live/recap-audit.ts';

test('OFFLINE recap evidence requires every admitted call, source identity, policy, prompt and cleanup', t => {
  const store = setup(t).store(), callId = 'call', requestId = 'request', recapId = 'recap', answerId = 'answer', sourceSha256 = 'source';
  const attempts = [{ ordinal: 1, startedAt: 1, state: 'ready', modelCallIds: [callId] }];
  const call = { callId, requestId, recapId, answerId, sourceSha256, attempt: 1, stage: 'map', promptSha256: 'prompt',
    state: 'completed', cleanupConfirmed: true, policyVerified: true, resultSha256: 'result', threadId: 'thread', turnId: 'turn' };
  const prompt = { kind: 'prompt', role: 'recap', controllerId: callId, requestId: callId, sourceRequestId: requestId, threadId: 'thread', textSha256: 'prompt', attachmentHashes: [] };
  const policy = { kind: 'policy', role: 'recap', controllerId: callId, requestId: callId, threadId: 'thread', turnId: 'turn', valid: true,
    evidence: { threadId: 'thread', turnId: 'turn', dynamicToolsOnly: true, nativeAutoCompaction: 'disabled', toolNames: [] } };
  store.put('recap-attempts:' + recapId, attempts); store.put('recap-call:' + callId, call);
  store.put('controller-wire:recap:' + callId, prompt); store.put('controller-policy-wire:recap:' + callId, policy);
  const check = () => recapExecutionEvidence(store, requestId, recapId, answerId, sourceSha256);
  assert.equal(check().pass, true);
  for (const change of [{ sourceSha256: 'foreign' }, { requestId: 'foreign' }, { cleanupConfirmed: false }, { policyVerified: false }, { turnId: 'old' }]) {
    store.put('recap-call:' + callId, { ...call, ...change }); assert.equal(check().pass, false);
  }
  store.put('recap-call:' + callId, call);
  store.put('controller-policy-wire:recap:' + callId, { ...policy, valid: false }); assert.equal(check().pass, false);
  store.put('controller-policy-wire:recap:' + callId, policy);
  store.put('recap-attempts:' + recapId, [{ ...attempts[0], modelCallIds: [callId, 'missing'] }]); assert.equal(check().complete, false);
  store.put('recap-attempts:' + recapId, [{ ordinal: 1, state: 'ready' }]); assert.equal(check().complete, false);
  store.put('recap-attempts:' + recapId, attempts); store.put('recap-call:extra', { ...call, callId: 'extra' }); assert.equal(check().complete, false);
});

test('OFFLINE recap injection proof distinguishes skipped native calls from real runtime completion', t => {
  const store = setup(t).store(), callId = 'skipped', requestId = 'request', recapId = 'recap', answerId = 'answer', sourceSha256 = 'source';
  store.put('recap-attempts:' + recapId, [{ ordinal: 1, state: 'failed', failureCode: 'LIVE_RECAP_SERVICE_FAULT', modelCallIds: [callId] }]);
  const proof = { callId, requestId, recapId, answerId, sourceSha256, attempt: 1, boundary: 'before-CodexRecapModel.summarize', nativeCalled: false, failureCode: 'LIVE_RECAP_SERVICE_FAULT' };
  const check = () => recapExecutionEvidence(store, requestId, recapId, answerId, sourceSha256);
  assert.equal(check().complete, false);
  store.put('live-recap-injection:' + callId, proof); assert.equal(check().pass, true); assert.equal(check().calls[0]!.injectedBeforeNative, true);
  for (const changed of [{ answerId: 'foreign' }, { nativeCalled: true }, { boundary: 'after-native' }, { attempt: 2 }]) {
    store.put('live-recap-injection:' + callId, { ...proof, ...changed }); assert.equal(check().pass, false);
  }
  store.put('live-recap-injection:' + callId, proof); store.put('controller-wire:recap:' + callId, { threadId: 'unexpected' }); assert.equal(check().pass, false);
});
