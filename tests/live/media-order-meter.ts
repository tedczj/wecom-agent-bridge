import { MediaStore } from '../../src/media.ts';
import { invariant } from '../../src/errors.ts';

let installed = false;
/** Delay only the first real preparation; never replace its media result. */
export function mediaOrderMeter() {
  invariant(!installed, 'LIVE_METER_ALREADY_INSTALLED'); installed = true;
  const original = MediaStore.prototype.prepare, events: Array<{ taskId: string; event: 'entered' | 'completed'; at: number }> = [];
  let first: string | undefined, release!: () => void, stopped = false;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  const delayed: typeof original = async function (this: MediaStore, ...args) {
    const taskId = args[0]; events.push({ taskId, event: 'entered', at: Date.now() });
    if (!first) { first = taskId; await barrier; }
    const result = await original.apply(this, args); events.push({ taskId, event: 'completed', at: Date.now() }); return result;
  };
  MediaStore.prototype.prepare = delayed;
  return { release, snapshot: () => structuredClone(events), stop() {
    if (stopped) return; release();
    invariant(MediaStore.prototype.prepare === delayed, 'LIVE_METER_RESTORE_CONFLICT');
    MediaStore.prototype.prepare = original; installed = false; stopped = true;
  } };
}
