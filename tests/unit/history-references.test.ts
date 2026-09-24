import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { setup } from '../helpers.ts';
import { initializeHierarchy } from '../../src/orchestration/schema.ts';
import { HistoryReferences } from '../../src/history/references.ts';
import type { Target } from '../../src/routing/catalog.ts';

test('OFFLINE history references: persistent references survive handler recreation, enforce scope/profile and expire at 15 minutes', async t => {
  const f = setup(t), store = f.store(); initializeHierarchy(store);
  const root = path.join(f.c.codex.home, 'sessions'); mkdirSync(root);
  const id = randomUUID(); writeFileSync(path.join(root, id + '.jsonl'), JSON.stringify({ type: 'session_meta', payload: { id, cwd: f.workspace } }) + '\n');
  const target: Target = { config: f.c, digest: 'profile', directory: { id: 'test', path: f.workspace, identity: 'inode', profile: 'read', aliases: [], description: '' } };
  let now = 1000;
  const references = new HistoryReferences(store, () => now), listed = await references.list('scope', target);
  const token = listed.entries[0]!.sessionRef;
  assert.equal((await new HistoryReferences(store, () => now).get('scope', target, token)).ref.kind, 'codex');
  await assert.rejects(references.get('another', target, token), /HISTORY_REFERENCE_EXPIRED/);
  await assert.rejects(references.get('scope', { ...target, digest: 'changed' }, token), /HISTORY_REFERENCE_EXPIRED/);
  now += 900000; await assert.rejects(references.get('scope', target, token), /HISTORY_REFERENCE_EXPIRED/);
  assert.equal(store.db.prepare('SELECT count(*) n FROM business_bindings').get()!.n, 0);
});
