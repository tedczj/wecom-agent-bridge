import test from 'node:test';
import assert from 'node:assert/strict';
import { setup } from '../helpers.ts';
import { initializeHierarchy } from '../../src/orchestration/schema.ts';
import { ControllerRegistry } from '../../src/orchestration/registry.ts';
import { auditTools, type ToolAuditRecord } from '../../src/orchestration/audit.ts';
import { sha256 } from '../../src/orchestration/requests.ts';

test('OFFLINE audit: concurrent callbacks retain invocation order and hashes without bodies', async t => {
  const store = setup(t).store(); initializeHierarchy(store);
  const actor = new ControllerRegistry(store, () => {}).prepare('scope', 'route', 'directory', 'digest');
  let release!: (value: unknown) => void;
  const pending = new Promise(resolve => { release = resolve; });
  const handler = auditTools(store, 'request', actor, 1200, async name => name === 'read_answer_range' ? pending : { headings: ['private title'] });
  const read = () => store.value<ToolAuditRecord[]>('tool-audit:request')!;
  const first = handler('read_answer_range', { answerRef: 'answer', start: 10, limit: 128 }, 'first');
  assert.equal(read()[0]!.status, 'started');
  await handler('read_answer_outline', { answerRef: 'answer' }, 'second');
  assert.deepEqual(read().map(row => row.status), ['started', 'returned']);
  release({ text: 'private answer body' }); await first;
  assert.deepEqual(read().map(row => [row.seq, row.callId, row.status]), [[1, 'first', 'returned'], [2, 'second', 'returned']]);
  assert.equal(read()[0]!.argumentsSha256, sha256(JSON.stringify({ answerRef: 'answer', start: 10, limit: 128 })));
  assert.equal(read()[0]!.resultSha256, sha256(JSON.stringify({ text: 'private answer body' })));
  assert.equal(read()[0]!.start, 10); assert.equal(read()[0]!.limit, 128);
  assert.equal(JSON.stringify(read()).includes('private'), false);
});

test('OFFLINE audit: Bridge envelopes reject raw fields and oversized Unicode projections', async t => {
  const store = setup(t).store(); initializeHierarchy(store);
  const actor = new ControllerRegistry(store, () => {}).prepare('scope', 'bridge', null, 'digest');
  for (const result of [{ shortText: 'ok', raw: 'private answer' }, { shortText: '😀😀😀' }, {}]) {
    const handler = auditTools(store, 'request', actor, 2, async () => result);
    await assert.rejects(handler('route_delegate', {}, 'denied'), /BRIDGE_RESULT_PROJECTION/);
  }
  const envelope = { requestId: 'request', status: 'succeeded', answerRef: 'answer', shortText: '😀😀', recapState: 'ready' };
  const handler = auditTools(store, 'request', actor, 2, async () => envelope);
  assert.deepEqual(await handler('route_delegate', {}, 'accepted'), envelope);
  const rows = store.value<ToolAuditRecord[]>('tool-audit:request')!;
  assert.deepEqual(rows.map(row => row.status), ['denied', 'denied', 'denied', 'returned']);
  assert.equal(rows[3]!.bridgeEnvelopeChecked, true);
  assert.equal(JSON.stringify(rows).includes('private answer'), false);
});

test('OFFLINE audit: exhausted budget rejects before effects and failures keep no error text', async t => {
  const store = setup(t).store(); initializeHierarchy(store);
  const actor = new ControllerRegistry(store, () => {}).prepare('scope', 'route', 'directory', 'digest');
  const handler = auditTools(store, 'request', actor, 1200, async () => { throw new Error('private error text'); });
  await assert.rejects(handler('business_execute', {}, 'failed'), /private error text/);
  const rows = store.value<ToolAuditRecord[]>('tool-audit:request')!;
  assert.equal(rows[0]!.status, 'denied');
  assert.equal(JSON.stringify(rows).includes('private error text'), false);
  store.put('tool-audit:request', Array.from({ length: 256 }, (_, i) => ({ ...rows[0], seq: i + 1 })));
  let calls = 0;
  const exhausted = auditTools(store, 'request', actor, 1200, async () => { calls++; return {}; });
  await assert.rejects(exhausted('business_execute', {}, 'overflow'), /TOOL_AUDIT_LIMIT/);
  assert.equal(calls, 0);
});
test('OFFLINE audit: Bridge and Route share the root budget, including pending calls; another root has its own budget', async t => {
  const store = setup(t).store(); initializeHierarchy(store);
  const registry = new ControllerRegistry(store, () => {}), bridge = registry.prepare('scope', 'bridge', null, 'digest'), route = registry.prepare('scope', 'route', 'directory', 'digest');
  let release!: () => void, effects = 0;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const parent = auditTools(store, 'root', bridge, 1200, async () => { await pending; return {}; }, 1);
  const child = auditTools(store, 'root', route, 1200, async () => { effects++; return {}; }, 1);
  const waiting = parent('list_directories', {}, 'first');
  await assert.rejects(child('business_execute', {}, 'second'), /CONTROLLER_DECISION_LIMIT/);
  assert.equal(effects, 0); release(); await waiting;
  await assert.rejects(child('business_execute', {}, 'third'), /CONTROLLER_DECISION_LIMIT/);
  await auditTools(store, 'different-root', route, 1200, async () => { effects++; return {}; }, 1)('list_business_sessions', {}, 'own');
  assert.equal(effects, 1); assert.equal(store.value<ToolAuditRecord[]>('tool-audit:root')!.length, 1);
});
test('OFFLINE audit: malformed reference and range values never become raw body metadata', async t => {
  const store = setup(t).store(); initializeHierarchy(store);
  const actor = new ControllerRegistry(store, () => {}).prepare('scope', 'route', 'directory', 'digest');
  const handler = auditTools(store, 'request', actor, 1200, async () => { throw Error('invalid arguments'); });
  await assert.rejects(handler('read_answer_range', { answerRef: 'PRIVATE_BODY'.repeat(1000), start: -1, limit: 1000000 }, 'call'));
  const audit = store.value<ToolAuditRecord[]>('tool-audit:request')![0]!;
  assert.equal(audit.answerRef, undefined); assert.equal(audit.start, undefined); assert.equal(audit.limit, undefined);
  assert.equal(JSON.stringify(audit).includes('PRIVATE_BODY'), false);
});
test('OFFLINE audit: Bridge history projection rejects raw fields and records checked bounded responses', async t => {
  const store = setup(t).store(); initializeHierarchy(store);
  const actor = new ControllerRegistry(store, () => {}).prepare('scope', 'bridge', null, 'digest');
  await assert.rejects(auditTools(store, 'search-request', actor, 1200, async () => [{ shortText: 'safe', raw: 'private original' }])
    ('search_interactions', { query: 'word' }, 'search'), /BRIDGE_HISTORY_PROJECTION/);
  for (const value of [[{ shortText: 'ok', original: 'private body' }], [{ shortText: 'too long' }], {}])
    await assert.rejects(auditTools(store, 'request', actor, 2, async () => value)('list_interactions', {}, 'denied'), /BRIDGE_HISTORY_PROJECTION/);
  await auditTools(store, 'request', actor, 2, async () => [{ requestId: 'r', query: 'user input', shortText: 'ok' }])('list_interactions', {}, 'accepted');
  assert.equal(store.value<ToolAuditRecord[]>('tool-audit:request')!.at(-1)!.bridgeProjectionChecked, true);
});
