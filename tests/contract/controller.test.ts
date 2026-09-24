import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { writeFileSync } from 'node:fs';
import { setup } from '../helpers.ts';
import { createHash } from 'node:crypto';
import { CodexAppServer, type AppServerOptions } from '../../src/controllers/codex-app-server.ts';
import type { ControllerTool } from '../../src/controllers/runtime.ts';
import { BridgeError } from '../../src/errors.ts';

const tool: ControllerTool = { name: 'probe_read', description: 'Offline read', inputSchema: { type: 'object', properties: {}, additionalProperties: false } };
function runtime(f: ReturnType<typeof setup>, mode = 'normal', instructionSource?: string, requireRestrictedPolicy = false, toolResultAudit?: AppServerOptions['toolResultAudit'], policyAudit?: AppServerOptions['policyAudit']) {
  const r = new CodexAppServer({ command: path.resolve('tests/fakes/controller.mjs'), cwd: f.workspace,
    env: { PATH: process.env.PATH, CODEX_HOME: f.c.codex.home, CONTROLLER_FAKE_MODE: mode, CONTROLLER_FAKE_INSTRUCTION_SOURCE: instructionSource }, model: 'gpt-6-sol', reasoning: 'medium',
    contextWindowTokens: 1000000, timeoutMs: 1000, turnTimeoutMs: 500, killGraceMs: 100, maxFrameBytes: 65536, requireRestrictedPolicy, toolResultAudit, policyAudit });
  f.cleanups.push(() => r.close()); return r;
}
test('OFFLINE ControllerRuntime: persistent identity, completed last usage and raw final whitespace', async t => {
  const f = setup(t), r = runtime(f), ref = await r.create(0, 'static', [tool]);
  const first = await r.run(ref, '  original\r\n', async () => ({}));
  assert.equal(first.text, '  final\r\n'); assert.equal(first.usage?.usedTokens, 71);
  assert.equal(r.getUsage(ref)?.basis, 'last-completed-request-total');
  await r.resume(ref, 'static', [tool], first.turnId);
  const second = await r.run(ref, 'continue', async () => ({}));
  assert.notEqual(second.turnId, first.turnId);
  assert.equal(r.getUsage({ ...ref, generation: 1 }), undefined);
  await assert.rejects(r.resume(ref, 'static', [tool], first.turnId), /CONTROLLER_RESUME_TURN_MISMATCH/);
});
test('OFFLINE ControllerRuntime: only allowlisted tool callbacks reach the host', async t => {
  const f = setup(t), r = runtime(f, 'tool'), ref = await r.create(0, 'static', [tool]); let calls = 0;
  await r.run(ref, 'read', async (name, args, id) => { calls++; assert.equal(name, 'probe_read'); assert.equal(id, 'call'); assert.deepEqual(args, {}); return { ok: true }; });
  assert.equal(calls, 1);
  const denied = runtime(f, 'unexpected-tool'), other = await denied.create(0, 'static', [tool]);
  await denied.run(other, 'read', async () => { throw new Error('Must not approve'); });
});
test('OFFLINE ControllerRuntime: missing usage stays unknown and a mismatched window fails', async t => {
  const f = setup(t), missing = runtime(f, 'no-usage'), ref = await missing.create(0, 'static', [tool]);
  assert.equal((await missing.run(ref, 'read', async () => ({}))).usage, undefined);
  const wrong = runtime(f, 'wrong-window'), other = await wrong.create(0, 'static', [tool]);
  await assert.rejects(wrong.run(other, 'read', async () => ({})), /CONTEXT_WINDOW_MISMATCH/);
});
test('OFFLINE ControllerRuntime: inherited instructions fail before prompt submission', async t => {
  const f = setup(t), r = runtime(f, 'global-instructions');
  await assert.rejects(r.create(0, 'static', []), /CONTROLLER_INSTRUCTIONS_UNCONTROLLED/);
});
test('OFFLINE ControllerRuntime: only the declared login home personal instruction files are allowed', async t => {
  const f = setup(t), personal = path.join(f.c.codex.home, 'AGENTS.md'); writeFileSync(personal, 'Personal style instruction');
  const r = runtime(f, 'global-instructions', personal); await r.create(0, 'static management role', []);
  const project = path.join(f.workspace, 'AGENTS.md'); writeFileSync(project, 'Untrusted project instruction');
  await assert.rejects(runtime(f, 'global-instructions', project).create(0, 'static management role', []), /CONTROLLER_INSTRUCTIONS_UNCONTROLLED/);
});
test('OFFLINE ControllerRuntime: timeout interrupts and closes, with no resubmission', async t => {
  const f = setup(t), r = runtime(f, 'hang'), ref = await r.create(0, 'static', []);
  await assert.rejects(r.run(ref, 'read', async () => ({})), /CONTROLLER_TURN_TIMEOUT/);
  await assert.rejects(r.run(ref, 'second', async () => ({})), /CONTROLLER_CLOSED/);
});
test('OFFLINE ControllerRuntime: restricted policy must precede tool handling and match the current turn inventory', async t => {
  const f = setup(t), good = runtime(f, 'policy-tool', undefined, true), ref = await good.create(0, 'static', [tool]);
  let calls = 0; await good.run(ref, 'read', async () => { calls++; return {}; });
  assert.equal(calls, 1); assert.equal(good.policyObservations.length, 1); assert.deepEqual(good.policyObservations[0]!.toolNames, ['probe_read']);
  for (const mode of ['tool', 'policy-extra', 'policy-stale', 'policy-conflict']) {
    const denied = runtime(f, mode, undefined, true), next = await denied.create(0, 'static', [tool]);
    await assert.rejects(denied.run(next, 'read', async () => { calls++; return {}; }), /CONTROLLER_POLICY_(?:MISSING|INVALID)/);
  }
  assert.equal(calls, 1);
});
test('OFFLINE ControllerRuntime: prior-turn policy evidence cannot authorize the next turn', async t => {
  const f = setup(t), r = runtime(f, 'policy-first-only', undefined, true), ref = await r.create(0, 'static', [tool]);
  await r.run(ref, 'first', async () => ({}));
  await assert.rejects(r.run(ref, 'second', async () => ({})), /CONTROLLER_POLICY_MISSING/);
});
test('OFFLINE ControllerRuntime: empty management final requires a completed host delegation for the same request', async t => {
  const f = setup(t), delegated = { ...tool, name: 'business_execute' }, identity = { requestId: 'request', sourceRequestId: 'request' };
  const r = runtime(f, 'empty-delegation'), ref = await r.create(0, 'static', [delegated]);
  const result = await r.run(ref, 'work', async () => ({ requestId: 'request', status: 'completed', answerRef: 'answer', shortText: 'done' }), undefined, [], identity);
  assert.equal(result.text, ''); assert.ok(result.usage);
  // The same native management session remains usable; no new generation is needed.
  const next = await r.run(ref, 'next', async () => ({ requestId: 'next', status: 'failed', shortText: 'failed' }), undefined, [], { requestId: 'next', sourceRequestId: 'next' });
  assert.notEqual(next.turnId, result.turnId);
  for (const envelope of [{}, { requestId: 'other', status: 'completed', answerRef: 'answer', shortText: 'done' },
    { requestId: 'request', status: 'awaiting_business', shortText: 'pending' }, { requestId: 'request', status: 'completed', shortText: 'no artifact' }]) {
    const denied = runtime(f, 'empty-delegation'), other = await denied.create(0, 'static', [delegated]);
    await assert.rejects(denied.run(other, 'work', async () => envelope, undefined, [], identity), /CONTROLLER_INCOMPLETE/);
  }
  const noTool = runtime(f, 'empty-final'), other = await noTool.create(0, 'static', []);
  await assert.rejects(noTool.run(other, 'read', async () => ({}), undefined, [], identity), /CONTROLLER_INCOMPLETE/);
});
test('OFFLINE ControllerRuntime: tool-response serialization records identity and hash without the body', async t => {
  const f = setup(t), seen: Parameters<NonNullable<AppServerOptions['toolResultAudit']>>[0][] = [];
  const r = runtime(f, 'tool', undefined, false, event => seen.push(event)), ref = await r.create(0, 'static', [tool]);
  const body = { shortText: 'PRIVATE TOOL BODY\r\n', answerRef: 'answer' };
  const result = await r.run(ref, 'read', async () => body, undefined, [], { requestId: 'request', sourceRequestId: 'source' });
  assert.deepEqual(seen, [{ threadId: ref.threadId, turnId: result.turnId, requestId: 'request', callId: 'call', tool: 'probe_read',
    resultSha256: createHash('sha256').update(JSON.stringify(body)).digest('hex') }]);
  assert.equal(JSON.stringify(seen).includes('PRIVATE TOOL BODY'), false);
});
test('OFFLINE ControllerRuntime: policy audit binds the request before callbacks and invalidates a conflicting diagnostic', async t => {
  const f = setup(t), events: Parameters<NonNullable<AppServerOptions['policyAudit']>>[0][] = [];
  const r = runtime(f, 'policy-tool', undefined, true, undefined, event => events.push(event)), ref = await r.create(0, 'static', [tool]);
  await r.run(ref, 'PRIVATE QUERY', async () => { assert.equal(events[0]!.valid, true); return {}; }, undefined, [], { requestId: 'request', sourceRequestId: 'request' });
  assert.equal(events[0]!.requestId, 'request'); assert.equal(events[0]!.threadId, ref.threadId); assert.equal(JSON.stringify(events).includes('PRIVATE QUERY'), false);
  const badEvents: typeof events = [], bad = runtime(f, 'policy-conflict', undefined, true, undefined, event => badEvents.push(event));
  const other = await bad.create(0, 'static', [tool]);
  await assert.rejects(bad.run(other, 'bad', async () => { throw Error('must not run'); }, undefined, [], { requestId: 'bad', sourceRequestId: 'bad' }), /CONTROLLER_POLICY_INVALID/);
  assert.equal(badEvents[0]!.valid, true); assert.equal(badEvents.at(-1)!.valid, false); assert.equal(badEvents.at(-1)!.requestId, 'bad');
});
test('OFFLINE ControllerRuntime: model sees bounded argument error codes, never internal exception prose', async t => {
  const f = setup(t);
  for (const mode of ['tool-arguments-error', 'tool-private-error']) {
    const r = runtime(f, mode), ref = await r.create(0, 'static', [tool]);
    const result = await r.run(ref, 'read', async () => {
      if (mode === 'tool-arguments-error') throw new BridgeError('CONTROLLER_TOOL_ARGUMENTS');
      throw Error('FAKE_SECRET_MUST_NOT_LEAK');
    });
    assert.equal(result.text, '  final\r\n');
  }
});
