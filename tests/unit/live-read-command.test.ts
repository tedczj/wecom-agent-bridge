import test from 'node:test';
import assert from 'node:assert/strict';
import { readCommand } from '../live/read-command.ts';
import { inspectContextRecords } from '../live/native-context.ts';

const command = "rg -n '^# ' README.md";
const code = `const r = await tools.exec_command({cmd:${JSON.stringify(command)},max_output_tokens:1000}); text(r.output);`;
test('OFFLINE read audit grammar: only fixed README commands with literal arguments and one output', () => {
  assert.equal(readCommand(code), command);
  const located = code.replace('max_output_tokens:1000', 'workdir:"/fixture",max_output_tokens:1000');
  assert.equal(readCommand(located, '/fixture'), command); assert.equal(readCommand(located, '/foreign'), undefined); assert.equal(readCommand(located), undefined);
  for (const source of [code + ' fetch("https://example.com");', code.replace('README.md', 'README.md; git push'),
    code.replace('max_output_tokens:1000', 'workdir:"/outside"'), code.replace('max_output_tokens:1000', 'sandbox_permissions:"require_escalated"'),
    code.replace('r.output', 'r.output.toString()'), code.replace('const r', 'const tools'), code.replace('await tools', 'await other'),
    code.replace('max_output_tokens:1000', '...options'), code.replace('text(r.output)', 'tools.send(r.output)')]) assert.equal(readCommand(source), undefined);
});
test('OFFLINE read audit: requires fresh native readonly policy, matching mirror and paired completed turn', () => {
  const policy = { type: 'turn_context', payload: { cwd: '/fixture', sandbox_policy: { type: 'read-only' },
    permission_profile: { type: 'managed', network: 'restricted', file_system: { type: 'restricted', entries: [{ path: { type: 'special', value: { kind: 'root' } }, access: 'read' }] } } } };
  const call = { type: 'response_item', payload: { type: 'custom_tool_call', call_id: 'call', name: 'exec', input: code } };
  const mirror = { type: 'event_msg', payload: { type: 'item_completed', item: { type: 'CommandExecution', id: 'exec-id',
    command: ['/bin/zsh', '-lc', command], cwd: 'file:///fixture', status: 'completed', exit_code: 0 } } };
  const output = { type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'call', output: '1:# fixture' } };
  const audit = (rows: unknown[]) => inspectContextRecords([
    { type: 'session_meta', payload: {} }, { type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn' } },
    ...rows, { type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn' } },
  ].map(row => JSON.stringify(row)).join('\n') + '\n', 'nonce', '/fixture').execution;
  const good = audit([policy, call, mirror, output]); assert.equal(good.noToolExecution, false); assert.equal(good.noRemoteActions, true); assert.equal(good.readOnlyCommandRecords, 2);
  assert.equal(JSON.stringify(good).includes(command), false);
  for (const rows of [[call, mirror, output], [policy, call, output], [policy, mirror, call, output], [policy, call, mirror],
    [policy, call, mirror, mirror, output], [policy, call, mirror, output, output],
    [policy, call, { ...mirror, payload: { ...mirror.payload, item: { ...mirror.payload.item, cwd: 'file:///other' } } }, output],
    [policy, call, { ...mirror, payload: { ...mirror.payload, item: { ...mirror.payload.item, exit_code: 1 } } }, output],
    [{ ...policy, payload: { ...policy.payload, permission_profile: { ...policy.payload.permission_profile, network: 'enabled' } } }, call, mirror, output],
    [{ ...policy, payload: { ...policy.payload, permission_profile: { ...policy.payload.permission_profile,
      file_system: { ...policy.payload.permission_profile.file_system, entries: [{ path: { type: 'special', value: { kind: 'root' } }, access: 'write' }] } } } }, call, mirror, output]])
    assert.equal(audit(rows).noRemoteActions, false);
});
