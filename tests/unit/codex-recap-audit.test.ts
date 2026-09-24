import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setup } from '../helpers.ts';
import { initializeHierarchy } from '../../src/orchestration/schema.ts';
import { CodexRecapModel, type RecapCallAudit } from '../../src/answers/codex-recap.ts';
import type { ControllerFactory } from '../../src/controllers/factory.ts';
import { sha256 } from '../../src/orchestration/requests.ts';

for (const variant of ['success', 'unverified-policy', 'cleanup-unknown'] as const) test(`OFFLINE recap call audit: ${variant}`, async t => {
  const f = setup(t), store = f.store(); initializeHierarchy(store);
  const callId = randomUUID(), requestId = randomUUID(), threadId = randomUUID(), captured: unknown[] = [];
  let closed = 0;
  const factory = { async create(role: string, id: string) {
    assert.equal(role, 'recap'); assert.equal(id, callId);
    return { async create(_generation: number, instructions: string, tools: unknown[]) {
      assert.match(instructions, /incidental random verification strings without copying/); assert.deepEqual(tools, []); return { threadId, generation: 0 };
    },
      async run(...args: unknown[]) { captured.push(args[1], args[5]); return { turnId: 'turn', text: '{"summary":"private answer"}', policyVerified: variant !== 'unverified-policy' }; },
      async close() { closed++; if (variant === 'cleanup-unknown') throw Error('cleanup unknown'); } };
  } } as unknown as ControllerFactory;
  const model = new CodexRecapModel(store, factory, { model: 'gpt-6-sol', reasoning: 'medium', contextWindowTokens: 1000000 }, 'home');
  const input = { query: 'private query', text: 'private raw', stage: 'map' as const, outcome: 'succeeded',
    audit: { callId, requestId, answerId: randomUUID(), recapId: randomUUID(), sourceSha256: sha256('private raw'), attempt: 2 } };
  if (variant === 'success') assert.deepEqual(await model.summarize(input), { summary: 'private answer' });
  else await assert.rejects(model.summarize(input), variant === 'unverified-policy' ? /RECAP_POLICY_UNVERIFIED/ : /cleanup unknown/);
  const audit = store.value<RecapCallAudit>('recap-call:' + callId)!;
  assert.equal(audit.cleanupConfirmed, variant !== 'cleanup-unknown'); assert.equal(closed, 1);
  assert.equal(audit.state, variant === 'unverified-policy' ? 'failed' : 'completed');
  assert.equal(audit.policyVerified, variant !== 'unverified-policy');
  assert.equal(audit.promptSha256, sha256(captured[0] as string));
  assert.deepEqual(captured[1], { requestId: callId, sourceRequestId: requestId });
  assert.equal((captured[0] as string).includes(callId), false);
  assert.equal(JSON.stringify(audit).includes('private'), false);
  await assert.rejects(model.summarize(input), /RECAP_CALL_ALREADY_STARTED/);
});
