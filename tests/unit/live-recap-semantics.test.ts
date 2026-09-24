import test from 'node:test';
import assert from 'node:assert/strict';
import { validateRecap, type RecapContent } from '../../src/answers/recap.ts';
import { recapSemanticFacts } from '../live/recap-semantics.ts';
import { inspectContextRecords } from '../live/native-context.ts';

test('OFFLINE recap rubric preserves restrictions, unfinished work, ordered choices and a question', () => {
  const content: RecapContent = { summary: '仅运行了现有测试。', completed: ['测试执行通过'], pending: ['边界测试尚未完成'], blockers: [],
    constraints: ['不修改代码，不 commit、不 push'], options: [{ label: '方案 A', meaning: '先补测试' }, { label: 'B', meaning: '先讨论范围' }], questions: ['选择哪个方案？'] };
  const check = (value: RecapContent) => recapSemanticFacts(value, validateRecap(value, 1000).shortText);
  assert.ok(Object.values(check(content)).every(Boolean));
  assert.equal(check({ ...content, constraints: [] }).noCodeChanges, false);
  assert.equal(check({ ...content, pending: [] }).pending, false);
  assert.equal(check({ ...content, questions: [] }).question, false);
  assert.equal(check({ ...content, options: [...content.options].reverse() }).options, false);
  assert.equal(check({ ...content, completed: ['已实现方案 A'] }).noClaimedImplementation, false);
});
test('OFFLINE fixture test evidence requires an actual known command mirror, matching cwd, exit and emitted marker', () => {
  const item = { type: 'CommandExecution', command: ['/bin/zsh', '-lc', 'npm test'], cwd: 'file:///fixture', status: 'completed', exit_code: 0, stdout: '# TEST_RUN_nonce\n' };
  const inspect = (value: unknown) => inspectContextRecords([
    { type: 'session_meta', payload: {} }, { type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn' } },
    { type: 'event_msg', payload: { type: 'item_completed', item: value } }, { type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn' } },
  ].map(row => JSON.stringify(row)).join('\n') + '\n', 'nonce', '/fixture');
  const valid = inspect(item).fixtureTests![0]!;
  assert.equal(valid.cwdMatches && valid.completed && valid.exitCode === 0 && valid.markerSeen, true);
  assert.equal(inspect({ ...item, cwd: 'file:///foreign' }).fixtureTests![0]!.cwdMatches, false);
  assert.equal(inspect({ ...item, stdout: 'assertion failed' }).fixtureTests![0]!.markerSeen, false);
  assert.equal(inspect({ ...item, command: ['/bin/zsh', '-lc', 'cat fixture.test.cjs'] }).fixtureTests!.length, 0);
  assert.equal(inspect({ ...item, type: 'AgentMessage' }).fixtureTests!.length, 0);
  assert.equal(inspect(item).execution.noToolExecution, false);
  assert.equal(JSON.stringify(valid).includes('TEST_RUN_nonce'), false);
});
