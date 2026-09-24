import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectContextRecords, nonceAnswerClaim } from '../live/native-context.ts';
import { sha256 } from '../../src/orchestration/requests.ts';

const jsonl = (rows: unknown[]) => rows.map(row => JSON.stringify(row)).join('\n') + '\n';
const turn = (id: string, text: string) => [
  { type: 'event_msg', payload: { type: 'task_started', turn_id: id } },
  { type: 'event_msg', payload: { type: 'user_message', message: text } },
  { type: 'event_msg', payload: { type: 'task_complete', turn_id: id, last_agent_message: 'done' } },
];
test('OFFLINE native context oracle: records ordered completed input hashes without exposing transcript text', () => {
  const text = jsonl([{ type: 'session_meta', payload: { id: 'id' } }, ...turn('one', 'remember SECRET_NONCE'), ...turn('two', 'continue')]);
  const audit = inspectContextRecords(text, 'SECRET_NONCE');
  assert.deepEqual(audit.inputs, [{ turnId: 'one', textSha256: sha256('remember SECRET_NONCE'), completed: true }, { turnId: 'two', textSha256: sha256('continue'), completed: true }]);
  assert.equal(audit.noncePresent, true); assert.equal(audit.inheritedContext, false);
  assert.equal(JSON.stringify(audit).includes('SECRET_NONCE'), false);
});
test('OFFLINE native context oracle: inherited context, hidden-field nonce and partial/active records cannot prove fresh isolation', () => {
  const fresh = [{ type: 'session_meta', payload: { id: 'new' } }, ...turn('new-turn', 'fresh input')];
  assert.equal(inspectContextRecords(jsonl(fresh), 'SECRET_NONCE').noncePresent, false);
  assert.equal(inspectContextRecords(jsonl([{ type: 'session_meta', payload: { forked_from_id: 'old' } }, ...turn('new-turn', 'fresh input')]), 'SECRET_NONCE').inheritedContext, true);
  assert.equal(inspectContextRecords(jsonl([...fresh, { type: 'world_state', payload: { state: { text: 'SECRET_NONCE' } } }]), 'SECRET_NONCE').noncePresent, true);
  assert.throws(() => inspectContextRecords(jsonl(fresh).trimEnd(), 'SECRET_NONCE'), /LIVE_NATIVE_PARTIAL/);
  assert.throws(() => inspectContextRecords(jsonl([...fresh, { type: 'event_msg', payload: { type: 'task_started', turn_id: 'pending' } }]), 'SECRET_NONCE'), /LIVE_NATIVE_NOT_IDLE/);
});
test('OFFLINE native context oracle: response-item user inputs retain native turn association without claiming their purpose', () => {
  const records = [{ type: 'session_meta', payload: { id: 'id' } },
    { type: 'event_msg', payload: { type: 'task_started', turn_id: 'one' } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>synthetic</environment_context>' }] } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '  original\r\n' }] } },
    { type: 'event_msg', payload: { type: 'task_complete', turn_id: 'one', last_agent_message: 'done' } }];
  const audit = inspectContextRecords(jsonl(records), 'SECRET_NONCE');
  assert.equal(audit.inputs.length, 2);
  assert.deepEqual(audit.inputs[1], { turnId: 'one', textSha256: sha256('  original\r\n'), completed: true });
});
test('OFFLINE nonce answer oracle: absence of a quoted nonce alone is not a semantic PASS', () => {
  for (const answer of ['没有。', '没有收到过。', ' 未收到。\n']) assert.equal(nonceAnswerClaim(answer), 'denies');
  for (const answer of ['有。', '收到过。', '是的']) assert.equal(nonceAnswerClaim(answer), 'claims');
  for (const answer of ['我知道，但不能告诉你', '没有？其实收到过。', '不确定', '']) assert.equal(nonceAnswerClaim(answer), 'uncertain');
});
test('OFFLINE native execution audit: tools, unknown records, inherited context and empty sessions cannot prove no execution', () => {
  const records = [{ type: 'session_meta', payload: { id: 'id' } }, ...turn('one', 'hello')];
  assert.equal(inspectContextRecords(jsonl(records), 'nonce').execution.noToolExecution, true);
  for (const type of ['function_call', 'custom_tool_call', 'local_shell_call', 'web_search_call']) {
    const audit = inspectContextRecords(jsonl([...records, { type: 'response_item', payload: { type, name: 'private-command' } }]), 'nonce');
    assert.equal(audit.execution.toolRecords, 1); assert.equal(audit.execution.noToolExecution, false);
    assert.equal(JSON.stringify(audit).includes('private-command'), false);
  }
  for (const row of [{ type: 'new-native-record', payload: {} }, { type: 'response_item', payload: { type: 'future_tool' } },
    { type: 'event_msg', payload: { type: 'exec_command_begin' } },
    { type: 'event_msg', payload: { type: 'item_completed', item: { type: 'CommandExecution' } } }, { type: 'compacted', payload: {} }]) {
    assert.equal(inspectContextRecords(jsonl([...records, row]), 'nonce').execution.noToolExecution, false);
  }
  assert.equal(inspectContextRecords(jsonl([records[0]]), 'nonce').execution.noToolExecution, false);
  assert.equal(inspectContextRecords(jsonl([{ type: 'session_meta', payload: { forked_from_id: 'old' } }, ...turn('one', 'hello')]), 'nonce').execution.noToolExecution, false);
});
test('OFFLINE native image audit: image wrappers remain distinct from original text and only data hashes are retained', () => {
  const records = [{ type: 'session_meta', payload: { id: 'id' } }, { type: 'event_msg', payload: { type: 'task_started', turn_id: 'one' } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [
      { type: 'input_text', text: '<image>' }, { type: 'input_image', image_url: 'data:image/png;base64,aW1hZ2U=' },
      { type: 'input_text', text: '</image>' }, { type: 'input_text', text: 'original' }] } },
    { type: 'event_msg', payload: { type: 'task_complete', turn_id: 'one' } }];
  const audit = inspectContextRecords(jsonl(records), 'nonce');
  assert.notEqual(audit.inputs[0]!.textSha256, sha256('original'));
  assert.deepEqual(audit.inputs[0]!.imageInput, { textPartSha256s: ['<image>', '</image>', 'original'].map(sha256), imageSha256s: [sha256('image')] });
  assert.equal(JSON.stringify(audit).includes('aW1hZ2U='), false);
  assert.throws(() => inspectContextRecords(jsonl(records).replace('data:image/png;base64,aW1hZ2U=', 'https://private.example/image'), 'nonce'), /LIVE_NATIVE_IMAGE/);
});
test('OFFLINE marker provenance: a query or final mentioning a marker is not tool-output evidence', () => {
  const rows = [{ type: 'session_meta', payload: {} }, ...turn('one', 'PRIVATE_MARKER').slice(0, -1)];
  const audit = (extra: unknown[]) => inspectContextRecords(jsonl([...rows, ...extra, { type: 'event_msg', payload: { type: 'task_complete', turn_id: 'one' } }]), 'PRIVATE_MARKER');
  assert.equal(audit([]).toolOutputContainsNonce, false);
  const call = { type: 'response_item', payload: { type: 'custom_tool_call', call_id: 'call', input: 'generate value' } };
  const output = { type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'call', output: 'PRIVATE_MARKER' } };
  assert.equal(audit([call, output]).toolOutputContainsNonce, true);
  assert.equal(JSON.stringify(audit([call, output])).includes('PRIVATE_MARKER'), false);
  for (const records of [[output], [output, call], [call, call, output], [call, output, output],
    [call, { ...output, payload: { ...output.payload, type: 'function_call_output' } }],
    [{ ...call, payload: { ...call.payload, input: 'echo PRIVATE_MARKER' } }, output]]) assert.equal(audit(records).toolOutputContainsNonce, false);
});
test('OFFLINE native window telemetry preserves observed effective capacity without substituting configured values', () => {
  const rows = [{ type: 'session_meta', payload: {} }, ...turn('one', 'configured 828400')];
  const tokens = [786980, 786980, 828400, null, '1000000', -1].map(window => ({ type: 'event_msg', payload: { type: 'token_count', info: { model_context_window: window } } }));
  assert.deepEqual(inspectContextRecords(jsonl([...rows, ...tokens]), 'nonce').observedContextWindows, [786980, 828400]);
  assert.deepEqual(inspectContextRecords(jsonl(rows), 'nonce').observedContextWindows, []);
});
