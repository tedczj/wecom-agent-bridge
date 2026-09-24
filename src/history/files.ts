import { constants } from 'node:fs';
import { lstat, open, opendir } from 'node:fs/promises';
import path from 'node:path';
import { invariant, BridgeError } from '../errors.ts';
import { inside } from '../fsutil.ts';
import type { Target } from '../routing/catalog.ts';
import { JsonlProjection } from './jsonl-projection.ts';

export function nativeRoot(target: Target): string {
  return target.config.backend === 'codex' ? path.join(target.config.codex.home, 'sessions') : target.config.agent.sessionRoot;
}
export async function nativeFiles(target: Target): Promise<{ files: string[]; diagnostics: string[] }> {
  const root = nativeRoot(target), queue = [root], files: string[] = [], diagnostics: string[] = [], deadline = Date.now() + 2000;
  let visited = 0;
  while (queue.length) {
    invariant(++visited <= 10000 && Date.now() < deadline, 'HISTORY_SCAN_LIMIT');
    const directory = queue.shift()!;
    try {
      invariant(!(await lstat(directory)).isSymbolicLink(), 'HISTORY_PATH');
      for await (const entry of await opendir(directory)) {
        if (entry.isSymbolicLink()) { diagnostics.push('HISTORY_SYMLINK_OMITTED'); continue; }
        if (entry.isDirectory()) queue.push(path.join(directory, entry.name));
        else if (entry.isFile() && entry.name.endsWith('.jsonl')) files.push(path.join(directory, entry.name));
        invariant(queue.length + files.length <= 10000 && Date.now() < deadline, 'HISTORY_SCAN_LIMIT');
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' && directory === root) return { files: [], diagnostics: [] };
      throw error;
    }
  }
  return { files: files.sort(), diagnostics };
}
/** Read and validate only the first native record, not the transcript body. */
export async function nativeHeader(target: Target, file: string): Promise<Record<string, unknown>> {
  const root = nativeRoot(target);
  invariant(path.isAbsolute(file) && inside(root, file), 'HISTORY_PATH');
  for (let parent = path.dirname(file); inside(root, parent); parent = path.dirname(parent)) {
    invariant(!(await lstat(parent)).isSymbolicLink(), 'HISTORY_PATH'); if (parent === root) break;
  }
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat(); invariant(stat.isFile(), 'HISTORY_PATH');
    let header: Record<string, unknown> | undefined, offset = 0;
    const decoder = new TextDecoder('utf-8', { fatal: true }), parser = new JsonlProjection(row => { header = row.value; }), deadline = Date.now() + 2000;
    while (!header && offset < stat.size) {
      invariant(offset < 16777216 && Date.now() < deadline, 'HISTORY_HEADER_LIMIT');
      const buffer = Buffer.alloc(Math.min(65536, stat.size - offset)), { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
      invariant(bytesRead > 0, 'HISTORY_CHANGED');
      const end = buffer.subarray(0, bytesRead).indexOf(10), used = end < 0 ? bytesRead : end + 1;
      let text: string; try { text = decoder.decode(buffer.subarray(0, used), { stream: end < 0 }); } catch { throw new BridgeError('HISTORY_FORMAT'); }
      if (offset === 0) text = text.replace(/^\uFEFF/, ''); parser.push(text); offset += used;
      if (end >= 0) break;
    }
    invariant(header, 'HISTORY_HEADER');
    const result = header as Record<string, unknown>;
    const payload = target.config.backend === 'codex' ? result.payload : result;
    invariant(target.config.backend === 'codex' ? result.type === 'session_meta' : result.type === 'session' && result.version === 3, 'HISTORY_HEADER');
    invariant(payload !== null && typeof payload === 'object' && !Array.isArray(payload), 'HISTORY_HEADER');
    const value = payload as Record<string, unknown>;
    invariant(typeof value.id === 'string' && typeof value.cwd === 'string', 'HISTORY_HEADER');
    const endStat = await handle.stat();
    invariant(stat.dev === endStat.dev && stat.ino === endStat.ino && stat.size === endStat.size && stat.mtimeMs === endStat.mtimeMs, 'HISTORY_CHANGED');
    return { id: value.id, cwd: value.cwd, rollout_path: file, title: '',
      created_at: typeof value.timestamp === 'string' ? Math.floor(Date.parse(value.timestamp) / 1000) : null, updated_at: null };
  } finally { await handle.close(); }
}
