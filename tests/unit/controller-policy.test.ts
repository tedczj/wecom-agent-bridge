import test from 'node:test';
import assert from 'node:assert/strict';
import { controllerPolicyEvidence } from '../../src/controllers/policy.ts';
import { sha256 } from '../../src/orchestration/requests.ts';

const tool = { name: 'read', description: 'Read', inputSchema: { type: 'object', properties: {}, additionalProperties: false } };
const valid = () => ({ version: 1, turnId: 'turn', dynamicToolsOnly: true, nativeAutoCompaction: 'disabled',
  tools: [{ type: 'function', name: 'read', parameters: tool.inputSchema }] });
test('OFFLINE controller policy: exact native tool names/schemas are reduced to bounded hashes', () => {
  const policy = valid();
  assert.deepEqual(controllerPolicyEvidence(policy, 'thread', 'turn', [tool]), { threadId: 'thread', turnId: 'turn', toolNames: ['read'],
    toolSchemasSha256: sha256(JSON.stringify(policy.tools)), dynamicToolsOnly: true, nativeAutoCompaction: 'disabled' });
  assert.deepEqual(controllerPolicyEvidence({ ...policy, tools: [] }, 'thread', 'turn', []).toolNames, []);
});
test('OFFLINE controller policy: stale turn, builtin tool, missing tool, changed schema and compaction claims reject', () => {
  const policy = valid();
  for (const invalid of [{ ...policy, turnId: 'old' }, { ...policy, nativeAutoCompaction: 'enabled' }, { ...policy, dynamicToolsOnly: false },
    { ...policy, tools: [] }, { ...policy, tools: [...policy.tools, { type: 'function', name: 'exec_command' }] },
    { ...policy, tools: [{ type: 'function', name: 'read', parameters: { type: 'object' } }] }])
    assert.throws(() => controllerPolicyEvidence(invalid, 'thread', 'turn', [tool]), /CONTROLLER_POLICY_INVALID/);
});
test('OFFLINE controller policy: pinned schema projection omits only host-enforced flat field bounds', () => {
  const bounded = { ...tool, inputSchema: { type: 'object', properties: { value: { type: 'string', maxLength: 16, enum: ['a', 'b'] },
    limit: { type: 'integer', minimum: 4, maximum: 16384 } }, required: ['value'], additionalProperties: false } };
  const parameters = { type: 'object', properties: { value: { type: 'string', enum: ['a', 'b'] }, limit: { type: 'integer' } }, required: ['value'], additionalProperties: false };
  const policy = { ...valid(), tools: [{ type: 'function', name: 'read', parameters }] };
  assert.equal(controllerPolicyEvidence(policy, 'thread', 'turn', [bounded]).toolSchemasSha256, sha256(JSON.stringify(policy.tools)));
  assert.equal(bounded.inputSchema.properties.value.maxLength, 16);
  assert.throws(() => controllerPolicyEvidence({ ...policy, tools: [{ ...policy.tools[0], parameters: { ...parameters, additionalProperties: true } }] }, 'thread', 'turn', [bounded]), /CONTROLLER_POLICY_INVALID/);
});
