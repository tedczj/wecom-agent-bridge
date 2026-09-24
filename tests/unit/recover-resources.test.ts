import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, writeFileSync, symlinkSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { setup, fixture } from '../helpers.ts';
import { normalize } from '../../src/local.ts';
import { processAlive, acquireLock } from '../../src/fsutil.ts';
import { recoverHierarchyResources } from '../../src/orchestration/recover-resources.ts';

async function exitedPid(): Promise<number> {
  const child = spawn(process.execPath, ['-e', ''], { detached: true, stdio: 'ignore', env: {} });
  await once(child, 'exit'); assert.ok(child.pid); assert.equal(processAlive(child.pid), false); assert.equal(processAlive(-child.pid), false); return child.pid;
}
test('OFFLINE resource recovery: archives proven-dead resources without reviewing or replaying work', async t => {
  const f = setup(t), store = f.store(), pid = await exitedPid();
  const job = store.reserve(normalize(fixture('work'), f.c, 'local:codex'), 'agent').job; store.prepared(job.task_id, []); store.claim();
  const lock = path.join(f.c.stateRoot, 'instance.lock'), marker = path.join(f.c.stateRoot, 'agent-process.json');
  const lockBytes = JSON.stringify({ pid, token: randomUUID() }), markerBytes = JSON.stringify({ pid, backend: 'codex', startedAt: Date.now() });
  writeFileSync(lock, lockBytes); writeFileSync(marker, markerBytes);
  await recoverHierarchyResources(f.c.stateRoot);
  assert.equal(existsSync(lock), false); assert.equal(existsSync(marker), false);
  const archived = readdirSync(f.c.stateRoot);
  assert.equal(readFileSync(path.join(f.c.stateRoot, archived.find(file => file.startsWith('instance.lock.stopped-'))!), 'utf8'), lockBytes);
  assert.equal(readFileSync(path.join(f.c.stateRoot, archived.find(file => file.startsWith('agent-process.json.stopped-'))!), 'utf8'), markerBytes);
  assert.equal(store.get(job.task_id).status, 'running'); assert.equal(store.get(job.task_id).reviewed_at, null);
  store.recover(); assert.equal(store.get(job.task_id).status, 'interrupted'); assert.equal(store.blocked(), true);
  assert.equal(store.session(job.session_key).state, 'tainted'); assert.equal(store.get(job.task_id).reviewed_at, null);
  const unlock = acquireLock(f.c.stateRoot); unlock(); await recoverHierarchyResources(f.c.stateRoot);
});
test('OFFLINE resource recovery: active owners, live agents, incomplete recovery and symlinks stay closed', async t => {
  const f = setup(t), pid = await exitedPid(), root = f.c.stateRoot; f.store();
  const lock = path.join(root, 'instance.lock'), marker = path.join(root, 'agent-process.json'), guard = path.join(root, 'startup-recovery.lock');
  writeFileSync(lock, JSON.stringify({ pid: process.pid, token: randomUUID() }));
  await recoverHierarchyResources(root); assert.equal(existsSync(lock), true);
  writeFileSync(lock, JSON.stringify({ pid, token: randomUUID() })); writeFileSync(marker, JSON.stringify({ pid: process.pid, backend: 'codex' }));
  await assert.rejects(recoverHierarchyResources(root), /AGENT_PROCESS_REVIEW_REQUIRED/);
  assert.equal(existsSync(lock), true); assert.equal(existsSync(marker), true); assert.equal(existsSync(guard), false);
  unlinkSync(marker); writeFileSync(guard, JSON.stringify({ pid, token: randomUUID() }));
  await assert.rejects(recoverHierarchyResources(root), /STARTUP_RECOVERY_REVIEW_REQUIRED/); unlinkSync(guard);
  const outside = path.join(f.root, 'outside'); writeFileSync(outside, JSON.stringify({ pid, backend: 'codex' })); symlinkSync(outside, marker);
  await assert.rejects(recoverHierarchyResources(root)); assert.equal(existsSync(lock), true); assert.equal(existsSync(outside), true);
});
test('OFFLINE resource recovery: concurrent attempts do not both claim a stale service lock', async t => {
  const f = setup(t), pid = await exitedPid(); f.store();
  writeFileSync(path.join(f.c.stateRoot, 'instance.lock'), JSON.stringify({ pid, token: randomUUID() }));
  const results = await Promise.allSettled([recoverHierarchyResources(f.c.stateRoot), recoverHierarchyResources(f.c.stateRoot)]);
  assert.equal(results.filter(row => row.status === 'fulfilled').length, 1);
  assert.equal(readdirSync(f.c.stateRoot).filter(name => name.startsWith('instance.lock.stopped-')).length, 1);
  assert.equal(existsSync(path.join(f.c.stateRoot, 'startup-recovery.lock')), false);
});
