import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, symlinkSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { setup } from '../helpers.ts';
import { sha256 } from '../../src/orchestration/requests.ts';
import { corruptPrivateHistory } from '../live/corrupt-history.ts';

test('OFFLINE corruption fixture: only matching private history is appended; stale hashes, outside paths and links are refused', async t => {
  const f = setup(t), home = path.join(f.root, 'isolated'), sessions = path.join(home, 'sessions'), locks = path.join(home, 'thread-writer-locks'), id = randomUUID();
  mkdirSync(sessions, { recursive: true }); mkdirSync(locks); writeFileSync(path.join(locks, '.coordination.lock'), '');
  writeFileSync(path.join(home, 'bridge-fixture-home.json'), JSON.stringify({ purpose: 'native-history-fault' }));
  const file = path.join(sessions, id + '.jsonl'), initial = JSON.stringify({ type: 'session_meta', payload: { id, cwd: f.workspace } }) + '\n';
  writeFileSync(file, initial); const mutation = await corruptPrivateHistory(home, file, id, f.workspace, sha256(initial), f.root);
  const after = readFileSync(file); assert.equal(mutation.afterSha256, sha256(after)); assert.equal(mutation.writerIdleLease, true);
  assert.equal(after.subarray(0, Buffer.byteLength(initial)).toString(), initial);
  assert.deepEqual(JSON.parse(after.toString().trim().split('\n').at(-1)!), { type: 'turn_context', payload: { cwd: f.root } });
  await assert.rejects(corruptPrivateHistory(home, file, id, f.workspace, sha256(initial), f.root), /LIVE_CORRUPTION_REFUSED/);
  assert.equal(sha256(readFileSync(file)), mutation.afterSha256);
  const outside = path.join(f.root, 'outside.jsonl'); writeFileSync(outside, initial);
  await assert.rejects(corruptPrivateHistory(home, outside, id, f.workspace, sha256(initial), f.root), /LIVE_CORRUPTION_SCOPE/);
  const link = path.join(sessions, 'link.jsonl'); symlinkSync(outside, link);
  await assert.rejects(corruptPrivateHistory(home, link, id, f.workspace, sha256(initial), f.root), /LIVE_CORRUPTION_REFUSED/);
  assert.equal(readFileSync(outside, 'utf8'), initial);
});
