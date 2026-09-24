import test from 'node:test';
import assert from 'node:assert/strict';
import { statSync, writeFileSync, symlinkSync, unlinkSync, renameSync } from 'node:fs';
import path from 'node:path';
import { setup, fixture } from '../helpers.ts';
import { initializeHierarchy } from '../../src/orchestration/schema.ts';
import { RequestStore, conversationScope, sha256 } from '../../src/orchestration/requests.ts';
import { ArtifactStore } from '../../src/answers/artifact-store.ts';
import { normalize } from '../../src/local.ts';
import type { FinishEvidence } from '../../src/types.ts';
import { RecapService, validateRecap, utf8Windows, type RecapContent, type RecapAttempt } from '../../src/answers/recap.ts';
import { listInteractions } from '../../src/answers/projection.ts';
import { readAnswerRange, readAnswerOutline } from '../../src/answers/history-tools.ts';
import { recordFailureNotice } from '../../src/answers/failure-notice.ts';

const finish: FinishEvidence = { backend: 'codex', threadStarted: true, turnStarted: true, turnCompleted: true, exitCode: 0, cleanupConfirmed: true };
function answerFixture(f: ReturnType<typeof setup>, max = 16777216) {
  const store = f.store(); initializeHierarchy(store);
  const incoming = normalize(fixture(), f.c, 'local:codex'), scope = conversationScope(incoming.route);
  const requests = new RequestStore(store), request = requests.accept(incoming).request;
  requests.transition(request.request_id, scope, ['accepted'], 'bridge_planning');
  requests.transition(request.request_id, scope, ['bridge_planning'], 'route_planning');
  const { job } = store.reserve(incoming, 'agent'); requests.bindJob(request.request_id, scope, job.task_id);
  store.prepared(job.task_id, []); store.claim();
  const artifacts = new ArtifactStore(store, path.join(f.c.stateRoot, 'artifacts'), max);
  const artifact = artifacts.stage(request.request_id, 'business', job.task_id, job.session_key);
  return { store, artifacts, artifact, scope, job, request };
}
for (const status of ['failed', 'cancelled', 'interrupted'] as const) test(`OFFLINE failure notice: ${status} preserves job/clock/delivery and never publishes a business draft`, async t => {
  const a = answerFixture(setup(t)); a.artifacts.capture(a.artifact.answer_id, 'UNVERIFIED PRIVATE BUSINESS DRAFT');
  a.store.complete(a.job.task_id, status, 'backend status message', 'TEST_FAILURE');
  a.store.db.prepare('UPDATE orchestration_requests SET phase=?,failure_code=? WHERE request_id=?').run(status, 'TEST_FAILURE', a.request.request_id);
  const request = new RequestStore(a.store).get(a.request.request_id, a.scope), before = a.store.get(a.job.task_id);
  const deliveries = a.store.db.prepare('SELECT * FROM outbox').all(), session = a.store.session(a.job.session_key);
  const recaps = new RecapService(a.store, a.artifacts, { summarize: async () => { throw Error('model must not run'); } }, 'profile');
  await recordFailureNotice(a.store, a.artifacts, recaps, request);
  await recordFailureNotice(a.store, a.artifacts, recaps, request);
  assert.deepEqual(a.store.get(a.job.task_id), before); assert.deepEqual(a.store.session(a.job.session_key), session);
  assert.deepEqual(a.store.db.prepare('SELECT * FROM outbox').all(), deliveries);
  const projected = listInteractions(a.store, a.scope);
  assert.equal(projected.length, 1); assert.equal(projected[0]!.kind, 'failure'); assert.equal(projected[0]!.status, status);
  assert.equal(projected[0]!.recapState, 'ready'); assert.ok(projected[0]!.shortText.includes('TEST_FAILURE'));
  assert.equal(projected[0]!.shortText.includes('PRIVATE BUSINESS DRAFT'), false);
  assert.equal(a.artifacts.get(a.artifact.answer_id).state, 'failed'); assert.equal(a.artifacts.get(a.artifact.answer_id).kind, 'partial');
  const notice = a.artifacts.get(projected[0]!.answerRef!);
  assert.equal(notice.producer_role, 'system'); assert.equal(notice.job_task_id, null);
  await assert.rejects(a.artifacts.read(a.artifact.answer_id, { role: 'delivery', scope: a.scope }), /ANSWER_NOT_READY/);
});
test('OFFLINE failure notice: rename/SQL crash recovers the same system notice without another delivery', async t => {
  const a = answerFixture(setup(t)); a.store.complete(a.job.task_id, 'failed', 'failed');
  a.store.db.prepare("UPDATE orchestration_requests SET phase='failed' WHERE request_id=?").run(a.request.request_id);
  const notice = a.artifacts.stage(a.request.request_id, 'system', undefined, a.job.session_key);
  a.artifacts.capture(notice.answer_id, '失败通知');
  await assert.rejects(a.artifacts.publish(notice.answer_id, { backend: 'system', requestId: a.request.request_id, completed: true, phase: 'failed', outcome: 'failed' }, () => { throw Error('SQL gap'); }), /SQL gap/);
  const deliveries = a.store.db.prepare('SELECT * FROM outbox').all();
  const recaps = new RecapService(a.store, a.artifacts, { summarize: async () => { throw Error('model must not run'); } }, 'profile');
  await recordFailureNotice(a.store, a.artifacts, recaps, new RequestStore(a.store).get(a.request.request_id, a.scope));
  assert.equal(listInteractions(a.store, a.scope)[0]!.answerRef, notice.answer_id);
  assert.equal(a.artifacts.get(notice.answer_id).state, 'ready');
  assert.deepEqual(a.store.db.prepare('SELECT * FROM outbox').all(), deliveries);
});
test('OFFLINE M2: original final survives display clipping with hash, private mode and strict role scope', async t => {
  const f = setup(t), a = answerFixture(f), raw = '  原始 e\u0301\r\n' + '长答案'.repeat(400000) + '\n ';
  a.artifacts.capture(a.artifact.answer_id, raw);
  await assert.rejects(a.artifacts.read(a.artifact.answer_id, { role: 'delivery', scope: a.scope }), /ANSWER_NOT_READY/);
  const ready = await a.artifacts.publish(a.artifact.answer_id, finish, () => { a.store.complete(a.job.task_id, 'succeeded', raw); });
  assert.equal(ready.sha256, sha256(raw));
  assert.equal((await a.artifacts.read(ready.answer_id, { role: 'delivery', scope: a.scope })).toString('utf8'), raw);
  assert.notEqual(a.store.get(a.job.task_id).result_text, raw);
  const file = path.join(a.artifacts.root, ready.relative_path);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(statSync(path.dirname(file)).mode & 0o777, 0o700);
  await assert.rejects(a.artifacts.read(ready.answer_id, { role: 'bridge', scope: a.scope }), /ANSWER_RAW_ACCESS_DENIED/);
  await assert.rejects(a.artifacts.read(ready.answer_id, { role: 'route', scope: 'another' }), /ANSWER_RAW_ACCESS_DENIED/);
  await assert.rejects(a.artifacts.read(ready.answer_id, { role: 'recap', scope: a.scope, requestId: 'another' }), /ANSWER_RAW_ACCESS_DENIED/);
  assert.throws(() => a.artifacts.capture(ready.answer_id, 'replacement'), /ANSWER_IMMUTABLE/);
});
test('OFFLINE M2: rename/SQL crash gap repairs only with persisted completion evidence', async t => {
  const f = setup(t), a = answerFixture(f);
  a.artifacts.capture(a.artifact.answer_id, 'unaltered');
  await assert.rejects(a.artifacts.publish(a.artifact.answer_id, finish, () => { throw new Error('injected SQL failure'); }), /injected SQL failure/);
  assert.equal(a.store.get(a.job.task_id).status, 'running');
  assert.equal(a.artifacts.get(a.artifact.answer_id).state, 'staging');
  await assert.rejects(a.artifacts.read(a.artifact.answer_id, { role: 'delivery', scope: a.scope }), /ANSWER_NOT_READY/);
  const completionTime = JSON.parse(a.artifacts.get(a.artifact.answer_id).finish_evidence_json!).completedAt;
  await new Promise(resolve => setTimeout(resolve, 10));
  const ready = await a.artifacts.recover(a.artifact.answer_id, raw => { a.store.completeArtifact(a.job.task_id, a.artifact.answer_id, raw); });
  assert.equal(ready.state, 'ready');
  assert.equal(a.store.get(a.job.task_id).status, 'succeeded');
  assert.equal(a.store.session(a.job.session_key).last_response_at, completionTime);
  await assert.rejects(a.artifacts.recover(ready.answer_id, () => { throw new Error('must not execute twice'); }), /ANSWER_RECOVERY_UNVERIFIED/);
});
test('OFFLINE M2: capture without completion and cancelled job cannot become successful artifacts', async t => {
  const f = setup(t), a = answerFixture(f);
  a.artifacts.capture(a.artifact.answer_id, 'possibly partial');
  await assert.rejects(a.artifacts.recover(a.artifact.answer_id, () => {}), /ANSWER_RECOVERY_UNVERIFIED/);
  a.store.cancel(a.job.task_id);
  await assert.rejects(a.artifacts.publish(a.artifact.answer_id, finish, () => {}), /ANSWER_JOB_NOT_RUNNING/);
  assert.equal(a.store.session(a.job.session_key).last_response_at, null);
});
test('OFFLINE M2: persisted finish evidence repairs a draft before final rename without re-execution', async t => {
  const f = setup(t), a = answerFixture(f); a.artifacts.capture(a.artifact.answer_id, 'finished raw');
  await assert.rejects(a.artifacts.publish(a.artifact.answer_id, finish, () => { throw new Error('injected gap'); }), /injected gap/);
  const file = path.join(a.artifacts.root, a.artifact.relative_path);
  // Synthesize the earlier boundary: completion evidence is durable, final rename has not happened.
  renameSync(file, file + '.part');
  await a.artifacts.recover(a.artifact.answer_id, raw => { a.store.completeArtifact(a.job.task_id, a.artifact.answer_id, raw); });
  assert.equal(a.store.get(a.job.task_id).status, 'succeeded');
  assert.equal((await a.artifacts.read(a.artifact.answer_id, { role: 'delivery', scope: a.scope })).toString('utf8'), 'finished raw');
});
test('OFFLINE M2: original size limit is an explicit partial failure, never a successful clipped final', async t => {
  const f = setup(t), a = answerFixture(f, 4);
  assert.throws(() => a.artifacts.capture(a.artifact.answer_id, 'large answer'), /ARTIFACT_LIMIT/);
  assert.equal(a.artifacts.get(a.artifact.answer_id).state, 'failed');
  assert.equal(a.artifacts.get(a.artifact.answer_id).completeness, 'partial');
  await assert.rejects(a.artifacts.publish(a.artifact.answer_id, finish, () => {}), /ANSWER_FINISH_UNVERIFIED/);
});
test('OFFLINE M2: raw reads reject altered files and symlinks', async t => {
  const f = setup(t), a = answerFixture(f);
  a.artifacts.capture(a.artifact.answer_id, 'original');
  const ready = await a.artifacts.publish(a.artifact.answer_id, finish, () => { a.store.complete(a.job.task_id, 'succeeded', 'original'); });
  const file = path.join(a.artifacts.root, ready.relative_path);
  writeFileSync(file, 'tampered');
  await assert.rejects(a.artifacts.read(ready.answer_id, { role: 'route', scope: a.scope }), /ANSWER_HASH_MISMATCH/);
  const target = path.join(f.root, 'external'); writeFileSync(target, 'original'); unlinkSync(file); symlinkSync(target, file);
  await assert.rejects(a.artifacts.read(ready.answer_id, { role: 'route', scope: a.scope }));
});

const summary: RecapContent = { summary: '总结', completed: [], pending: ['测试'], blockers: [], constraints: ['不能修改'], options: [{ label: 'A', meaning: '先检查' }], questions: ['是否继续？'] };
test('OFFLINE M2: short recaps preserve every code point and never call a model', async t => {
  const f = setup(t), a = answerFixture(f), raw = '  短答案\r\ne\u0301 😀  ';
  a.artifacts.capture(a.artifact.answer_id, raw);
  await a.artifacts.publish(a.artifact.answer_id, finish, () => { a.store.complete(a.job.task_id, 'succeeded', raw); });
  const recap = new RecapService(a.store, a.artifacts, { summarize: async () => { throw new Error('must not invoke'); } }, 'model-digest');
  const result = await recap.run(a.artifact.answer_id, a.scope);
  assert.equal(result.state, 'ready'); assert.equal(result.source, 'verbatim-short'); assert.equal(result.short_text, raw);
  assert.equal((await recap.run(a.artifact.answer_id, a.scope)).recap_id, result.recap_id);
});
test('OFFLINE M2: long recap covers all source ranges, budgets all fields and retries summary alone', async t => {
  const f = setup(t), a = answerFixture(f), raw = '原件秘密😀'.repeat(6000), chunks: string[] = []; let failing = true;
  a.artifacts.capture(a.artifact.answer_id, raw);
  await a.artifacts.publish(a.artifact.answer_id, finish, () => { a.store.complete(a.job.task_id, 'succeeded', raw); });
  const recap = new RecapService(a.store, a.artifacts, { summarize: async input => {
    if (failing) throw new Error('injected recap outage');
    if (input.stage === 'map') chunks.push(input.text); return summary;
  } }, 'model-digest');
  const failed = await recap.run(a.artifact.answer_id, a.scope);
  assert.equal(failed.state, 'failed'); assert.equal(a.store.get(a.job.task_id).status, 'succeeded');
  a.store.db.prepare(`INSERT INTO interaction_records(request_id,conversation_scope,kind,producer_role,answer_id,recap_id,completed_at)
    VALUES (?,?,'work','business',?,?,?)`).run(a.request.request_id, a.scope, a.artifact.answer_id, failed.recap_id, Date.now());
  const degraded = listInteractions(a.store, a.scope);
  assert.equal(degraded[0]!.recapState, 'failed'); assert.equal(JSON.stringify(degraded).includes('原件秘密'), false);
  failing = false;
  const successful = await recap.run(a.artifact.answer_id, a.scope);
  assert.equal(successful.recap_id, failed.recap_id); assert.equal(successful.state, 'ready');
  assert.equal(chunks.join(''), raw);
  const ranges = JSON.parse(successful.source_ranges_json) as Array<{ start: number; end: number }>;
  assert.equal(ranges[0]!.start, 0); assert.equal(ranges.at(-1)!.end, Buffer.byteLength(raw));
  for (let i = 1; i < ranges.length; i++) assert.equal(ranges[i - 1]!.end, ranges[i]!.start);
  assert.equal(a.store.db.prepare("SELECT count(*) n FROM jobs WHERE kind='agent'").get()!.n, 1);
  assert.equal(listInteractions(a.store, a.scope)[0]!.shortText, successful.short_text);
  assert.deepEqual(listInteractions(a.store, 'different-scope'), []);
  assert.throws(() => validateRecap({ ...summary, pending: ['x'.repeat(1000)], constraints: ['y'.repeat(1000)] }, 1000), /RECAP_BUDGET/);
});
test('OFFLINE M2: UTF-8 range windows never split multibyte text and preserve source bytes', () => {
  const bytes = Buffer.from('e\u0301😀中文\r\n'.repeat(23)), windows = utf8Windows(bytes, 7);
  assert.equal(Buffer.concat(windows.map(w => Buffer.from(w.text))).equals(bytes), true);
  assert.ok(windows.every(w => w.end - w.start <= 7));
});
test('OFFLINE recap retry budget: attempts survive service replacement and never rerun business or alter the original', async t => {
  const a = answerFixture(setup(t)), raw = 'immutable long report '.repeat(150);
  a.artifacts.capture(a.artifact.answer_id, raw);
  await a.artifacts.publish(a.artifact.answer_id, finish, () => { a.store.complete(a.job.task_id, 'succeeded', raw); });
  let calls = 0;
  const model = { summarize: async () => { calls++; throw Error('private provider error'); } };
  let row;
  for (let i = 0; i < 5; i++) row = await new RecapService(a.store, a.artifacts, model, 'same-profile').run(a.artifact.answer_id, a.scope);
  assert.equal(calls, 3); assert.equal(row!.state, 'failed'); assert.equal(row!.failure_code, 'RECAP_RETRY_LIMIT');
  const attempts = a.store.value<RecapAttempt[]>('recap-attempts:' + row!.recap_id)!;
  assert.deepEqual(attempts.map(a => [a.ordinal, a.state, a.failureCode]), [[1, 'failed', 'RECAP_FAILED'], [2, 'failed', 'RECAP_FAILED'], [3, 'failed', 'RECAP_FAILED']]);
  assert.equal(JSON.stringify(attempts).includes('private provider error'), false);
  assert.equal((await a.artifacts.read(a.artifact.answer_id, { role: 'delivery', scope: a.scope })).toString(), raw);
  assert.equal(a.store.db.prepare("SELECT count(*) n FROM jobs WHERE kind='agent'").get()!.n, 1);
  a.store.db.prepare('DELETE FROM routing_state WHERE key=?').run('recap-attempts:' + row!.recap_id);
  const unknown = await new RecapService(a.store, a.artifacts, model, 'same-profile').run(a.artifact.answer_id, a.scope);
  assert.equal(unknown.failure_code, 'RECAP_ATTEMPTS_UNVERIFIED'); assert.equal(calls, 3);
});
test('OFFLINE M2: Route range/outline uses bounded byte offsets and Bridge is denied', async t => {
  const f = setup(t), a = answerFixture(f), raw = '# 标题\r\n' + '😀中文'.repeat(5000);
  a.artifacts.capture(a.artifact.answer_id, raw);
  await a.artifacts.publish(a.artifact.answer_id, finish, () => { a.store.complete(a.job.task_id, 'succeeded', raw); });
  const access = { role: 'route' as const, scope: a.scope }, parts = []; let start = 0;
  for (;;) {
    const page = await readAnswerRange(a.artifacts, a.artifact.answer_id, access, start);
    assert.ok(Buffer.byteLength(page.text) <= 16384); parts.push(page.text);
    if (page.nextStart === undefined) break; start = page.nextStart;
  }
  assert.equal(parts.join(''), raw);
  const outline = await readAnswerOutline(a.artifacts, a.artifact.answer_id, access);
  assert.equal(outline.headings[0]!.start, 0); assert.equal(outline.headings[0]!.title, '# 标题\r');
  await assert.rejects(readAnswerRange(a.artifacts, a.artifact.answer_id, { role: 'bridge', scope: a.scope }, 0), /ANSWER_RAW_ACCESS_DENIED/);
  await assert.rejects(readAnswerRange(a.artifacts, a.artifact.answer_id, access, 3), /ANSWER_RANGE/);
});
test('OFFLINE M2: artifact-backed completion delivers original pages and declares partial automatic delivery', async t => {
  const f = setup(t); f.c.reply.maxResultBytes = 128; f.c.reply.chunkBytes = 128; f.c.reply.maxAutoParts = 2;
  const a = answerFixture(f), raw = '原件页内容😀'.repeat(2000);
  a.artifacts.capture(a.artifact.answer_id, raw);
  await a.artifacts.publish(a.artifact.answer_id, finish, () => { a.store.completeArtifact(a.job.task_id, a.artifact.answer_id, raw); });
  assert.equal(a.store.get(a.job.task_id).error_code, null);
  assert.ok(Buffer.byteLength(a.store.get(a.job.task_id).result_text!) <= 128);
  const deliveries = a.store.db.prepare('SELECT body_json FROM outbox WHERE task_id=? ORDER BY part_no').all(a.job.task_id) as { body_json: string }[];
  assert.equal(deliveries.length, 2); assert.match(JSON.parse(deliveries[1]!.body_json).text, /原件已完整归档.*另有.*未自动发送/);
  const state = a.store.value<{ totalParts: number; automaticRawParts: number; partial: boolean }>('artifact-delivery:' + a.job.task_id)!;
  assert.equal(state.automaticRawParts, 1); assert.equal(state.partial, true); assert.ok(state.totalParts > 2);
  assert.equal((await a.artifacts.read(a.artifact.answer_id, { role: 'delivery', scope: a.scope })).toString('utf8'), raw);
});
test('OFFLINE M2: Route read-only answer archives and delivers without refreshing the business response clock', async t => {
  const f = setup(t), a = answerFixture(f);
  a.store.complete(a.job.task_id, 'succeeded', 'business answer');
  const before = a.store.session(a.job.session_key).last_response_at;
  const incoming = normalize(fixture('read history'), f.c, 'local:codex'), request = new RequestStore(a.store).accept(incoming).request;
  const control = a.store.reserve(incoming, 'command', undefined, request.request_id).job;
  a.store.db.prepare('UPDATE orchestration_requests SET job_task_id=? WHERE request_id=?').run(control.task_id, request.request_id);
  const artifact = a.artifacts.stage(request.request_id, 'route', control.task_id, control.session_key);
  a.artifacts.capture(artifact.answer_id, 'read-only history result');
  await a.artifacts.publish(artifact.answer_id, { backend: 'controller', threadId: 'route', turnId: 'read-turn', completed: true, callbacksCompleted: true }, () => {
    a.store.completeArtifact(control.task_id, artifact.answer_id, 'read-only history result');
  });
  assert.equal(a.store.get(control.task_id).status, 'succeeded');
  assert.equal(a.store.session(a.job.session_key).last_response_at, before);
  assert.equal(a.store.db.prepare("SELECT count(*) n FROM jobs WHERE kind='agent'").get()!.n, 1);
});
