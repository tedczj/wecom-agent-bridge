import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { setup, fixture } from '../helpers.ts';
import { normalize } from '../../src/local.ts';
import { initializeHierarchy } from '../../src/orchestration/schema.ts';
import { RequestStore, sha256 } from '../../src/orchestration/requests.ts';
import { ArtifactStore } from '../../src/answers/artifact-store.ts';
import { RoleTools } from '../../src/orchestration/tools.ts';
import { answerMeter } from '../live/answer-meter.ts';

test('OFFLINE answer instrumentation preserves real capture and returns while recording only hashes and range metadata', async t => {
  const f = setup(t), store = f.store(); initializeHierarchy(store);
  const request = new RequestStore(store).accept(normalize(fixture(), f.c, 'local:codex')).request;
  const artifacts = new ArtifactStore(store, path.join(f.c.stateRoot, 'artifacts'));
  const answer = artifacts.stage(request.request_id, 'business'), raw = 'PRIVATE_RAW_TEXT'.repeat(130) + ' 末尾私密值';
  const value = { text: raw, marker: 'MARKER_VALUE' };
  const tools = new RoleTools('bridge', Object.fromEntries(['search_interactions', 'list_interactions', 'list_directories', 'search_directories', 'remember_alias', 'propose_directory', 'clarify_directory', 'route_delegate']
    .map(name => [name, async () => value])));
  const capture = ArtifactStore.prototype.capture, call = RoleTools.prototype.call, meter = answerMeter();
  try {
    artifacts.capture(answer.answer_id, raw); meter.setMarker('MARKER_VALUE');
    assert.equal(await tools.call('list_interactions', { scope: 'conversation' }, 'one'), value);
    const audit = meter.snapshot();
    assert.equal(artifacts.get(answer.answer_id).sha256, sha256(raw));
    assert.deepEqual(audit.captures, [{ answerId: answer.answer_id, sha256: sha256(raw), bytes: Buffer.byteLength(raw) }]);
    assert.equal(audit.tools[0]!.rawBodySeen, true); assert.equal(audit.tools[0]!.markerSeen, true);
    assert.equal(JSON.stringify(audit).includes('PRIVATE_RAW_TEXT'), false); assert.equal(JSON.stringify(audit).includes('MARKER_VALUE'), false);
    assert.throws(() => answerMeter(), /LIVE_METER_ALREADY_INSTALLED/);
  } finally { meter.stop(); }
  assert.equal(ArtifactStore.prototype.capture, capture); assert.equal(RoleTools.prototype.call, call); meter.stop();
});
