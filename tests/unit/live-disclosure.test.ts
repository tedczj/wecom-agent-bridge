import test from 'node:test';
import assert from 'node:assert/strict';
import { setup, fixture } from '../helpers.ts';
import { bridgeDisclosure } from '../live/bridge-disclosure.ts';
import { initializeHierarchy } from '../../src/orchestration/schema.ts';
import { RequestStore } from '../../src/orchestration/requests.ts';
import { normalize } from '../../src/local.ts';

test('OFFLINE disclosure oracle: missing native/serialization evidence stays incomplete', t => {
  const store = setup(t).store();
  assert.equal(bridgeDisclosure(store, ['request']).complete, false);
  assert.equal(bridgeDisclosure(store, []).pass, false);
});
test('OFFLINE disclosure oracle: a completed no-tool turn needs matching native policy; a completed flag alone is insufficient', t => {
  const store = setup(t).store(), id = 'request';
  const turn = { controllerId: 'controller', threadId: 'thread', turnId: 'turn', policyVerified: true };
  store.put('controller-turn:bridge:' + id, turn);
  assert.equal(bridgeDisclosure(store, [id]).complete, false);
  const policy = { kind: 'policy', role: 'bridge', controllerId: 'controller', requestId: id, threadId: 'thread', turnId: 'turn', valid: true,
    evidence: { threadId: 'thread', turnId: 'turn', toolNames: ['list_interactions'], dynamicToolsOnly: true, nativeAutoCompaction: 'disabled' } };
  store.put('controller-policy-wire:bridge:' + id, policy); assert.equal(bridgeDisclosure(store, [id]).pass, true);
  for (const changed of [{ ...policy, valid: false }, { ...policy, turnId: 'old' }, { ...policy, evidence: { ...policy.evidence, toolNames: ['read_file'] } }]) {
    store.put('controller-policy-wire:bridge:' + id, changed); assert.equal(bridgeDisclosure(store, [id]).pass, false);
  }
});
test('OFFLINE disclosure oracle: aborted turns require actual policy, terminal request, cleanup and settled audit entries', t => {
  const f = setup(t), store = f.store(); initializeHierarchy(store);
  const requests = new RequestStore(store), request = requests.accept(normalize(fixture('work'), f.c, 'local:codex')).request, id = request.request_id;
  const policy = { kind: 'policy', role: 'bridge', controllerId: 'controller', requestId: id, threadId: 'thread', turnId: 'turn', valid: true,
    evidence: { threadId: 'thread', turnId: 'turn', toolNames: ['route_delegate'], toolSchemasSha256: 'a'.repeat(64), dynamicToolsOnly: true, nativeAutoCompaction: 'disabled' } };
  const ended = { controllerId: 'controller', threadId: 'thread', cleanupConfirmed: true, outcome: 'failed' };
  const audit = { role: 'bridge', controllerId: 'controller', tool: 'route_delegate', callId: 'call', status: 'denied' };
  store.put('controller-policy-wire:bridge:' + id, policy); store.put('controller-ended:bridge:' + id, ended); store.put('tool-audit:' + id, [audit]);
  assert.equal(bridgeDisclosure(store, [id]).complete, false);
  requests.transition(id, request.conversation_scope, ['accepted'], 'cancelled');
  assert.equal(bridgeDisclosure(store, [id]).pass, true);
  store.put('controller-ended:bridge:' + id, { ...ended, cleanupConfirmed: false }); assert.equal(bridgeDisclosure(store, [id]).complete, false);
  store.put('controller-ended:bridge:' + id, ended);
  for (const changed of [{ ...audit, status: 'started' }, { ...audit, controllerId: 'foreign' }]) {
    store.put('tool-audit:' + id, [changed]); assert.equal(bridgeDisclosure(store, [id]).pass, false);
  }
  store.put('tool-audit:' + id, [audit]); store.put('controller-policy-wire:bridge:' + id, { ...policy, valid: false });
  assert.equal(bridgeDisclosure(store, [id]).pass, false);
  store.put('controller-turn:bridge:' + id, { controllerId: 'controller', threadId: 'thread', turnId: 'turn', policyVerified: true });
  store.put('controller-tool-wire:bridge:' + id, []);
  assert.equal(bridgeDisclosure(store, [id]).pass, false); // A completed flag cannot override revoked policy evidence.
});
test('OFFLINE disclosure oracle: matched restricted turn, projection and wire hashes are all required', t => {
  const store = setup(t).store(), id = 'request';
  const turn = { controllerId: 'controller', threadId: 'thread', turnId: 'turn', policyVerified: true };
  const audit = { seq: 1, role: 'bridge', controllerId: 'controller', generation: 0, tool: 'route_delegate', callId: 'call',
    argumentsSha256: 'args', resultSha256: 'result', status: 'returned', bridgeEnvelopeChecked: true };
  const wire = { kind: 'tool-result', role: 'bridge', ...turn, requestId: id, callId: 'call', tool: 'route_delegate', resultSha256: 'result' };
  store.put('controller-turn:bridge:' + id, turn); store.put('tool-audit:' + id, [audit]); store.put('controller-tool-wire:bridge:' + id, [wire]);
  assert.equal(bridgeDisclosure(store, [id]).pass, true);
  for (const changed of [{ ...wire, resultSha256: 'different' }, { ...wire, turnId: 'old' }, { ...wire, controllerId: 'foreign' }]) {
    store.put('controller-tool-wire:bridge:' + id, [changed]); assert.equal(bridgeDisclosure(store, [id]).pass, false);
  }
  store.put('controller-tool-wire:bridge:' + id, [wire]); store.put('tool-audit:' + id, [{ ...audit, bridgeEnvelopeChecked: false }]);
  assert.equal(bridgeDisclosure(store, [id]).pass, false);
  store.put('tool-audit:' + id, [audit]); store.put('controller-turn:bridge:' + id, { ...turn, policyVerified: false });
  assert.equal(bridgeDisclosure(store, [id]).pass, false);
});
