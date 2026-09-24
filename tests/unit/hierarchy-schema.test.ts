import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { setup, fixture } from '../helpers.ts';
import { normalize } from '../../src/local.ts';
import { Store } from '../../src/store.ts';
import { initializeHierarchy } from '../../src/orchestration/schema.ts';

test('OFFLINE hierarchical schema: empty state initializes once and existing v4 state remains readable', t => {
  const f = setup(t), store = f.store();
  initializeHierarchy(store);
  store.put('sentinel', { retained: true });
  initializeHierarchy(store);
  assert.equal(store.db.prepare('PRAGMA user_version').get()!.user_version, 4);
  assert.deepEqual(store.value('sentinel'), { retained: true });
  assert.equal(store.db.prepare('SELECT count(*) n FROM orchestration_requests').get()!.n, 0);
  const file = path.join(f.c.stateRoot, 'bridge.sqlite');
  assert.throws(() => new Store(file, f.c), /V4_REQUIRES_HIERARCHICAL/);
  const reader = new Store(file, f.c, true);
  try { assert.deepEqual(reader.value('sentinel'), { retained: true }); } finally { reader.close(); }
});

for (const populated of ['jobs', 'sessions', 'routing'] as const) test(`OFFLINE hierarchical schema: ${populated} prevents initialization without converting existing state`, t => {
  const f = setup(t), store = f.store();
  if (populated === 'routing') store.put('sentinel', { retained: true });
  else {
    const job = store.reserve(normalize(fixture('retained request'), f.c, 'local:codex'), 'command').job;
    store.complete(job.task_id, 'succeeded', 'retained result');
    if (populated === 'sessions') { store.db.exec('DELETE FROM outbox; DELETE FROM jobs;'); }
  }
  const rows = () => ['jobs', 'sessions', 'routing_state'].map(table => store.db.prepare('SELECT * FROM ' + table).all());
  const before = rows();
  assert.throws(() => initializeHierarchy(store), /HIERARCHICAL_REQUIRES_EMPTY_STATE/);
  assert.deepEqual(rows(), before);
  assert.equal(store.db.prepare('PRAGMA user_version').get()!.user_version, 3);
  assert.equal(store.db.prepare("SELECT name FROM sqlite_master WHERE name='orchestration_requests'").get(), undefined);
});
