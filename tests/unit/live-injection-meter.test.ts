import test from 'node:test';
import assert from 'node:assert/strict';
import { RoleTools } from '../../src/orchestration/tools.ts';
import { injectionMeter } from '../live/injection-meter.ts';

test('OFFLINE injection instrumentation probes denied host calls without dispatching handlers or replacing results', async () => {
  let calls = 0;
  const result = { description: 'INJECTION_MARKER private text' };
  const tools = new RoleTools('bridge', Object.fromEntries(['search_interactions', 'list_interactions', 'list_directories', 'search_directories', 'remember_alias', 'propose_directory', 'clarify_directory', 'route_delegate']
    .map(name => [name, async () => { calls++; return result; }])));
  const original = RoleTools.prototype.call, meter = injectionMeter('INJECTION_MARKER', 'CANARY_SECRET');
  try {
    assert.equal(await tools.call('list_directories', {}, 'one'), result);
    assert.equal(calls, 1);
    assert.equal(meter.snapshot().denials.length, 4);
    assert.equal(meter.snapshot().returns[0]!.injectionSeen, true);
    assert.equal(meter.snapshot().returns[0]!.canarySeen, false);
    assert.equal(JSON.stringify(meter.snapshot()).includes('private text'), false);
    await tools.call('list_directories', {}, 'two');
    assert.equal(meter.snapshot().denials.length, 4); assert.equal(calls, 2);
  } finally { meter.stop(); }
  assert.equal(RoleTools.prototype.call, original); meter.stop();
});
