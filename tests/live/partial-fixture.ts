import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, writeFileSync, symlinkSync, existsSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { invariant } from '../../src/errors.ts';
import type { ModelProfile } from '../../src/orchestration/config.ts';

/** Deliberately synthetic metadata; no fake Agent completion is presented as live. */
export function seedPartialCatalog(home: string, cwd: string, model: ModelProfile) {
  const index = path.join(home, 'state_5.sqlite'); invariant(!existsSync(index), 'LIVE_NATIVE_STORE_NOT_EMPTY');
  const root = path.join(home, 'sessions'); mkdirSync(root, { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(index), now = Math.floor(Date.now() / 1000);
  const candidates: Array<{ id: string; updatedAt: number; lastCompletedAt: number; file: string }> = [];
  try {
    db.exec('CREATE TABLE threads(id TEXT PRIMARY KEY,cwd TEXT NOT NULL,rollout_path TEXT NOT NULL,title TEXT,created_at INTEGER,updated_at INTEGER,archived INTEGER NOT NULL DEFAULT 0)');
    for (const [ordinal, age] of [7200, 3600].entries()) {
      const id = randomUUID(), turn = randomUUID(), file = path.join(root, id + '.jsonl'), completed = now - age;
      const rows = [{ type: 'session_meta', payload: { id, cwd, timestamp: new Date((now - 10800) * 1000).toISOString() } },
        { type: 'turn_context', payload: { cwd, model: model.model, effort: model.reasoning } },
        { type: 'event_msg', payload: { type: 'task_started', turn_id: turn } },
        { type: 'event_msg', timestamp: new Date(completed * 1000).toISOString(), payload: { type: 'task_complete', turn_id: turn, last_agent_message: 'synthetic metadata fixture' } }];
      writeFileSync(file, rows.map(row => JSON.stringify(row)).join('\n') + '\n', { mode: 0o600, flag: 'wx' });
      const updated = now - 20 - ordinal * 10;
      db.prepare('INSERT INTO threads VALUES (?,?,?,?,?,?,0)').run(id, cwd, file, 'synthetic candidate ' + ordinal, now - 10800, updated);
      candidates.push({ id, updatedAt: updated * 1000, lastCompletedAt: completed * 1000, file });
    }
    // Metadata rejects these unsafe aliases, so the actual first 10-row page is
    // empty but partial, and retains a nextCursor into the two regular files.
    for (let i = 0; i < 10; i++) {
      const id = randomUUID(), file = path.join(root, id + '.jsonl'); symlinkSync(candidates[0]!.file, file);
      db.prepare('INSERT INTO threads VALUES (?,?,?,?,?,?,0)').run(id, cwd, file, 'synthetic unavailable alias', now - 10800, now - i);
    }
    return { syntheticHistory: true, purpose: 'partial metadata and misleading update order only; not live Agent histories', metadataRows: 12, unsafeAliases: 10, candidates };
  } finally { db.close(); }
}
