import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setup, fixture } from '../helpers.ts';
import { normalize } from '../../src/local.ts';
import { initializeHierarchy } from '../../src/orchestration/schema.ts';
import { ControllerManager, type ControllerActor } from '../../src/controllers/manager.ts';
import type { ControllerRuntime, ControllerRef, ControllerToolHandler, ControllerTurn } from '../../src/controllers/runtime.ts';
import type { ControllerAuditEvent } from '../../src/orchestration/registry.ts';
import { invariant } from '../../src/errors.ts';
import { RequestStore } from '../../src/orchestration/requests.ts';

const model = { model: 'gpt-6-sol', reasoning: 'medium' as const, contextWindowTokens: 1000000 };
const bridge: ControllerActor = { scope: 'scope', role: 'bridge', directoryIdentity: null, model, instructions: 'static bridge', tools: [] };
class RuntimeDouble implements ControllerRuntime {
  ref!: ControllerRef; closed = false; instructions = ''; resumed?: string;
  inputs: string[] = []; turns: ControllerTurn[] = [];
  action?: (query: string, handler: ControllerToolHandler, signal?: AbortSignal) => Promise<void>;
  used = (query: string) => query === 'threshold' ? 800000 : 100;
  omitUsage = false;
  async create(generation: number, instructions: string) { this.instructions = instructions; return this.ref = { threadId: randomUUID(), generation }; }
  async resume(ref: ControllerRef, instructions: string, _tools: unknown, expectedTurnId?: string) { this.ref = ref; this.instructions = instructions; this.resumed = expectedTurnId; }
  async run(ref: ControllerRef, query: string, handler: ControllerToolHandler, signal?: AbortSignal): Promise<ControllerTurn> {
    invariant(!this.closed && !signal?.aborted, 'CONTROLLER_CANCELLED'); this.inputs.push(query);
    await this.action?.(query, handler, signal);
    const turnId = randomUUID(), turn: ControllerTurn = { turnId, text: 'final', usage: this.omitUsage ? undefined : {
      threadId: ref.threadId, turnId, usedTokens: this.used(query), contextWindowTokens: 1000000,
      origin: 'runtime', basis: 'last-completed-request-total', validForGeneration: ref.generation, observedAt: Date.now() } };
    this.turns.push(turn); return turn;
  }
  getUsage() { return this.turns.at(-1)?.usage; }
  async interrupt() {}
  async close() { this.closed = true; }
}
const noTools = () => async () => { throw new Error('unexpected tool'); };
test('OFFLINE manager failure audit: only confirmed runtime cleanup produces an ended record', async t => {
  const store = setup(t).store(); initializeHierarchy(store);
  for (const cleanupFails of [false, true]) {
    const runtime = new RuntimeDouble(), requestId = randomUUID();
    runtime.action = async query => { if (query === 'fail') throw Error('turn failed'); };
    runtime.close = async () => { runtime.closed = true; if (cleanupFails) throw Error('cleanup unknown'); };
    const manager = new ControllerManager(store, async () => runtime, 'home', () => {});
    await assert.rejects(manager.run({ ...bridge, scope: requestId, requestId }, 'fail', noTools), cleanupFails ? /cleanup unknown/ : /turn failed/);
    const ended = store.value<{ cleanupConfirmed: boolean; threadId: string; outcome: string }>('controller-ended:bridge:' + requestId);
    if (cleanupFails) assert.equal(ended, undefined);
    else { assert.equal(ended!.cleanupConfirmed, true); assert.equal(ended!.threadId, runtime.ref.threadId); assert.equal(ended!.outcome, 'failed'); }
    await manager.close();
  }
});

test('OFFLINE M3: lazy actors, byte-exact user input and threshold rotation preserve business binding', async t => {
  const f = setup(t), store = f.store(); initializeHierarchy(store);
  const legacy = store.reserve(normalize(fixture(), f.c, 'local:codex'), 'command').job;
  store.complete(legacy.task_id, 'succeeded', 'secret raw answer must never enter a handoff');
  store.db.prepare(`INSERT INTO business_bindings(conversation_scope,directory_identity,backend_home_key,profile_digest,session_key,selection_source,updated_at)
    VALUES ('scope','directory','home','profile',?,'explicit',?)`).run(legacy.session_key, Date.now());
  const before = store.db.prepare('SELECT * FROM business_bindings').all(), runtimes: RuntimeDouble[] = [], events: ControllerAuditEvent[] = [];
  const manager = new ControllerManager(store, async () => { const r = new RuntimeDouble(); runtimes.push(r); return r; }, 'home', event => events.push(event));
  f.cleanups.push(() => manager.close());
  assert.equal(runtimes.length, 0);
  const first = await manager.run(bridge, '  first\r\ne\u0301 ', noTools);
  assert.equal(runtimes[0]!.inputs.length, 2); // independent bootstrap, then exactly one original user query
  assert.equal(runtimes[0]!.inputs[1], '  first\r\ne\u0301 ');
  assert.ok(!runtimes[0]!.instructions.includes('secret raw answer'));
  const threshold = await manager.run(bridge, 'threshold', noTools);
  assert.equal(threshold.session.controller_id, first.session.controller_id);
  assert.equal(threshold.session.state, 'rotate_pending');
  const next = await manager.run(bridge, 'continue', noTools);
  assert.equal(next.session.generation, 1); assert.notEqual(next.session.controller_id, first.session.controller_id);
  assert.equal(runtimes.length, 2); assert.equal(runtimes[0]!.closed, true);
  assert.deepEqual(store.db.prepare('SELECT * FROM business_bindings').all(), before);
  assert.equal(events.find(e => e.event === 'controller.rotate_requested')!.bindingDigest, events.find(e => e.event === 'controller.rotated')!.bindingDigest);
});
test('OFFLINE M3: actor serialization allows parent-child delegation without holding the parent lane', async t => {
  const f = setup(t), store = f.store(); initializeHierarchy(store); const order: string[] = [];
  const route: ControllerActor = { ...bridge, role: 'route', directoryIdentity: 'directory' };
  let manager: ControllerManager;
  manager = new ControllerManager(store, async session => {
    const r = new RuntimeDouble();
    r.action = async (query, handler) => {
      if (query.startsWith('Initialize')) return;
      order.push(session.role + ':' + query);
      if (session.role === 'bridge') await handler('route_delegate', {}, 'call');
    }; return r;
  }, 'home', () => {});
  f.cleanups.push(() => manager.close());
  await Promise.all(['one', 'two'].map(query => manager.run(bridge, query, () => async () => {
    await manager.run(route, query, noTools); return { status: 'completed' };
  })));
  assert.deepEqual(order, ['bridge:one', 'route:one', 'bridge:two', 'route:two']);
  assert.equal(store.db.prepare('SELECT count(*) n FROM controller_sessions').get()!.n, 2);
});
test('OFFLINE M3: restart resumes matching native turn; configuration changes get a new generation', async t => {
  const f = setup(t), store = f.store(); initializeHierarchy(store);
  let runtime = new RuntimeDouble();
  const first = new ControllerManager(store, async () => runtime, 'home', () => {});
  const result = await first.run(bridge, 'one', noTools); await first.close();
  runtime = new RuntimeDouble();
  const second = new ControllerManager(store, async () => runtime, 'home', () => {}); f.cleanups.push(() => second.close());
  const resumed = await second.run(bridge, 'two', noTools);
  assert.equal(resumed.session.controller_id, result.session.controller_id);
  assert.equal(runtime.resumed, result.turn.turnId); assert.deepEqual(runtime.inputs, ['two']);
  const replacement = new RuntimeDouble();
  await second.close();
  const third = new ControllerManager(store, async () => replacement, 'home', () => {}); f.cleanups.push(() => third.close());
  const changed = await third.run({ ...bridge, model: { ...model, reasoning: 'high' } }, 'three', noTools);
  assert.equal(changed.session.generation, 1);
});
test('OFFLINE management policy: instruction and tool changes rotate at the next request without changing business bindings', async t => {
  const f = setup(t), store = f.store(); initializeHierarchy(store);
  const business = store.reserve(normalize(fixture(), f.c, 'local:codex'), 'command').job;
  store.complete(business.task_id, 'succeeded', 'private business answer');
  store.db.prepare(`INSERT INTO business_bindings(conversation_scope,directory_identity,backend_home_key,profile_digest,session_key,selection_source,updated_at)
    VALUES ('scope','directory','home','profile',?,'explicit',?)`).run(business.session_key, Date.now());
  const runtimes: RuntimeDouble[] = [], events: ControllerAuditEvent[] = [];
  const manager = new ControllerManager(store, async () => { const runtime = new RuntimeDouble(); runtimes.push(runtime); return runtime; }, 'home', event => events.push(event));
  t.after(() => manager.close());
  const first = await manager.run(bridge, 'one', noTools), before = store.db.prepare('SELECT * FROM business_bindings').all();
  const reused = await manager.run(bridge, 'two', noTools); assert.equal(reused.session.controller_id, first.session.controller_id);
  const changedInstructions = { ...bridge, instructions: 'updated static policy' };
  const next = await manager.run(changedInstructions, 'three', noTools); assert.equal(next.session.generation, 1); assert.equal(runtimes[0]!.closed, true);
  const changedTools = { ...changedInstructions, tools: [{ name: 'list', description: 'bounded history', inputSchema: { type: 'object', properties: {} } }] };
  const last = await manager.run(changedTools, 'four', noTools); assert.equal(last.session.generation, 2);
  assert.deepEqual(store.db.prepare('SELECT * FROM business_bindings').all(), before);
  assert.deepEqual(events.filter(e => e.event === 'controller.rotated').map(e => e.reason), ['config_changed', 'config_changed']);
  assert.equal(runtimes.length, 3); assert.equal(runtimes[2]!.inputs.filter(q => q === 'four').length, 1);
});
test('OFFLINE M3: unknown usage forbids a second user turn and bootstrap overflow does not loop', async t => {
  const f = setup(t), store = f.store(); initializeHierarchy(store); let creates = 0;
  const runtime = new RuntimeDouble();
  const manager = new ControllerManager(store, async () => { creates++; return runtime; }, 'home', () => {}); f.cleanups.push(() => manager.close());
  await manager.run(bridge, 'one', noTools); runtime.omitUsage = true;
  await manager.run(bridge, 'two', noTools);
  await assert.rejects(manager.run(bridge, 'three', noTools), /CONTROLLER_USAGE_UNAVAILABLE/);
  assert.equal(creates, 1); assert.equal(runtime.inputs.at(-1), 'two');
  const huge = new RuntimeDouble(); huge.used = () => 800000;
  const other = new ControllerManager(store, async () => { creates++; return huge; }, 'home', () => {}); f.cleanups.push(() => other.close());
  await assert.rejects(other.run({ ...bridge, scope: 'another' }, 'work', noTools), /HANDOFF_OVERSIZED/);
  assert.equal(creates, 2); assert.equal(huge.inputs.length, 1); assert.equal(huge.closed, true);
});
test('OFFLINE M3: failed replacement preserves the old current generation and its bindings', async t => {
  const f = setup(t), store = f.store(); initializeHierarchy(store); let created = 0;
  const manager = new ControllerManager(store, async () => { const r = new RuntimeDouble(); if (++created === 2) r.omitUsage = true; return r; }, 'home', () => {});
  f.cleanups.push(() => manager.close());
  const old = await manager.run(bridge, 'threshold', noTools);
  await assert.rejects(manager.run(bridge, 'next', noTools), /CONTROLLER_USAGE_UNAVAILABLE/);
  assert.equal(manager.registry.current(old.session.logical_key)!.controller_id, old.session.controller_id);
  assert.equal(manager.registry.current(old.session.logical_key)!.state, 'rotate_pending');
});
test('OFFLINE M3: restart marks interrupted planning terminal and only a new request starts recovery generation', async t => {
  const f = setup(t), store = f.store(); initializeHierarchy(store);
  const requests = new RequestStore(store), request = requests.accept(normalize(fixture('old request'), f.c, 'local:codex')).request;
  requests.transition(request.request_id, request.conversation_scope, ['accepted'], 'bridge_planning');
  const runtimes: RuntimeDouble[] = [], manager = new ControllerManager(store, async () => { const runtime = new RuntimeDouble(); runtimes.push(runtime); return runtime; }, 'home', () => {});
  const actor = { ...bridge, scope: request.conversation_scope }, old = await manager.run(actor, 'first', noTools);
  await manager.close();
  store.db.prepare("UPDATE controller_sessions SET state='running' WHERE controller_id=?").run(old.session.controller_id);
  const recovered = new ControllerManager(store, async () => { const runtime = new RuntimeDouble(); runtimes.push(runtime); return runtime; }, 'home', () => {});
  f.cleanups.push(() => recovered.close());
  assert.deepEqual(recovered.recover(), { controllers: 1, requests: [request.request_id] });
  assert.equal(requests.get(request.request_id, request.conversation_scope).phase, 'interrupted');
  assert.equal(runtimes.length, 1); // Reconciliation alone never calls a runtime.
  const next = await recovered.run(actor, 'new independent request', noTools);
  assert.equal(next.session.generation, 1);
  assert.equal(runtimes[1]!.inputs.at(-1), 'new independent request');
  assert.equal(runtimes.flatMap(r => r.inputs).filter(q => q === 'old request').length, 0);
});
