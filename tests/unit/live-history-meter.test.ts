import test from 'node:test';
import assert from 'node:assert/strict';
import { RoleTools } from '../../src/orchestration/tools.ts';
import { sha256 } from '../../src/orchestration/requests.ts';
import { historyMeter, directoryAnswerMatches } from '../live/history-meter.ts';

test('OFFLINE history instrumentation: actual return identity/hash preserved, private prose omitted from observations', async () => {
  const result = [{ requestId: 'request', ingressSeq: 7, directoryIdentity: 'directory', answerRef: 'answer', kind: 'work', query: 'PRIVATE_NONCE', shortText: 'private answer' }];
  const tools = new RoleTools('bridge', Object.fromEntries(['search_interactions', 'list_interactions', 'list_directories', 'search_directories', 'remember_alias', 'propose_directory', 'clarify_directory', 'route_delegate']
    .map(name => [name, async () => result]))), original = RoleTools.prototype.call, meter = historyMeter('PRIVATE_NONCE');
  try {
    assert.equal(await tools.call('list_interactions', { scope: 'conversation', limit: 30, beforeSeq: 8 }, 'call'), result);
    const observed = meter.snapshot(); assert.equal(observed.length, 1); assert.equal(observed[0]!.resultSha256, sha256(JSON.stringify(result)));
    assert.equal(observed[0]!.foreignCanarySeen, true); assert.equal(observed[0]!.beforeSeq, 8);
    assert.equal(JSON.stringify(observed).includes('PRIVATE_NONCE'), false); assert.equal(JSON.stringify(observed).includes('private answer'), false);
    await tools.call('list_directories', {}, 'other'); assert.equal(meter.snapshot().length, 1);
    await tools.call('search_interactions', { query: 'PRIVATE_NEEDLE', directoryRef: 'directory' }, 'search');
    assert.equal(meter.snapshot()[1]!.tool, 'search_interactions'); assert.equal(meter.snapshot()[1]!.querySha256, sha256('PRIVATE_NEEDLE'));
    assert.equal(JSON.stringify(meter.snapshot()).includes('PRIVATE_NEEDLE'), false);
    assert.throws(() => historyMeter('another'), /LIVE_METER_ALREADY_INSTALLED/);
  } finally { meter.stop(); }
  assert.equal(RoleTools.prototype.call, original); meter.stop();
});
test('OFFLINE directory answer: reuse of an actual preceding page may satisfy filtering, but missing/mixed/duplicate labels cannot', () => {
  assert.equal(directoryAnswerMatches('就刚才的最近30轮范围，term4u 关联的是 R31、R29、R27。', ['R31', 'R29', 'R27']), true);
  for (const text of ['term4u: R31、R29', 'term4u: R31、R29、R29', 'term4u R31，doc-ocr-service R29、R27', 'R31、R29、R27不是term4u'])
    assert.equal(directoryAnswerMatches(text, ['R31', 'R29', 'R27']), false);
  assert.equal(directoryAnswerMatches('term4u\n| R03 | 要求 R03 term4u | R03 term4u |\n| R05 | 要求 R05 term4u | R05 term4u |', ['R03', 'R05']), true);
  for (const text of ['term4u\n| R03 | R03 |\n| R03 | R05 |', 'term4u\n| R03 | R05 |\n| R05 | R05 |'])
    assert.equal(directoryAnswerMatches(text, ['R03', 'R05']), false);
});
