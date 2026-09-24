import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { setup } from '../helpers.ts';
import { liveFixture, liveStopRequested, liveStopSignal, requestLiveStop } from '../live/fixture.ts';

test('OFFLINE live stop: a stop request gates the next fixture before filesystem changes or runtime admission', async t => {
  const f = setup(t), target = path.join(f.root, 'not-created');
  assert.equal(liveStopRequested(), false); assert.equal(liveStopSignal.aborted, false);
  requestLiveStop(); assert.equal(liveStopRequested(), true); assert.equal(liveStopSignal.aborted, true);
  requestLiveStop(); await assert.rejects(liveFixture(f.c, target), /LIVE_STOP_REQUESTED/);
  assert.equal(existsSync(target), false);
});
