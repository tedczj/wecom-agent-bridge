import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { setup, fixture } from '../helpers.ts';
import { normalize } from '../../src/local.ts';
import { initializeHierarchy } from '../../src/orchestration/schema.ts';
import { parseModels, parseOrchestration } from '../../src/orchestration/config.ts';
import { RequestStore } from '../../src/orchestration/requests.ts';
import { ControllerRegistry } from '../../src/orchestration/registry.ts';
import { BusinessSessions } from '../../src/orchestration/business-sessions.ts';
import { BusinessDispatch } from '../../src/orchestration/dispatch.ts';
import { NativeReader } from '../../src/history/reader.ts';
import { ResumeVerifier } from '../../src/history/verifier.ts';
import { directoryIdentity } from '../../src/history/catalog.ts';
import type { Target } from '../../src/routing/catalog.ts';
import { BridgeError } from '../../src/errors.ts';
import { seedPartialCatalog } from '../live/partial-fixture.ts';
import { NativeCatalog } from '../../src/history/catalog.ts';

function configured(f: ReturnType<typeof setup>) {
  const example = JSON.parse(readFileSync('docs/plans/three-layer-agent-bridge/config.hierarchical.example.json', 'utf8'));
  f.c.orchestration = parseOrchestration(example.orchestration, parseModels(example.models));
  const store = f.store(); initializeHierarchy(store);
  const requests = new RequestStore(store), registry = new ControllerRegistry(store, () => {});
  const target: Target = { config: f.c, digest: 'profile', directory: { id: 'test', path: f.workspace, identity: 'inode', profile: 'read', aliases: [], description: '' } };
  let now = Date.now();
  const request = (text = 'work') => {
    const root = requests.accept(normalize(fixture(text), f.c, 'local:codex')).request;
    requests.transition(root.request_id, root.conversation_scope, ['accepted'], 'bridge_planning');
    requests.transition(root.request_id, root.conversation_scope, ['bridge_planning'], 'route_planning'); return root;
  };
  const first = request(), actor = registry.prepare(first.conversation_scope, 'route', directoryIdentity(target), 'management');
  registry.registerNative(actor.controller_id, { threadId: randomUUID(), generation: 0 }, 'management-home'); registry.activate(actor.controller_id, null); registry.beginTurn(actor.controller_id);
  const binding = (id = first.request_id) => ({ requestId: id, scope: first.conversation_scope, controllerId: actor.controller_id, generation: 0 });
  const sessions = new BusinessSessions(store, registry, new ResumeVerifier(new NativeReader(), { check: async () => 'idle' }), () => now), dispatch = new BusinessDispatch(store, registry);
  const create = async () => {
    const b = binding(), options = await sessions.resolve(b, target), option = options.options.find(option => option.isDefault)!;
    const selected = await sessions.select(b, target, option.optionToken);
    const job = store.atomic(() => {
      const job = dispatch.enqueue(b, selected.token, selected.selection, () => sessions.validate(b, target, selected));
      sessions.bind(b, target, selected, job); return job;
    });
    sessions.bind(b, target, selected, job); // Idempotent repeat never changes the binding version.
    return { job, selected };
  };
  const complete = (job: Awaited<ReturnType<typeof create>>['job']) => {
    store.prepared(job.task_id, []); store.claim(); store.complete(job.task_id, 'succeeded', 'offline final');
    now = Date.now();
    requests.transition(first.request_id, first.conversation_scope, ['awaiting_business'], 'result_processing');
    requests.transition(first.request_id, first.conversation_scope, ['result_processing'], 'completed');
  };
  return { store, requests, registry, target, first, request, binding, sessions, dispatch, create, complete, setNow: (value: number) => { now = value; }, now: () => now };
}
test('OFFLINE M4: no history creates one binding; pending first reply reuses it without discovering other native files', async t => {
  const f = setup(t), h = configured(f), { job } = await h.create();
  assert.equal(h.store.db.prepare('SELECT count(*) n FROM business_bindings').get()!.n, 1);
  assert.equal(h.store.db.prepare('SELECT version FROM business_bindings').get()!.version, 1);
  const root = path.join(f.c.codex.home, 'sessions'); mkdirSync(root); writeFileSync(path.join(root, 'broken.jsonl'), 'BROKEN\n');
  const next = h.request(), options = await h.sessions.resolve(h.binding(next.request_id), h.target);
  assert.equal(options.options.find(option => option.isDefault)!.reason, 'binding-pending');
  const selected = await h.sessions.select(h.binding(next.request_id), h.target, options.options.find(option => option.isDefault)!.optionToken);
  assert.equal(selected.selection.sessionKey, job.session_key); assert.equal(selected.selection.fresh, false);
});
test('OFFLINE M4: exactly 24h reuses binding, expiration creates fresh, and future timestamps require explicit choice', async t => {
  const f = setup(t), h = configured(f), { job } = await h.create(); h.complete(job);
  h.store.persistSession(job.session_key, { kind: 'codex', threadId: randomUUID() });
  const last = h.now() - 24 * 60 * 60 * 1000;
  h.store.db.prepare('UPDATE sessions SET last_response_at=? WHERE session_key=?').run(last, job.session_key);
  const next = h.request(), b = h.binding(next.request_id);
  assert.equal((await h.sessions.resolve(b, h.target)).options.find(option => option.isDefault)!.reason, 'binding');
  h.setNow(h.now() + 1);
  assert.equal((await h.sessions.resolve(b, h.target)).options.find(option => option.isDefault)!.reason, 'binding-expired');
  h.store.db.prepare('UPDATE sessions SET last_response_at=? WHERE session_key=?').run(h.now() + 1, job.session_key);
  assert.equal((await h.sessions.resolve(b, h.target)).needsClarification, true);
});
test('OFFLINE M4: expired selection, cross-request tokens and profile changes cannot authorize a dispatch', async t => {
  const f = setup(t), h = configured(f), b = h.binding(), options = await h.sessions.resolve(b, h.target), token = options.options[0]!.optionToken;
  const next = h.request();
  await assert.rejects(h.sessions.select(h.binding(next.request_id), h.target, token), /SESSION_OPTION_EXPIRED/);
  await assert.rejects(h.sessions.select(b, { ...h.target, digest: 'changed' }, token), /SESSION_OPTION_EXPIRED/);
  h.setNow(h.now() + 15 * 60 * 1000);
  await assert.rejects(h.sessions.select(b, h.target, token), /SESSION_OPTION_EXPIRED/);
  assert.equal(h.store.db.prepare('SELECT count(*) n FROM jobs').get()!.n, 0);
});
test('OFFLINE M4: explicit new bypasses native discovery but never a tainted binding', async t => {
  const f = setup(t), h = configured(f), { job } = await h.create(); h.complete(job);
  writeFileSync(path.join(f.c.codex.home, 'sessions'), 'not a native history directory');
  const b = h.binding(h.request('new session').request_id);
  const explicit = await h.sessions.resolve(b, h.target, 'new');
  assert.equal(explicit.options.find(option => option.isDefault)!.reason, 'explicit-new');
  h.store.db.prepare("UPDATE sessions SET state='tainted' WHERE session_key=?").run(job.session_key);
  await assert.rejects(h.sessions.resolve(b, h.target, 'new'), /SESSION_TAINTED/);
});
test('OFFLINE M4: confirmed missing bound history may create fresh before prompt; corrupt target cannot', async t => {
  const f = setup(t), h = configured(f), { job } = await h.create(); h.complete(job);
  const id = randomUUID(); h.store.persistSession(job.session_key, { kind: 'codex', threadId: id });
  const b = h.binding(h.request().request_id), options = await h.sessions.resolve(b, h.target), option = options.options.find(option => option.isDefault)!;
  const fresh = await h.sessions.select(b, h.target, option.optionToken);
  assert.equal(fresh.selection.reason, 'missing-before-prompt'); assert.equal(fresh.selection.fresh, true);
  const root = path.join(f.c.codex.home, 'sessions'); mkdirSync(root); writeFileSync(path.join(root, id + '.jsonl'), 'BROKEN\n');
  await assert.rejects(h.sessions.select(b, h.target, option.optionToken), /HISTORY_FORMAT/);
  await assert.rejects(h.sessions.resolve(b, h.target, 'new'), /HISTORY_FORMAT/);
  await assert.rejects(h.sessions.select(b, h.target, options.options[0]!.optionToken), /HISTORY_FORMAT/);
  assert.throws(() => h.sessions.validate(b, h.target, fresh), /HISTORY_FORMAT/);
  assert.equal(h.store.db.prepare('SELECT count(*) n FROM jobs').get()!.n, 1);
  const explicit = await h.sessions.resolve(h.binding(h.request('explicit new request').request_id), h.target, 'new');
  assert.equal(explicit.options.find(option => option.isDefault)!.reason, 'explicit-new');
});
test('OFFLINE M5: explicit reference lookup refusal is sticky for its request and stores no reference body', async t => {
  const h = configured(setup(t)), binding = h.binding();
  assert.throws(() => h.sessions.refuseResume(binding.requestId, h.target, 'PRIVATE_REFERENCE', new BridgeError('HISTORY_SCOPE')), /HISTORY_SCOPE/);
  await assert.rejects(h.sessions.resolve(binding, h.target, 'new'), /HISTORY_SCOPE/);
  assert.equal(JSON.stringify(h.store.value('resume-refusal:' + binding.requestId)).includes('PRIVATE_REFERENCE'), false);
});
test('OFFLINE partial metadata: a real empty first page retains coverage/cursor and cannot be converted into fresh execution', async t => {
  const f = setup(t), h = configured(f), b = h.binding();
  const seed = seedPartialCatalog(f.c.codex.home, f.workspace, { model: 'gpt-6-sol', reasoning: 'medium', contextWindowTokens: 1000000 });
  const page = await new NativeCatalog(h.store, b.scope).listMetadata(h.target);
  assert.equal(page.entries.length, 0); assert.equal(page.discoveryCoverage, 'partial'); assert.equal(page.nextCursor, '10');
  const next = await new NativeCatalog(h.store, b.scope).listMetadata(h.target, page.nextCursor);
  assert.equal(next.entries.length, 2); assert.equal(next.orderBasis, 'updated-at');
  assert.ok(seed.candidates[0]!.updatedAt > seed.candidates[1]!.updatedAt && seed.candidates[0]!.lastCompletedAt < seed.candidates[1]!.lastCompletedAt);
  const options = await h.sessions.resolve(b, h.target);
  assert.equal(options.needsClarification, true); assert.equal(options.nextCursor, '10'); assert.ok(options.options.every(option => !option.isDefault));
  await assert.rejects(h.sessions.select(b, h.target, options.options[0]!.optionToken), /HISTORY_DISCOVERY_UNVERIFIED/);
  await assert.rejects(h.sessions.resolve(b, h.target, 'new'), /HISTORY_DISCOVERY_UNVERIFIED/);
  assert.equal(h.store.db.prepare('SELECT count(*) n FROM jobs').get()!.n, 0);
  const explicit = await h.sessions.resolve(h.binding(h.request('new independent request').request_id), h.target, 'new');
  assert.equal(explicit.options[0]!.isDefault, true);
});
test('OFFLINE automatic selection: an informational non-default token is not an execution authorization', async t => {
  const h = configured(setup(t)), b = h.binding(), options = await h.sessions.resolve(b, h.target);
  assert.equal(options.options[0]!.isDefault, false);
  await assert.rejects(h.sessions.select(b, h.target, options.options[0]!.optionToken), /SESSION_EXPLICIT_CHOICE_REQUIRED/);
});
test('OFFLINE complete singleton discovery: verify only that external target before selecting it by completion time', async t => {
  const f = setup(t), h = configured(f), id = randomUUID(), turnId = randomUUID(), root = path.join(f.c.codex.home, 'sessions');
  mkdirSync(root); const completedAt = new Date(h.now() - 1000).toISOString();
  const records = [{ type: 'session_meta', payload: { id, cwd: f.workspace } },
    { type: 'turn_context', payload: { cwd: f.workspace, model: f.c.codex.model, effort: f.c.codex.reasoning } },
    { type: 'event_msg', payload: { type: 'task_started', turn_id: turnId } },
    { type: 'event_msg', timestamp: completedAt, payload: { type: 'task_complete', turn_id: turnId, last_agent_message: 'synthetic unit history' } }];
  const file = path.join(root, id + '.jsonl'); writeFileSync(file, records.map(row => JSON.stringify(row)).join('\n') + '\n');
  const options = await h.sessions.resolve(h.binding(), h.target), selected = options.options.find(row => row.isDefault)!;
  assert.equal(options.needsClarification, false); assert.equal(options.orderBasis, 'last-completed-response');
  assert.equal(selected.nativeId, id); assert.equal(selected.lastResponseAt, Date.parse(completedAt));
  assert.equal(h.store.db.prepare('SELECT last_completed_at FROM native_session_catalog WHERE native_id=?').get(id)!.last_completed_at, Date.parse(completedAt));
  assert.equal(h.store.db.prepare('SELECT count(*) n FROM jobs').get()!.n, 0);
});
