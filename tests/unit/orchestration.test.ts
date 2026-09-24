import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { setup, fixture, output } from '../helpers.ts';
import { parseConfig } from '../../src/config.ts';
import { normalize } from '../../src/local.ts';
import { openService } from '../../src/main.ts';
import { initializeHierarchy } from '../../src/orchestration/schema.ts';
import { RequestStore, sha256 } from '../../src/orchestration/requests.ts';
import { parseModels, parseOrchestration, selectModel } from '../../src/orchestration/config.ts';
import { ControllerRegistry, type ControllerAuditEvent } from '../../src/orchestration/registry.ts';
import { completedUsage, reached80 } from '../../src/controllers/rotation.ts';

const example = () => JSON.parse(readFileSync('docs/plans/three-layer-agent-bridge/config.hierarchical.example.json', 'utf8'));
function hierarchical(c: ReturnType<typeof setup>['c']) {
  const e = example();
  e.models.daily = { model: 'gpt-6-sol', reasoning: 'medium', contextWindowTokens: 1000000 };
  e.orchestration.controllerRuntime.workRoot = path.join(c.stateRoot, 'controllers');
  e.orchestration.answers.root = path.join(c.stateRoot, 'artifacts');
  return parseConfig({ ...c, models: e.models, orchestration: e.orchestration });
}

test('OFFLINE M1: target config enforces frozen rules and source precedence', () => {
  const e = example(), models = parseModels(e.models);
  const c = parseOrchestration(e.orchestration, models);
  assert.equal(c.rotation.thresholdNumerator, 4);
  for (const mutate of [
    (x: typeof e) => { x.orchestration.rotation.thresholdNumerator = 3; },
    (x: typeof e) => { x.orchestration.query.injectHistoricalContext = true; },
    (x: typeof e) => { x.orchestration.answers.bridgeCanReadOriginal = true; },
    (x: typeof e) => { x.orchestration.route.modelProfile = 'other'; },
    (x: typeof e) => { x.orchestration.controllerRuntime.requireCapabilityProbe = false; },
    (x: typeof e) => { x.orchestration.bridge.modelProfile = 'missing'; },
  ]) { const value = example(); mutate(value); assert.throws(() => parseOrchestration(value.orchestration, models)); }
  const daily = models.daily!, directory = { ...daily, model: 'directory' }, session = { ...daily, model: 'session' }, request = { ...daily, model: 'request' };
  assert.equal(selectModel(daily, {}).source, 'daily');
  assert.equal(selectModel(daily, { directory }).profile.model, 'directory');
  assert.equal(selectModel(daily, { directory, 'session-explicit': session }).source, 'session-explicit');
  assert.equal(selectModel(daily, { directory, 'session-explicit': session, request }).profile.model, 'request');
});

test('OFFLINE model selection: each field records its own source without promoting daily values', () => {
  const daily = { model: 'daily-model', reasoning: 'medium' as const, contextWindowTokens: 1000000 };
  const resolved = selectModel(daily, { directory: { reasoning: 'high' }, 'session-explicit': { model: 'session-model' }, request: { contextWindowTokens: 828400 } });
  assert.deepEqual(resolved.profile, { model: 'session-model', reasoning: 'high', contextWindowTokens: 828400 });
  assert.deepEqual(resolved.sources, { model: 'session-explicit', reasoning: 'directory', contextWindowTokens: 'request' });
  const fallback = selectModel(daily, { directory: { reasoning: 'low' } });
  assert.deepEqual(fallback.sources, { model: 'daily', reasoning: 'directory', contextWindowTokens: 'daily' });
  assert.equal(selectModel(daily, { request: {} }).source, 'daily');
  assert.deepEqual(daily, { model: 'daily-model', reasoning: 'medium', contextWindowTokens: 1000000 });
});

test('OFFLINE M1: no hierarchical request falls through to legacy execution', async t => {
  const f = setup(t), c = hierarchical(f.c);
  await assert.rejects(openService(c, output().stream), /HIERARCHICAL_CONFIG_REQUIRED/);
});

test('OFFLINE M1: decoded whitespace, CRLF, combining Unicode and image-only text are immutable', t => {
  const f = setup(t), c = hierarchical(f.c), store = f.store(); initializeHierarchy(store);
  const requests = new RequestStore(store), raw = '  中文\r\ne\u0301 🧑🏽‍💻\n  ';
  const incoming = normalize(fixture(raw), c, 'local:codex');
  const accepted = requests.accept(incoming);
  assert.equal(accepted.request.raw_query, raw);
  assert.equal(accepted.request.raw_query_sha256, sha256(Buffer.from(raw)));
  assert.equal(accepted.request.input_provenance, 'decoded-original');
  assert.equal(requests.accept(incoming).request.ingress_seq, accepted.request.ingress_seq);
  assert.equal(requests.accept(incoming).duplicate, true);
  assert.throws(() => requests.accept({ ...incoming, text: raw.normalize('NFC') }), /REQUEST_ID_CONFLICT/);
  assert.throws(() => requests.accept({ ...incoming, text: '\ud800' }), /INPUT_TEXT/);
  assert.throws(() => requests.accept({ ...incoming, route: { ...incoming.route, senderId: 'another' } }), /REQUEST_ID_CONFLICT/);
  assert.throws(() => requests.get(accepted.request.request_id, 'another-scope'), /REQUEST_NOT_FOUND/);
  const image = normalize(fixture('', 'default', undefined, ['/tmp/image.png']), c, 'local:codex');
  assert.equal(image.text, '');
  assert.equal(requests.accept(image).request.raw_query, '');
});

test('OFFLINE 80%: exact integer boundary, invalid usage and no cumulative/cache double counting', () => {
  assert.equal(reached80(799999n, 1000000n), false);
  assert.equal(reached80(800000n, 1000000n), true);
  assert.equal(reached80(800001n, 1000000n), true);
  assert.throws(() => reached80(-1n, 1000000n), /INVALID_USAGE/);
  assert.throws(() => reached80(1n, 0n), /INVALID_USAGE/);
  const ref = { threadId: 'thread', generation: 2 };
  const event = { threadId: 'thread', turnId: 'turn', tokenUsage: { last: { totalTokens: 799999, cachedInputTokens: 799999, reasoningOutputTokens: 100 }, total: { totalTokens: 9000000 }, modelContextWindow: 1000000 } };
  const usage = completedUsage(event, ref, 'turn', 1000000, 10);
  assert.equal(usage.usedTokens, 799999); assert.equal(usage.observedAt, 10);
  assert.throws(() => completedUsage(event, ref, 'different', 1000000), /USAGE_IDENTITY_MISMATCH/);
  assert.throws(() => completedUsage(event, ref, 'turn', 999999), /CONTEXT_WINDOW_MISMATCH/);
  assert.throws(() => completedUsage({ ...event, tokenUsage: { last: {}, modelContextWindow: 1000000 } }, ref, 'turn', 1000000), /INVALID_USAGE/);
});

test('OFFLINE M3: generation CAS, role registration, usage_unknown, late fencing and rotation telemetry', t => {
  const f = setup(t), store = f.store(); initializeHierarchy(store);
  const audit: ControllerAuditEvent[] = [], registry = new ControllerRegistry(store, e => audit.push(e));
  const first = registry.prepare('scope', 'route', 'canonical:inode', 'profile');
  assert.throws(() => registry.prepare('scope', 'route', 'canonical:inode', 'profile'), /CONTROLLER_CREATION_BUSY/);
  assert.throws(() => registry.activate(first.controller_id, null), /CONTROLLER_GENERATION_CONFLICT/);
  const ref = { threadId: 'native-management-id', generation: 0 };
  registry.registerNative(first.controller_id, ref, 'home');
  assert.equal(store.db.prepare('SELECT role FROM native_session_catalog').get()!.role, 'route');
  registry.activate(first.controller_id, null); registry.beginTurn(first.controller_id);
  assert.throws(() => registry.prepare('scope', 'route', 'canonical:inode', 'profile'), /CONTROLLER_BUSY/);
  const usage = completedUsage({ threadId: ref.threadId, turnId: 'turn', tokenUsage: { last: { totalTokens: 800000 }, modelContextWindow: 1000000 } }, ref, 'turn', 1000000);
  registry.completeTurn(first.controller_id, 'turn', usage);
  assert.equal(registry.get(first.controller_id).state, 'rotate_pending');
  assert.throws(() => registry.beginTurn(first.controller_id), /CONTROLLER_NOT_READY/);
  const second = registry.prepare('scope', 'route', 'canonical:inode', 'profile');
  registry.registerNative(second.controller_id, { threadId: 'second', generation: 1 }, 'home');
  registry.activate(second.controller_id, first.controller_id, 'usage_80');
  assert.throws(() => registry.fence(first.controller_id, 0), /CONTROLLER_STALE_CALLBACK/);
  assert.equal(registry.get(first.controller_id).state, 'retired');
  assert.equal(store.db.prepare('SELECT count(*) n FROM business_bindings').get()!.n, 0);
  const requested = audit.find(e => e.event === 'controller.rotate_requested')!, rotated = audit.find(e => e.event === 'controller.rotated')!;
  assert.equal(requested.bindingDigest, rotated.bindingDigest);
  assert.equal(audit.find(e => e.event === 'controller.usage_observed')!.usedTokens, 800000);
  assert.ok(audit.every(event => Number.isSafeInteger(event.at) && event.at > 0 && event.role === 'route'));
  registry.beginTurn(second.controller_id); registry.completeTurn(second.controller_id, 'no-usage-turn');
  assert.equal(registry.get(second.controller_id).state, 'usage_unknown');
  assert.throws(() => registry.beginTurn(second.controller_id), /CONTROLLER_NOT_READY/);
});

test('OFFLINE M1: pure target clarification refers to one unexecuted source without rewriting it', t => {
  const f = setup(t), store = f.store(); initializeHierarchy(store); const requests = new RequestStore(store);
  const source = requests.accept(normalize(fixture('do the original work'), f.c, 'local:codex')).request;
  requests.transition(source.request_id, source.conversation_scope, ['accepted'], 'completed');
  store.db.prepare('UPDATE orchestration_requests SET route_snapshot_json=? WHERE request_id=?').run(JSON.stringify({ pendingSelection: true, expiresAt: Date.now() + 900000 }), source.request_id);
  const control = requests.accept(normalize(fixture('第二个'), f.c, 'local:codex')).request;
  const selected = requests.referencePending(control.request_id, source.request_id, source.conversation_scope);
  assert.equal(selected.raw_query, 'do the original work');
  assert.equal(requests.get(control.request_id, source.conversation_scope).raw_query, '第二个');
  assert.throws(() => requests.referencePending(control.request_id, source.request_id, source.conversation_scope), /SOURCE_REQUEST_ALREADY_REFERENCED/);
});
