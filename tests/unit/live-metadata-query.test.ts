import test from 'node:test';
import assert from 'node:assert/strict';
import { isMetadataQuery } from '../live/metadata-query.ts';
import { inspectContextRecords } from '../live/native-context.ts';

const query = 'const x = ALL_TOOLS.filter(x => /session|business/i.test(x.name+" "+x.description)); text(x);';
test('OFFLINE metadata query audit accepts only a complete local metadata expression', () => {
  assert.equal(isMetadataQuery(query), true);
  for (const code of [query + ' fetch("https://example.com");', query + ' await tools.exec_command({cmd:"pwd"});',
    query.replace('x.name', 'x.name.toString()'), query.replace('x.name', 'x["name"]'),
    query.replace('x.name', 'x.constructor'), query.replace('x =>', '(x = fetch("x")) =>'),
    query.replace('text(x)', 'tools.exec_command(x)'), query.replace('const x', 'const text'),
    query.replace('x =>', 'async x =>'), query.replace('x.name', '(fetch("x"), x.name)'),
    query.replace('ALL_TOOLS.filter', 'other.filter'), query.replace('const x', 'let x'),
    query.replace('x => /session|business/i.test(x.name+" "+x.description)', 'x => { fetch("x"); return true; }'),
    query + ' invalid @ syntax']) assert.equal(isMetadataQuery(code), false, code);
});
test('OFFLINE metadata audit requires paired native call/output in one turn and keeps tool execution explicit', () => {
  const call = { type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: 'call', input: query } };
  const output = { type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'call', output: 'local metadata' } };
  const inspect = (rows: unknown[]) => inspectContextRecords([
    { type: 'session_meta', payload: {} }, { type: 'event_msg', payload: { type: 'task_started', turn_id: 'one' } },
    ...rows, { type: 'event_msg', payload: { type: 'task_complete', turn_id: 'one' } },
  ].map(row => JSON.stringify(row)).join('\n') + '\n', 'nonce').execution;
  assert.deepEqual(inspect([call, output]), { toolRecords: 2, unclassifiedRecords: 0, metadataOnlyRecords: 2, readOnlyCommandRecords: 0, readOnlyCommands: [],
    localPatchRecords: 0, localPatches: [], classifiedActionsComplete: true, scopedCommandRecords: 0, scopedCommands: [], syntaxRejectedRecords: 0, noToolExecution: false, noRemoteActions: true });
  for (const rows of [[call], [output], [output, call], [call, output, output], [call, call, output],
    [call, output, { type: 'response_item', payload: { type: 'function_call', name: 'exec_command' } }],
    [{ ...call, payload: { ...call.payload, input: query + ' await tools.exec_command({cmd:"pwd"});' } }, output]]) {
    assert.equal(inspect(rows).noRemoteActions, false);
  }
});
