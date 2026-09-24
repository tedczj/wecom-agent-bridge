import test from 'node:test';
import assert from 'node:assert/strict';
import { addedFiles, addedFilesMatch } from '../live/patch-effects.ts';
import { inspectContextRecords } from '../live/native-context.ts';

const patch = '*** Begin Patch\n*** Add File: one.txt\n+PRIVATE_CONTENT\n*** End Patch';
test('OFFLINE patch effect plan: only scoped add files, with exact content hashes', () => {
  const files = addedFiles(patch, '/fixture')!;
  assert.equal(files.length, 1); assert.equal(files[0]!.path, '/fixture/one.txt'); assert.equal(JSON.stringify(files).includes('PRIVATE_CONTENT'), false);
  assert.equal(addedFilesMatch(files, { '/fixture/one.txt': { type: 'add', content: 'PRIVATE_CONTENT\n' } }), true);
  assert.equal(addedFilesMatch(files, { '/fixture/one.txt': { type: 'add', content: 'different' } }), false);
  assert.equal(addedFilesMatch(files, { '/outside/one.txt': { type: 'add', content: 'PRIVATE_CONTENT\n' } }), false);
  for (const value of [patch.replace('one.txt', '../outside'), patch.replace('one.txt', '/outside/file'), patch.replace('one.txt', '.git/config'),
    patch.replace('one.txt', '.codex/config.toml'), patch.replace('Add File', 'Delete File'), patch.replace('*** End Patch', '*** Add File: ONE.txt\n+again\n*** End Patch')])
    assert.equal(addedFiles(value, '/fixture'), undefined);
});
test('OFFLINE native patch evidence still needs physical file checks; unknown mirrors/policy never prove remote safety', () => {
  const context = { type: 'turn_context', payload: { cwd: '/fixture', permission_profile: { type: 'managed', network: 'restricted',
    file_system: { type: 'restricted', entries: [{ path: { type: 'path', path: '/fixture' }, access: 'write' }] } } } };
  const call = { type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: 'call', input: `text(await tools.apply_patch(${JSON.stringify(patch)}));` } };
  const mirror = { type: 'event_msg', payload: { type: 'item_completed', item: { type: 'FileChange', id: 'patch', status: 'completed', changes: { '/fixture/one.txt': { type: 'add', content: 'PRIVATE_CONTENT\n' } } } } };
  const output = { type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'call', output: 'done' } };
  const check = (rows: unknown[]) => inspectContextRecords([{ type: 'session_meta', payload: {} },
    { type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn' } }, ...rows,
    { type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn' } },
  ].map(row => JSON.stringify(row)).join('\n') + '\n', 'nonce', '/fixture').execution;
  const result = check([context, call, mirror, output]);
  assert.equal(result.localPatchRecords, 2); assert.equal(result.classifiedActionsComplete, true); assert.equal(result.noRemoteActions, false);
  for (const rows of [[call, mirror, output], [context, call, output], [context, call, mirror, mirror, output],
    [{ ...context, payload: { ...context.payload, permission_profile: { ...context.payload.permission_profile, network: 'enabled' } } }, call, mirror, output],
    [context, call, { ...mirror, payload: { ...mirror.payload, item: { ...mirror.payload.item, changes: { '/outside/file': { type: 'add', content: 'PRIVATE_CONTENT\n' } } } } }, output]])
    assert.equal(check(rows).classifiedActionsComplete, false);
});
