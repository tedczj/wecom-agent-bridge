import { existsSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { processAlive, readControlled } from '../fsutil.ts';
import { invariant, record } from '../errors.ts';

/** Release only dead host resources. Job review/taint and workspace locks are untouched. */
export async function recoverHierarchyResources(root: string): Promise<void> {
  const lock = path.join(root, 'instance.lock'), guard = path.join(root, 'startup-recovery.lock');
  invariant(!existsSync(guard), 'STARTUP_RECOVERY_REVIEW_REQUIRED');
  if (!existsSync(lock)) return;
  const original = await readControlled(root, lock, 16384), owner = record(JSON.parse(original.toString('utf8')));
  invariant(Number.isSafeInteger(owner.pid) && Number(owner.pid) > 0 && typeof owner.token === 'string' && /^[0-9a-f-]{36}$/.test(owner.token), 'UNSAFE_LOCK');
  if (processAlive(Number(owner.pid))) return; // The normal acquireLock reports the active owner.
  const token = randomUUID();
  try { writeFileSync(guard, JSON.stringify({ pid: process.pid, token }), { flag: 'wx', mode: 0o600 }); }
  catch { invariant(false, 'STARTUP_RECOVERY_REVIEW_REQUIRED'); }
  try {
    invariant((await readControlled(root, lock, 16384)).equals(original) && !processAlive(Number(owner.pid)), 'INSTANCE_RUNNING');
    const markers: Array<{ file: string; bytes: Buffer }> = [];
    for (const file of [path.join(root, 'agent-process.json'), path.join(root, 'routing-agent/state/agent-process.json')]) {
      if (!existsSync(file)) continue;
      const bytes = await readControlled(root, file, 16384), data = record(JSON.parse(bytes.toString('utf8')));
      invariant(Number.isSafeInteger(data.pid) && Number(data.pid) > 0 && ['codex', 'pi'].includes(String(data.backend)), 'UNSAFE_PROCESS_MARKER');
      invariant(!processAlive(Number(data.pid)) && !processAlive(-Number(data.pid)), 'AGENT_PROCESS_REVIEW_REQUIRED');
      markers.push({ file, bytes });
    }
    // All checks precede mutation. The exclusive guard serializes competing recovery attempts.
    for (const marker of markers) {
      invariant((await readControlled(root, marker.file, 16384)).equals(marker.bytes), 'AGENT_PROCESS_REVIEW_REQUIRED');
      renameSync(marker.file, marker.file + '.stopped-' + token);
    }
    invariant((await readControlled(root, lock, 16384)).equals(original) && !processAlive(Number(owner.pid)), 'INSTANCE_RUNNING');
    renameSync(lock, lock + '.stopped-' + token);
  } finally {
    if (JSON.parse((await readControlled(root, guard, 16384)).toString('utf8')).token === token) unlinkSync(guard);
  }
}
