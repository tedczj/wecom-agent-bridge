import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectContextRecords } from '../live/native-context.ts';

test('OFFLINE scoped command pairing requires every mirror/output and keeps Git pending physical verification', () => {
  const policy = { type: 'turn_context', payload: { cwd: '/fixture', sandbox_policy: { type: 'read-only' }, permission_profile: {
    type: 'managed', network: 'restricted', file_system: { type: 'restricted', entries: [{ path: { type: 'special', value: { kind: 'root' } }, access: 'read' }] } } } };
  const call = { type: 'response_item', payload: { type: 'custom_tool_call', call_id: 'call', name: 'exec',
    input: 'const r=await Promise.all([tools.exec_command({cmd:"cat README.md"}),tools.exec_command({cmd:"ls -l missing.txt"})]);for(const x of r)text(x);' } };
  const mirror = (cmd: string, id: string, exit: number) => ({ type: 'event_msg', payload: { type: 'item_completed', item: { type: 'CommandExecution', id,
    command: ['/bin/zsh', '-lc', cmd], cwd: 'file:///fixture', status: exit === 0 ? 'completed' : 'failed', exit_code: exit } } });
  const first = mirror('cat README.md', 'one', 0), second = mirror('ls -l missing.txt', 'two', 1);
  const output = { type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'call', output: 'results' } };
  const audit = (rows: unknown[]) => inspectContextRecords([{ type: 'session_meta', payload: {} }, { type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn' } },
    ...rows, { type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn' } }].map(row => JSON.stringify(row)).join('\n') + '\n', 'nonce', '/fixture').execution;
  const good = audit([policy, call, second, first, output]);
  assert.equal(good.noRemoteActions, true); assert.equal(good.scopedCommandRecords, 2); assert.equal(good.scopedCommands?.length, 2);
  for (const rows of [[call, first, second, output], [policy, call, first, output], [policy, call, first, second], [policy, call, first, second, second, output],
    [policy, call, first, output, second], [policy, call, first, mirror('ls -l another.txt', 'two', 1), output]]) assert.equal(audit(rows).noRemoteActions, false);
  const gitCall = { ...call, payload: { ...call.payload, input: 'text(await tools.exec_command({cmd:"git status --short"}));' } };
  const gitAudit = audit([policy, gitCall, mirror('git status --short', 'git', 0), output]);
  assert.equal(gitAudit.classifiedActionsComplete, true); assert.equal(gitAudit.noRemoteActions, false);
  const once = "printf '%s\\n' '00000000-0000-0000-0000-000000000000' > once.txt && cat once.txt";
  const onceCall = { ...call, payload: { ...call.payload, input: `text(await tools.exec_command({cmd:${JSON.stringify(once)}}));` } };
  assert.equal(audit([policy, onceCall, mirror(once, 'once', 0), output]).classifiedActionsComplete, false);
  const writable = { ...policy, payload: { ...policy.payload, permission_profile: { ...policy.payload.permission_profile,
    file_system: { type: 'restricted', entries: [{ path: { type: 'path', path: '/fixture' }, access: 'write' }] } } } };
  const pendingWrite = audit([writable, onceCall, mirror(once, 'once', 0), output]);
  assert.equal(pendingWrite.classifiedActionsComplete, true); assert.equal(pendingWrite.noRemoteActions, false);
});
