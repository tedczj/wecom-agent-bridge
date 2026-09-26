import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync, mkdtempSync, rmSync, realpathSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import sharp from 'sharp';
import { fixture, eventually } from '../helpers.ts';
import { listInteractions } from '../../src/answers/projection.ts';
import { orchestrationDebug } from '../../src/orchestration/debug.ts';
import { buildHandoff } from '../../src/controllers/handoff.ts';
import { RequestStore } from '../../src/orchestration/requests.ts';
import { normalize } from '../../src/local.ts';
import type { Maintenance } from '../../src/maintenance.ts';
import { duplicateMeter } from '../live/duplicate-meter.ts';
import type { ImageRef } from '../../src/types.ts';

import { harness } from '../hierarchical-helpers.ts';
test('OFFLINE fallback: image and following query use one business session despite unrelated query focus', async t => {
  const h = await harness(t, undefined, undefined, 'second');
  await h.bridge.accept(fixture('A history')); await h.settle();
  const file = path.join(h.root, 'fallback-image.png');
  await sharp({ create: { width: 8, height: 8, channels: 3, background: 'red' } }).png().toFile(file);
  const first = await h.bridge.accept(fixture('', 'default', undefined, [file]));
  const second = await h.bridge.accept(fixture('搜一下这款啤酒的评价')); await h.settle();
  assert.equal(h.store.get(first.taskId!).status, 'succeeded');
  assert.equal(h.store.get(second.taskId!).status, 'succeeded');
  assert.equal(h.calls.length, 2);
  assert.deepEqual(h.calls.map(call => [call.workspaceId, call.text, call.images.length]), [
    ['second', '', 1], ['second', '搜一下这款啤酒的评价', 0],
  ]);
  assert.equal(h.calls[0]!.sessionKey, h.calls[1]!.sessionKey);
  assert.deepEqual(h.refs[1], JSON.parse(h.store.session(h.calls[0]!.sessionKey).agent_ref_json!));
  const imageInputs = h.controllerInputs.filter(input => input.text === '');
  assert.deepEqual(imageInputs.map(input => input.role), ['bridge', 'route']);
  assert.ok(imageInputs.every(input => input.images[0]?.sha256 === h.calls[0]!.images[0]!.sha256));
  await h.bridge.accept(fixture('A work')); await h.settle();
  await h.bridge.accept(fixture('继续')); await h.settle();
  assert.deepEqual(h.calls.slice(2).map(call => call.workspaceId), ['test', 'test']);
  await h.bridge.accept(fixture('ambiguous work')); await h.settle();
  assert.equal(h.calls.length, 4);
});
test('OFFLINE session identity: business creation and Route replies retain distinct persisted roles and handoff provenance', async t => {
  const h = await harness(t);
  const work = await h.bridge.accept(fixture('A work')); await h.settle();
  const ref = JSON.parse(h.store.session(h.calls[0]!.sessionKey).agent_ref_json!) as { threadId: string };
  assert.equal(h.store.db.prepare('SELECT role FROM native_session_catalog WHERE native_id=?').get(ref.threadId)?.role, 'business');
  const history = await h.bridge.accept(fixture('A native history')); await h.settle();
  const scope = h.store.db.prepare('SELECT conversation_scope FROM orchestration_requests WHERE request_id=?').get(work.taskId!)!.conversation_scope as string;
  const rows = listInteractions(h.store, scope);
  assert.equal(rows.find(row => row.requestId === work.taskId)?.producerRole, 'business');
  assert.equal(rows.find(row => row.requestId === history.taskId)?.producerRole, 'route');
  const records = buildHandoff(h.store, scope, null).narrative.records;
  assert.equal(records.find(row => row.requestId === work.taskId)?.producerRole, 'business');
  assert.equal(records.find(row => row.requestId === history.taskId)?.producerRole, 'route');
  const registered = h.store.db.prepare('SELECT role FROM native_session_catalog').all().map(row => row.role);
  assert.ok(registered.includes('bridge')); assert.ok(registered.includes('route'));
  assert.deepEqual({ nativeId: (h.historyReads[0]!.page as { nativeId: string }).nativeId,
    role: (h.historyReads[0]!.page as { role: string }).role }, { nativeId: ref.threadId, role: 'business' });
  assert.equal(h.calls.length, 1);
});
test('OFFLINE hierarchical search: directory filtering uses host authorization and never dispatches business work', async t => {
  const h = await harness(t);
  const first = await h.bridge.accept(fixture('A SEARCH_NEEDLE')); await h.settle();
  await h.bridge.accept(fixture('B SEARCH_NEEDLE')); await h.settle();
  const searched = await h.bridge.accept(fixture('search test SEARCH_NEEDLE')); await h.settle();
  assert.equal(h.store.get(searched.taskId!).status, 'succeeded'); assert.equal(h.calls.length, 2);
  assert.deepEqual((h.searches[0] as Array<{ requestId: string }>).map(row => row.requestId), [first.taskId]);
  const outside = await h.bridge.accept(fixture('search / SEARCH_NEEDLE')); await h.settle();
  assert.equal(h.store.get(outside.taskId!).status, 'failed'); assert.equal(h.store.get(outside.taskId!).error_code, 'DIRECTORY_UNAUTHORIZED');
  assert.equal(h.calls.length, 2); assert.equal(h.searches.length, 1);
});
test('OFFLINE hierarchical work: a Route metadata answer cannot impersonate a submitted business task', async t => {
  const h = await harness(t), accepted = await h.bridge.accept(fixture('A metadata-only work')); await h.settle();
  const job = h.store.get(accepted.taskId!);
  assert.equal(job.status, 'failed'); assert.equal(job.error_code, 'BUSINESS_NOT_SUBMITTED'); assert.equal(h.calls.length, 0);
  assert.equal(h.channel.sent.some(row => row.text.includes('UNEXECUTED_PROJECT_NAME')), false);
});
test('OFFLINE hierarchical chain: ingress/controller/business query equality, native continuation and original delivery', async t => {
  const h = await harness(t), raw = '  A 原始 e\u0301\r\n  ', frame = fixture(raw);
  const accepted = await h.bridge.accept(frame); assert.ok(accepted.taskId); await h.settle();
  assert.equal(h.store.get(accepted.taskId!).status, 'succeeded', h.store.get(accepted.taskId!).error_code ?? 'job did not succeed');
  assert.equal(h.calls.length, 1); assert.equal(h.calls[0]!.text, raw);
  assert.deepEqual(h.controllerInputs.map(input => input.text), [raw, raw]);
  assert.equal(h.store.get(accepted.taskId!).status, 'succeeded');
  assert.ok(h.channel.sent.some(message => message.text.includes('business original\r\n' + raw)));
  assert.equal(h.channel.sent.some(message => message.text.includes('must not replace')), false);
  assert.equal((await h.bridge.accept(frame)).duplicate, true);
  const second = await h.bridge.accept(fixture('继续')); await h.settle();
  assert.equal(h.calls.length, 2); assert.equal(h.calls[1]!.text, '继续');
  assert.equal(h.calls[1]!.sessionKey, h.calls[0]!.sessionKey);
  assert.ok(h.refs[1]); assert.equal(h.store.get(second.taskId!).status, 'succeeded');
  assert.ok(h.channel.sent.some(message => message.text.includes('continued:' + raw)));
  assert.equal(h.maxActive(), 1);
});
test('OFFLINE hierarchical chain: read-only cross-directory query preserves active execution directory and business clock', async t => {
  const h = await harness(t); await h.bridge.accept(fixture('A work')); await h.settle();
  const key = h.calls[0]!.sessionKey, clock = h.store.session(key).last_response_at;
  await h.bridge.accept(fixture('B history')); await h.settle();
  assert.equal(h.calls.length, 1); assert.equal(h.store.session(key).last_response_at, clock);
  await h.bridge.accept(fixture('继续 A 之前的工作')); await h.settle();
  assert.equal(h.calls[1]!.workspaceId, 'test');
  assert.equal(h.store.db.prepare('SELECT count(*) n FROM interaction_records').get()!.n, 3);
});
test('OFFLINE native history: original follow-up and session reference reach the same Route without business execution', async t => {
  const h = await harness(t); await h.bridge.accept(fixture('A work')); await h.settle();
  const key = h.calls[0]!.sessionKey, clock = h.store.session(key).last_response_at;
  for (const query of ['A native history', 'A native history follow-up']) {
    const accepted = await h.bridge.accept(fixture(query)); await h.settle();
    assert.equal(h.store.get(accepted.taskId!).status, 'succeeded', h.store.get(accepted.taskId!).error_code ?? 'history failed');
    assert.deepEqual(h.controllerInputs.slice(-2).map(input => input.text), [query, query]);
  }
  assert.equal(h.historyReads.length, 2); assert.equal(h.historyReads[0]!.sessionRef, h.historyReads[1]!.sessionRef);
  assert.deepEqual(h.historyReads[0]!.page, h.historyReads[1]!.page);
  assert.equal(new Set(h.controllerInputs.filter(input => input.role === 'route').map(input => input.ref)).size, 1);
  assert.equal(h.calls.length, 1); assert.equal(h.store.session(key).last_response_at, clock);
  const switched = await h.bridge.accept(fixture('B history')); await h.settle();
  const scope = h.store.db.prepare('SELECT conversation_scope FROM orchestration_requests WHERE request_id=?').get(switched.taskId!)!.conversation_scope as string;
  const state = h.store.value<{ queryFocus: { directoryRef: string; sessionRef?: string } }>('orchestration:conversation:' + scope)!;
  assert.equal(state.queryFocus.directoryRef, 'second'); assert.equal(state.queryFocus.sessionRef, undefined);
});
test('OFFLINE hierarchical chain: fast status/cancel enters while Bridge and Route await business', async t => {
  const h = await harness(t); h.waitForCancel();
  const first = await h.bridge.accept(fixture('A wait')); await eventually(() => h.calls.length === 1);
  const begin = Date.now(), status = await h.bridge.accept(fixture('/status'));
  assert.equal(h.store.get(status.taskId!).status, 'succeeded'); assert.ok(Date.now() - begin < 1000);
  const debug = await h.bridge.accept(fixture('/debug ' + first.taskId));
  assert.equal(h.store.get(debug.taskId!).status, 'succeeded'); assert.equal(h.calls.length, 1);
  const cancel = await h.bridge.accept(fixture('/cancel ' + first.taskId!.slice(0, 8))); await h.settle();
  assert.equal(h.store.get(cancel.taskId!).status, 'succeeded');
  assert.equal(h.store.get(first.taskId!).status, 'cancelled'); assert.equal(h.calls.length, 1);
  const scope = h.store.db.prepare('SELECT conversation_scope FROM orchestration_requests WHERE request_id=?').get(first.taskId!)!.conversation_scope as string;
  const notice = listInteractions(h.store, scope).find(row => row.requestId === first.taskId)!;
  assert.equal(notice.kind, 'failure'); assert.equal(notice.status, 'cancelled'); assert.equal(notice.recapState, 'ready');
  assert.equal(h.store.session(h.calls[0]!.sessionKey).last_response_at, null);
});
test('OFFLINE hierarchical debug: request metadata is scoped and excludes query, answer, paths and raw tool bodies', async t => {
  const h = await harness(t), accepted = await h.bridge.accept(fixture('A PRIVATE_QUERY')); await h.settle();
  const scope = h.store.db.prepare('SELECT conversation_scope FROM orchestration_requests WHERE request_id=?').get(accepted.taskId!)!.conversation_scope as string;
  const before = h.controllerInputs.length, report = orchestrationDebug(h.store, scope, 'current', accepted.taskId) as { requests: Array<Record<string, unknown>> };
  assert.equal(report.requests.length, 1); assert.equal(report.requests[0]!.phase, 'completed');
  assert.ok(JSON.stringify(report).includes('route_delegate'));
  for (const secret of ['PRIVATE_QUERY', 'business original', h.root, 'selectionToken', 'raw_query', 'input_json']) assert.equal(JSON.stringify(report).includes(secret), false);
  assert.throws(() => orchestrationDebug(h.store, 'foreign', 'current', accepted.taskId), /TASK_NOT_FOUND/);
  assert.throws(() => orchestrationDebug(h.store, scope, 'current', '%'), /COMMAND_ARGUMENTS/);
  const denied = await h.bridge.accept(fixture('/debug ' + accepted.taskId, 'another')); await h.settle();
  assert.equal(h.store.get(denied.taskId!).error_code, 'TASK_NOT_FOUND');
  assert.equal(h.controllerInputs.length, before); assert.equal(h.calls.length, 1);
});
test('OFFLINE hierarchical chain: concurrently accepted A-B-A requests keep FIFO and per-directory native bindings', async t => {
  const h = await harness(t);
  const accepted = await Promise.all(['A one', 'B two', 'A three'].map(text => h.bridge.accept(fixture(text)))); await h.settle();
  assert.deepEqual(h.calls.map(call => call.text), ['A one', 'B two', 'A three']);
  assert.deepEqual(h.calls.map(call => call.workspaceId), ['test', 'second', 'test']);
  assert.equal(h.calls[0]!.sessionKey, h.calls[2]!.sessionKey); assert.notEqual(h.calls[0]!.sessionKey, h.calls[1]!.sessionKey);
  assert.equal(h.store.db.prepare("SELECT count(*) n FROM controller_sessions WHERE role='route'").get()!.n, 2);
  assert.ok(accepted.every(result => h.store.get(result.taskId!).status === 'succeeded')); assert.equal(h.maxActive(), 1);
});
for (const reply of ['第二个', '就是刚才查的 second 那个。', '就是刚才查的 B 那个。']) test(`OFFLINE hierarchical chain: ${reply} executes the pending source verbatim once`, async t => {
  const h = await harness(t), source = await h.bridge.accept(fixture('ambiguous work')); await h.settle();
  assert.equal(h.calls.length, 0); assert.equal(h.store.get(source.taskId!).kind, 'command');
  const choice = fixture(reply), accepted = await h.bridge.accept(choice); await h.settle();
  assert.equal(h.calls.length, 1); assert.equal(h.calls[0]!.text, 'ambiguous work'); assert.equal(h.calls[0]!.workspaceId, 'second');
  assert.equal(h.calls[0]!.sourceRequestId, source.taskId); assert.equal(h.calls[0]!.requestId, accepted.taskId);
  assert.equal((await h.bridge.accept(choice)).duplicate, true); await h.settle(); assert.equal(h.calls.length, 1);
});
test('OFFLINE hierarchical choice: a reply containing new work is not silently replaced by the pending query', async t => {
  const h = await harness(t); await h.bridge.accept(fixture('ambiguous work')); await h.settle();
  const text = '就是刚才查的 B 那个，现在只输出新请求';
  await h.bridge.accept(fixture(text)); await h.settle();
  assert.equal(h.calls.length, 1); assert.equal(h.calls[0]!.text, text); assert.equal(h.calls[0]!.sourceRequestId, h.calls[0]!.requestId);
});
test('OFFLINE hierarchical chain: later media is durably prepared before earlier business finishes', async t => {
  const h = await harness(t); h.waitForCancel();
  const first = await h.bridge.accept(fixture('A wait')); await eventually(() => h.calls.length === 1);
  const file = path.join(h.root, 'image.png');
  await sharp({ create: { width: 8, height: 8, channels: 3, background: '#ff0000' } }).png().toFile(file);
  const next = await h.bridge.accept(fixture('B image', 'default', undefined, [file]));
  await h.bridge.mediaReady(next.taskId!);
  const images = h.store.value<ImageRef[]>('request-media:' + next.taskId)!;
  assert.equal(images.length, 1); assert.equal(h.calls.length, 1); assert.ok(h.store.activeMedia().has(next.taskId!));
  await h.bridge.accept(fixture('/cancel ' + first.taskId)); await h.settle();
  assert.equal(h.calls.length, 2); assert.equal(h.calls[1]!.images[0]!.sha256, images[0]!.sha256);
  assert.ok(h.controllerInputs.filter(input => input.text === 'B image').every(input => input.images[0]?.sha256 === images[0]!.sha256));
});
test('OFFLINE hierarchical chain: concurrent duplicate execute callbacks share one job and one completion', async t => {
  const h = await harness(t), result = await h.bridge.accept(fixture('A duplicate tools')); await h.settle();
  assert.equal(h.calls.length, 1); assert.equal(h.store.get(result.taskId!).status, 'succeeded');
  assert.equal(h.store.db.prepare("SELECT count(*) n FROM controller_effects WHERE effect_key='business-submit'").get()!.n, 1);
});
test('OFFLINE hierarchical chain: shared controller budget stops before business submission and does not poison later requests', async t => {
  const h = await harness(t); h.c.orchestration!.limits.maxControllerDecisionsPerRequest = 4;
  const stopped = await h.bridge.accept(fixture('A limited')); await h.settle();
  assert.equal(h.calls.length, 0); assert.equal(h.store.get(stopped.taskId!).error_code, 'CONTROLLER_DECISION_LIMIT');
  assert.equal(h.store.db.prepare('SELECT count(*) n FROM controller_effects').get()!.n, 0);
  h.c.orchestration!.limits.maxControllerDecisionsPerRequest = 5;
  const next = await h.bridge.accept(fixture('A next')); await h.settle();
  assert.equal(h.calls.length, 1); assert.equal(h.store.get(next.taskId!).status, 'succeeded');
});
test('OFFLINE live instrumentation: actual host handler replay coalesces, ingress deduplicates, and instrumentation restores', async t => {
  const h = await harness(t), meter = duplicateMeter(); t.after(() => meter.stop());
  assert.throws(() => duplicateMeter(), /LIVE_METER_ALREADY_INSTALLED/);
  const frame = fixture('A instrumented request'), first = await h.bridge.accept(frame);
  const repeated = await h.bridge.accept(frame); await h.settle();
  assert.equal(repeated.duplicate, true); assert.equal(repeated.taskId, first.taskId); assert.equal(h.calls.length, 1);
  const snapshot = meter.snapshot();
  assert.deepEqual(snapshot.calls.map(call => call.role), ['bridge', 'route']);
  assert.equal(snapshot.businessSubmits, 0); // This harness uses an explicitly offline business double, not CodexBackend.
  assert.equal(snapshot.injected, true); assert.equal(snapshot.replay.length, 2);
  assert.equal(snapshot.replay[0]!.requestId, first.taskId); assert.deepEqual(snapshot.replay[0], snapshot.replay[1]);
  await h.bridge.accept(frame); await h.settle(); assert.deepEqual(meter.snapshot(), snapshot);
  const conflict = await h.bridge.accept({ ...frame, text: frame.text + ' different' });
  assert.equal(conflict.rejected, 'REQUEST_ID_CONFLICT'); assert.deepEqual(meter.snapshot(), snapshot);
  meter.stop(); await h.bridge.accept(fixture('A following request')); await h.settle();
  assert.equal(h.calls.length, 2); assert.deepEqual(meter.snapshot(), snapshot);
});
test('OFFLINE hierarchical chain: concrete directory consent resumes source text without changing sandbox', async t => {
  const h = await harness(t), outside = mkdtempSync(path.join(realpathSync(os.tmpdir()), 'hier-outside-')); t.after(() => rmSync(outside, { recursive: true, force: true }));
  const raw = 'outside ' + outside, source = await h.bridge.accept(fixture(raw)); await h.settle();
  assert.equal(h.calls.length, 0); assert.ok(h.channel.sent.some(message => message.text.includes(outside) && message.text.includes('read-only') && message.text.includes('/approve')));
  const approved = await h.bridge.accept(fixture('/approve')); await h.settle();
  assert.equal(h.calls.length, 1); assert.equal(h.calls[0]!.text, raw); assert.equal(h.calls[0]!.sourceRequestId, source.taskId);
  assert.equal(h.calls[0]!.routing!.directory.path, outside); assert.equal(h.store.get(approved.taskId!).status, 'succeeded');
});
test('OFFLINE hierarchical chain: request model override is temporary; explicit session preference persists only on that session', async t => {
  const h = await harness(t);
  for (const text of ['A initial', 'A use alternate', 'A default again', 'A persist alternate', 'A following']) { await h.bridge.accept(fixture(text)); await h.settle(); }
  assert.deepEqual(h.calls.map(call => call.routing!.execution!.reasoning), ['high', 'low', 'high', 'low', 'low']);
  assert.deepEqual(h.calls.map(call => call.routing!.modelSource), ['daily', 'request', 'daily', 'request', 'session-explicit']);
  assert.deepEqual(h.calls.map(call => call.routing!.modelSources), ['daily', 'request', 'daily', 'request', 'session-explicit'].map(source => ({ model: source, reasoning: source, contextWindowTokens: source })));
  assert.ok(h.calls.every(call => call.routing!.execution!.contextWindowTokens === 1000000));
  assert.ok(h.managementModels.every(model => model === 'gpt-6-sol/high'));
});
test('OFFLINE hierarchical chain: directory reasoning preserves daily model/window sources and window changes fence sessions', async t => {
  const h = await harness(t, { reasoning: 'high' });
  await h.bridge.accept(fixture('A first')); await h.settle();
  assert.deepEqual(h.calls[0]!.routing!.modelSources, { model: 'daily', reasoning: 'directory', contextWindowTokens: 'daily' });
  const previous = h.calls[0]!.routing!.digest;
  h.c.models!.alternate!.contextWindowTokens = 828400;
  await h.bridge.accept(fixture('A use alternate')); await h.settle();
  assert.equal(h.calls.length, 2);
  assert.equal(h.calls[1]!.routing!.modelSources!.contextWindowTokens, 'request');
  assert.equal(h.calls[1]!.routing!.execution!.contextWindowTokens, 828400);
  assert.notEqual(h.calls[1]!.routing!.digest, previous);
  assert.notEqual(h.calls[1]!.sessionKey, h.calls[0]!.sessionKey);
  assert.equal(h.refs[1], undefined);
});
test('OFFLINE hierarchical chain: advisory model-cache drift cannot veto an explicit operator profile', async t => {
  const h = await harness(t);
  writeFileSync(path.join(h.c.codex.home, 'models_cache.json'), JSON.stringify({ models: [{ slug: 'another-model' }] }));
  const first = await h.bridge.accept(fixture('A first')); await h.settle();
  assert.equal(h.store.get(first.taskId!).status, 'succeeded'); assert.equal(h.calls[0]!.routing!.execution!.model, 'gpt-6-sol');
  writeFileSync(path.join(h.c.codex.home, 'models_cache.json'), JSON.stringify({ models: [{ slug: 'different-model' }] }));
  const second = await h.bridge.accept(fixture('A second')); await h.settle();
  assert.equal(h.store.get(second.taskId!).status, 'succeeded'); assert.equal(h.calls[1]!.routing!.execution!.model, 'gpt-6-sol');
  assert.equal(h.calls[1]!.sessionKey, h.calls[0]!.sessionKey);
});
test('OFFLINE hierarchical chain: an execution attempt under switch intent is a failure, never a successful control answer', async t => {
  const h = await harness(t), result = await h.bridge.accept(fixture('A misclassified switch')); await h.settle();
  assert.equal(h.calls.length, 0);
  assert.equal(h.store.get(result.taskId!).status, 'failed'); assert.equal(h.store.get(result.taskId!).error_code, 'ROUTE_INTENT_CONFLICT');
  assert.equal(h.store.db.prepare('SELECT count(*) n FROM controller_effects').get()!.n, 0);
});
test('OFFLINE historical answer query exposes its host intent without rewriting the query or dispatching business', async t => {
  const h = await harness(t), work = await h.bridge.accept(fixture('A first')); await h.settle();
  const session = h.store.session(h.store.get(work.taskId!).session_key), clock = session.last_response_at;
  const query = 'A host-intent history', result = await h.bridge.accept(fixture(query)); await h.settle();
  assert.equal(h.store.get(result.taskId!).status, 'succeeded'); assert.equal(h.store.get(result.taskId!).kind, 'command');
  assert.equal(h.calls.length, 1); assert.equal(h.store.session(session.session_key).last_response_at, clock);
  assert.deepEqual(h.controllerInputs.slice(-2).map(row => row.text), [query, query]);
});
test('OFFLINE directory switch: host receipt cannot turn directory selection into an unverified session-resume claim', async t => {
  const h = await harness(t), accepted = await h.bridge.accept(fixture('A pure switch')); await h.settle();
  const job = h.store.get(accepted.taskId!);
  assert.equal(job.status, 'succeeded'); assert.equal(job.kind, 'command'); assert.equal(h.calls.length, 0);
  assert.match(job.result_text!, /未恢复或执行业务会话/); assert.equal(job.result_text!.includes('UNVERIFIED'), false);
  assert.equal(h.store.db.prepare('SELECT count(*) n FROM business_bindings').get()!.n, 0);
});
test('OFFLINE hierarchical chain: result retrieval is archived but never leaks raw pages through Bridge short history', async t => {
  const h = await harness(t), source = await h.bridge.accept(fixture('A original')); await h.settle();
  const result = await h.bridge.accept(fixture('/result ' + source.taskId)); await h.settle();
  const scope = h.store.db.prepare('SELECT conversation_scope FROM orchestration_requests WHERE request_id=?').get(result.taskId!)!.conversation_scope as string;
  const record = listInteractions(h.store, scope).find(record => record.requestId === result.taskId)!;
  assert.equal(record.recapState, 'withheld'); assert.equal(record.shortText.includes('business original'), false);
  assert.equal(h.calls.length, 1);
});
test('OFFLINE controls: new/list/read/resume do not start business or refresh its response clock', async t => {
  const h = await harness(t); await h.bridge.accept(fixture('A first')); await h.settle();
  const first = h.calls[0]!, clock = h.store.session(first.sessionKey).last_response_at, controllerCalls = h.controllerInputs.length;
  const listed = await h.bridge.accept(fixture('/sessions A')); await h.settle();
  assert.equal(h.store.get(listed.taskId!).status, 'succeeded');
  const read = await h.bridge.accept(fixture('/read 1')); await h.settle();
  assert.equal(h.store.get(read.taskId!).status, 'succeeded');
  const resumed = await h.bridge.accept(fixture('/resume 1')); await h.settle();
  assert.equal(h.store.get(resumed.taskId!).status, 'succeeded');
  assert.equal(h.store.session(first.sessionKey).last_response_at, clock); assert.equal(h.calls.length, 1);
  const fresh = await h.bridge.accept(fixture('/new A')); await h.settle();
  assert.equal(h.store.get(fresh.taskId!).kind, 'command'); assert.notEqual(h.store.get(fresh.taskId!).session_key, first.sessionKey);
  assert.equal(h.calls.length, 1); assert.equal(h.controllerInputs.length, controllerCalls);
  await h.bridge.accept(fixture('A next')); await h.settle();
  assert.equal(h.calls[1]!.sessionKey, h.store.get(fresh.taskId!).session_key); assert.equal(h.refs[1], undefined);
});
test('OFFLINE controls: maintenance needs its delivered proposal and does not complete before supervisor result', async t => {
  const h = await harness(t), prior = process.env.BRIDGE_SUPERVISOR_TOKEN, token = randomUUID();
  process.env.BRIDGE_SUPERVISOR_TOKEN = token;
  t.after(() => { if (prior === undefined) delete process.env.BRIDGE_SUPERVISOR_TOKEN; else process.env.BRIDGE_SUPERVISOR_TOKEN = prior; });
  const dir = path.join(h.c.stateRoot, 'supervisor'); mkdirSync(dir);
  writeFileSync(path.join(dir, 'instance.lock'), JSON.stringify({ pid: process.ppid, token, root: h.root }), { mode: 0o600 });
  await h.bridge.accept(fixture('/restart')); await h.settle();
  const approved = await h.bridge.accept(fixture('/approve')); await h.settle();
  assert.equal(h.store.value<{ phase: string }>('maintenance')!.phase, 'requested');
  assert.equal(h.store.get(approved.taskId!).status, 'queued');
  const rejected = await h.bridge.accept(fixture('A new work')); await h.settle();
  assert.equal(h.store.get(rejected.taskId!).error_code, 'MAINTENANCE_DRAINING'); assert.equal(h.calls.length, 0);
});
test('OFFLINE startup: a durable maintenance result repairs artifact/outbox/root before generic recovery, without a model', async t => {
  let requestId = '', answerId = '', completedAt = 0;
  const h = await harness(t, undefined, async ({ store, c, artifacts }) => {
    const incoming = normalize(fixture('/approve'), c, 'local:codex'), request = new RequestStore(store).accept(incoming).request;
    requestId = request.request_id;
    const job = store.reserve(incoming, 'command', undefined, requestId).job;
    store.db.prepare("UPDATE orchestration_requests SET job_task_id=?,phase='result_processing' WHERE request_id=?").run(job.task_id, requestId);
    store.put('maintenance', { action: 'restart', phase: 'starting', taskId: requestId, requestTaskId: requestId,
      route: job.route_json, at: Date.now(), supervisorToken: 'offline-token' } satisfies Maintenance);
    const artifact = artifacts.stage(requestId, 'system', requestId, job.session_key); answerId = artifact.answer_id;
    artifacts.capture(answerId, '维护最终回执');
    await assert.rejects(artifacts.publish(answerId, { backend: 'system', requestId, completed: true, phase: 'completed', outcome: 'succeeded' },
      () => { throw Error('SQL crash'); }), /SQL crash/);
    completedAt = JSON.parse(artifacts.get(answerId).finish_evidence_json!).completedAt;
  });
  await h.settle();
  assert.equal(h.store.get(requestId).status, 'succeeded'); assert.equal(h.store.get(requestId).finished_at, completedAt);
  assert.equal(h.store.value<Maintenance>('maintenance')!.phase, 'succeeded');
  assert.equal(h.store.db.prepare('SELECT phase FROM orchestration_requests WHERE request_id=?').get(requestId)!.phase, 'completed');
  assert.equal(h.store.db.prepare("SELECT count(*) n FROM outbox WHERE task_id=? AND purpose='maintenance-final'").get(requestId)!.n, 1);
  assert.equal(h.store.db.prepare('SELECT answer_id FROM interaction_records WHERE request_id=?').get(requestId)!.answer_id, answerId);
  const result = await h.bridge.accept(fixture('/result ' + requestId)); await h.settle();
  assert.equal(h.store.get(result.taskId!).status, 'succeeded');
  assert.ok(h.channel.sent.some(message => message.text.includes('维护最终回执')));
  assert.equal(h.calls.length, 0); assert.equal(h.controllerInputs.length, 0);
});

test('OFFLINE progress regression: term4u query stays verbatim, launches no business, and reuses Route on follow-up', async t => {
  const h = await harness(t), texts = ['看下 term4u 项目里在干啥', '续查刚才 term4u 的进展'];
  for (const text of texts) { const result = await h.bridge.accept(fixture(text)); await h.settle(); assert.equal(h.store.get(result.taskId!).status, 'succeeded'); }
  assert.deepEqual(h.controllerInputs.map(row => row.text), [texts[0], texts[0], texts[1], texts[1]]);
  const routes = h.controllerInputs.filter(row => row.role === 'route'); assert.equal(routes[0]!.ref, routes[1]!.ref);
  assert.equal(h.calls.length, 0); assert.equal(h.store.db.prepare('SELECT count(*) n FROM business_bindings').get()!.n, 0);
  assert.equal(h.store.db.prepare("SELECT count(*) n FROM controller_sessions WHERE role='route'").get()!.n, 1);
  assert.ok(h.managementModels.every(model => model === 'gpt-6-sol/high'));
});
