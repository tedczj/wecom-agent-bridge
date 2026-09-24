import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, symlinkSync, appendFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { setup, fixture } from '../helpers.ts';
import { normalize } from '../../src/local.ts';
import { RequestStore } from '../../src/orchestration/requests.ts';
import { initializeHierarchy } from '../../src/orchestration/schema.ts';
import { NativeCatalog, backendHomeKey, directoryIdentity } from '../../src/history/catalog.ts';
import { ControllerRegistry } from '../../src/orchestration/registry.ts';
import { NativeReader } from '../../src/history/reader.ts';
import { ResumeVerifier } from '../../src/history/verifier.ts';
import type { Target } from '../../src/routing/catalog.ts';

test('OFFLINE M5: exact native lookup ignores unrelated corrupt/large bodies and metadata listing reads no body', async t => {
  const f = setup(t), store = f.store(); initializeHierarchy(store);
  const root = path.join(f.c.codex.home, 'sessions'); mkdirSync(root);
  const db = new DatabaseSync(path.join(f.c.codex.home, 'state_5.sqlite')); t.after(() => db.close());
  db.exec('CREATE TABLE threads (id TEXT PRIMARY KEY,cwd TEXT,rollout_path TEXT,title TEXT,created_at INTEGER,updated_at INTEGER,archived INTEGER)');
  const target: Target = { config: f.c, digest: 'profile', directory: { id: 'test', path: f.workspace, identity: 'inode', profile: 'read', aliases: [], description: '' } };
  const good = randomUUID(), bad = randomUUID(), management = randomUUID();
  const add = (id: string, text: string) => {
    const file = path.join(root, id + '.jsonl'); writeFileSync(file, text);
    db.prepare('INSERT INTO threads VALUES (?,?,?,?,?,?,0)').run(id, f.workspace, file, 'metadata title', 1, 2);
    return file;
  };
  const goodFile = add(good, JSON.stringify({ type: 'session_meta', payload: { id: good, cwd: f.workspace } }) + '\nBODY_NOT_READ_BY_EXACT_LOOKUP');
  add(bad, 'not-json' + 'x'.repeat(9 * 1024 * 1024)); add(management, 'management transcript');
  const registry = new ControllerRegistry(store, () => {}), actor = registry.prepare('scope', 'route', directoryIdentity(target), 'model');
  registry.registerNative(actor.controller_id, { threadId: management, generation: 0 }, backendHomeKey(target));
  const catalog = new NativeCatalog(store, 'scope'), located = await catalog.locateExact(target, { kind: 'codex', threadId: good });
  assert.equal(located.file, goodFile); assert.equal(located.lastCompletedAt, null);
  const page = await catalog.listMetadata(target);
  assert.equal(page.entries.length, 2); assert.equal(page.discoveryCoverage, 'complete');
  assert.equal(page.orderBasis, 'updated-at'); // Does not claim last-completed-response sorting.
  await assert.rejects(catalog.locateExact(target, { kind: 'codex', threadId: management }), /HISTORY_SESSION_UNAVAILABLE/);
  const alias = path.join(f.root, 'workspace-alias'); symlinkSync(f.workspace, alias);
  db.prepare('UPDATE threads SET cwd=? WHERE id=?').run(alias, good);
  assert.ok((await catalog.listMetadata(target)).entries.some(e => e.ref.kind === 'codex' && e.ref.threadId === good));
  const owned = randomUUID(); add(owned, 'owned native transcript');
  const incoming = normalize(fixture('owned message'), f.c, 'local:codex'), request = new RequestStore(store).accept(incoming).request;
  const job = store.reserve(incoming, 'agent').job;
  store.persistSession(job.session_key, { kind: 'codex', threadId: owned });
  store.db.prepare('UPDATE orchestration_requests SET job_task_id=? WHERE request_id=?').run(job.task_id, request.request_id);
  assert.equal((await catalog.listMetadata(target)).entries.some(e => e.ref.kind === 'codex' && e.ref.threadId === owned), false);
  assert.equal((await new NativeCatalog(store, request.conversation_scope).listMetadata(target)).entries.some(e => e.ref.kind === 'codex' && e.ref.threadId === owned), true);
});
test('OFFLINE M5: missing index uses header-only fallback; broken candidates never masquerade as empty complete history', async t => {
  const f = setup(t), store = f.store(); initializeHierarchy(store);
  const target: Target = { config: f.c, digest: 'profile', directory: { id: 'test', path: f.workspace, identity: 'inode', profile: 'read', aliases: [], description: '' } };
  const catalog = new NativeCatalog(store, 'scope');
  const empty = await catalog.listMetadata(target);
  assert.deepEqual(empty.entries, []); assert.equal(empty.discoveryCoverage, 'complete');
  const root = path.join(f.c.codex.home, 'sessions'); mkdirSync(root);
  const id = randomUUID(), file = path.join(root, id + '.jsonl');
  writeFileSync(file, JSON.stringify({ type: 'session_meta', payload: { cwd: f.workspace, id } }) + '\nBROKEN BODY');
  assert.equal((await catalog.listMetadata(target)).entries.length, 1);
  assert.equal((await catalog.locateExact(target, { kind: 'codex', threadId: id })).file, file);
  writeFileSync(path.join(root, 'broken.jsonl'), 'not-json\n');
  assert.equal((await catalog.listMetadata(target)).discoveryCoverage, 'partial');
  const db = new DatabaseSync(path.join(f.c.codex.home, 'state_5.sqlite')); t.after(() => db.close());
  db.exec('CREATE TABLE threads (id TEXT PRIMARY KEY,cwd TEXT,rollout_path TEXT,title TEXT,created_at INTEGER,updated_at INTEGER,archived INTEGER)');
  const missing = randomUUID();
  db.prepare('INSERT INTO threads VALUES (?,?,?,?,?,?,0)').run(missing, f.workspace, path.join(f.c.codex.home, 'sessions', 'missing.jsonl'), 'missing', 1, 2);
  const page = await catalog.listMetadata(target);
  assert.deepEqual(page.entries, []); assert.equal(page.discoveryCoverage, 'partial');
  assert.deepEqual(page.diagnostics, ['CANDIDATE_UNVERIFIED']);
  await assert.rejects(catalog.locateExact(target, { kind: 'codex', threadId: randomUUID() }), /HISTORY_EXACT_NOT_FOUND/);
});
test('OFFLINE M5: revision-bound completion cache orders complete coverage and invalidates changed files', async t => {
  const f = setup(t), store = f.store(); initializeHierarchy(store);
  const root = path.join(f.c.codex.home, 'sessions'); mkdirSync(root);
  const db = new DatabaseSync(path.join(f.c.codex.home, 'state_5.sqlite')); t.after(() => db.close());
  db.exec('CREATE TABLE threads (id TEXT PRIMARY KEY,cwd TEXT,rollout_path TEXT,title TEXT,created_at INTEGER,updated_at INTEGER,archived INTEGER)');
  const target: Target = { config: f.c, digest: 'profile', directory: { id: 'test', path: f.workspace, identity: 'inode', profile: 'read', aliases: [], description: '' } };
  const catalog = new NativeCatalog(store, 'scope'), verifier = new ResumeVerifier(new NativeReader(), { check: async () => 'idle' });
  const ids = [randomUUID(), randomUUID()], files: string[] = [];
  for (const [i, id] of ids.entries()) {
    const file = path.join(root, id + '.jsonl'); files.push(file);
    writeFileSync(file, [
      { type: 'session_meta', payload: { id, cwd: f.workspace } },
      { type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn' } },
      { type: 'event_msg', timestamp: new Date(1000 + i * 1000).toISOString(), payload: { type: 'task_complete', turn_id: 'turn', last_agent_message: 'final' } },
    ].map(row => JSON.stringify(row) + '\n').join(''));
    // The most recently modified file is not the most recently completed session.
    db.prepare('INSERT INTO threads VALUES (?,?,?,?,?,?,0)').run(id, f.workspace, file, 'title', 0, 20 - i);
    const candidate = await catalog.locateExact(target, { kind: 'codex', threadId: id });
    catalog.recordVerified(target, candidate, await verifier.verify(target, candidate, target.digest));
  }
  const page = await catalog.listMetadata(target);
  assert.equal(page.discoveryCoverage, 'complete'); assert.equal(page.orderBasis, 'last-completed-response');
  assert.deepEqual(page.entries.map(entry => entry.lastCompletedAt), [2000, 1000]);
  assert.equal(page.entries[0]!.ref.kind === 'codex' && page.entries[0]!.ref.threadId, ids[1]);
  const partial = await catalog.listMetadata(target, undefined, 1);
  assert.equal(partial.discoveryCoverage, 'partial'); assert.equal(partial.orderBasis, 'updated-at');
  const stale = page.entries[0]!;
  appendFileSync(files[1]!, JSON.stringify({ type: 'event_msg', payload: { type: 'task_started' } }) + '\n');
  assert.throws(() => catalog.recordVerified(target, stale, { ref: stale.ref, sourceRevision: stale.sourceRevision, profileDigest: target.digest, lastCompletedAt: 2000 }), /HISTORY_CHANGED/);
  const changed = await catalog.listMetadata(target);
  assert.equal(changed.orderBasis, 'updated-at'); assert.equal(changed.entries.filter(entry => entry.lastCompletedAt === null).length, 1);
});
test('OFFLINE M5: exact indexed lookup rejects a valid foreign header without reading its body', async t => {
  const f = setup(t), store = f.store(); initializeHierarchy(store);
  const root = path.join(f.c.codex.home, 'sessions'); mkdirSync(root);
  const other = path.join(f.root, 'other'); mkdirSync(other);
  const id = randomUUID(), file = path.join(root, id + '.jsonl');
  writeFileSync(file, JSON.stringify({ type: 'session_meta', payload: { id, cwd: other } }) + '\n' + 'invalid body'.repeat(100000));
  const db = new DatabaseSync(path.join(f.c.codex.home, 'state_5.sqlite')); t.after(() => db.close());
  db.exec('CREATE TABLE threads (id TEXT PRIMARY KEY,cwd TEXT,rollout_path TEXT,title TEXT,created_at INTEGER,updated_at INTEGER,archived INTEGER)');
  db.prepare('INSERT INTO threads VALUES (?,?,?,?,?,?,0)').run(id, f.workspace, file, 'misleading cwd index', 1, 2);
  const target: Target = { config: f.c, digest: 'profile', directory: { id: 'test', path: f.workspace, identity: 'inode', profile: 'read', aliases: [], description: '' } };
  await assert.rejects(new NativeCatalog(store, 'scope').locateExact(target, { kind: 'codex', threadId: id }), /HISTORY_SCOPE/);
});
