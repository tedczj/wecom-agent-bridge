import test from 'node:test';
import assert from 'node:assert/strict';
import { RoleTools, type ToolHandlers } from '../../src/orchestration/tools.ts';
import { identityMeter } from '../live/identity-meter.ts';

const shared = ['search_interactions', 'list_interactions'];
const bridge = ['list_directories', 'search_directories', 'remember_alias', 'propose_directory', 'clarify_directory', 'route_delegate'];
const route = ['list_business_models', 'resolve_business_options', 'select_business_session', 'business_execute', 'list_business_sessions', 'read_business_session', 'read_answer_outline', 'read_answer_range'];
function handlers(names: string[], call: (name: string, args: unknown) => unknown): ToolHandlers {
  return Object.fromEntries(names.map(name => [name, async (args: unknown) => call(name, args)]));
}
test('OFFLINE M4: schemas exclude query/context/identity in delegation and Bridge has no raw read surface', async () => {
  const calls: unknown[] = [];
  const b = new RoleTools('bridge', handlers([...shared, ...bridge], (name, args) => { calls.push({ name, args }); return {}; }));
  const r = new RoleTools('route', handlers([...shared, ...route], (name, args) => { calls.push({ name, args }); return {}; }));
  assert.deepEqual(b.definitions.map(d => d.name), [...shared, ...bridge]);
  assert.equal(JSON.stringify(b.definitions).includes('read_answer_'), false);
  for (const key of ['query', 'text', 'prompt', 'history', 'routingContext', 'rewrittenQuery', 'requestId', 'scope', 'generation']) {
    await assert.rejects(b.call('route_delegate', { directoryRef: 'dir', intentKind: 'work', [key]: 'rewritten' }, 'call'), /CONTROLLER_TOOL_ARGUMENTS/);
    await assert.rejects(r.call('business_execute', { selectionToken: 'selection', [key]: 'rewritten' }, 'call'), /CONTROLLER_TOOL_ARGUMENTS/);
  }
  await assert.rejects(b.call('read_answer_range', { answerRef: 'answer', start: 0 }, 'call'), /CONTROLLER_TOOL_DENIED/);
  await assert.rejects(r.call('route_delegate', { directoryRef: 'dir', intentKind: 'work' }, 'call'), /CONTROLLER_TOOL_DENIED/);
  assert.equal(calls.length, 0);
  await b.call('route_delegate', { directoryRef: 'dir', intentKind: 'work' }, 'call');
  await r.call('business_execute', { selectionToken: 'selection' }, 'call');
  assert.equal(calls.length, 2);
});
test('OFFLINE M4: tool input limits and extra handlers fail before touching host state', async () => {
  const r = new RoleTools('route', handlers([...shared, ...route], () => { throw new Error('should not run'); }));
  for (const definition of r.definitions) for (const [key, field] of Object.entries(definition.inputSchema.properties as Record<string, { type: string; minimum?: number; maximum?: number; maxLength?: number }>)) {
    assert.ok(definition.description.includes(field.type === 'integer' ? `${key}: integer ${field.minimum}..${field.maximum}` : `${key}: at most ${field.maxLength} characters`));
  }
  for (const args of [{ answerRef: 'a', start: -1 }, { answerRef: 'a', start: 0, limit: 16385 }, { answerRef: 'a', start: 0.5 }])
    await assert.rejects(r.call('read_answer_range', args, 'call'), /CONTROLLER_TOOL_ARGUMENTS/);
  await assert.rejects(r.call('list_interactions', { scope: 'conversation', limit: 31 }, 'call'), /CONTROLLER_TOOL_ARGUMENTS/);
  for (const args of [{ query: 'word', scope: 'foreign' }, { query: 'x'.repeat(257) }, { query: 'word', limit: 31 }])
    await assert.rejects(r.call('search_interactions', args, 'call'), /CONTROLLER_TOOL_ARGUMENTS/);
  assert.throws(() => new RoleTools('bridge', handlers([...shared, ...bridge, 'read_answer_range'], () => ({}))), /CONTROLLER_TOOL_HANDLERS/);
});
test('OFFLINE identity instrumentation: forged fields are rejected before the real handler; valid scope selectors still work', async () => {
  const original = RoleTools.prototype.call, meter = identityMeter(); let calls = 0;
  try {
    const b = new RoleTools('bridge', handlers([...shared, ...bridge], () => { calls++; return {}; }));
    const r = new RoleTools('route', handlers([...shared, ...route], () => { calls++; return {}; }));
    await b.call('list_interactions', { scope: 'conversation' }, 'bridge');
    await r.call('business_execute', { selectionToken: 'selection' }, 'route');
    assert.equal(calls, 2); assert.equal(meter.snapshot().length, 8);
    assert.ok(meter.snapshot().every(row => row.code === 'CONTROLLER_TOOL_ARGUMENTS'));
    await b.call('list_directories', {}, 'again'); assert.equal(calls, 3); assert.equal(meter.snapshot().length, 8);
    assert.throws(() => identityMeter(), /LIVE_METER_ALREADY_INSTALLED/);
  } finally { meter.stop(); }
  assert.equal(RoleTools.prototype.call, original); meter.stop();
});
