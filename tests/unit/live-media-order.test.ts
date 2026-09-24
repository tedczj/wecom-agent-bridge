import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setup } from '../helpers.ts';
import { MediaStore } from '../../src/media.ts';
import { mediaOrderMeter } from '../live/media-order-meter.ts';

test('OFFLINE FIFO instrumentation: second real media preparation finishes first; stop releases and restores', async t => {
  const f = setup(t), media = new MediaStore(f.c), original = MediaStore.prototype.prepare, meter = mediaOrderMeter();
  const first = randomUUID(), second = randomUUID();
  try {
    const pending = media.prepare(first, []); assert.deepEqual(await media.prepare(second, []), []);
    assert.deepEqual(meter.snapshot().map(e => [e.taskId, e.event]), [[first, 'entered'], [second, 'entered'], [second, 'completed']]);
    assert.throws(() => mediaOrderMeter(), /LIVE_METER_ALREADY_INSTALLED/);
    meter.stop(); assert.deepEqual(await pending, []); assert.equal(MediaStore.prototype.prepare, original);
    assert.equal(meter.snapshot().at(-1)!.taskId, first); meter.stop();
  } finally { meter.stop(); }
});
