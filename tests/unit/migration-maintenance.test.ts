import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdirSync, writeFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setup, fixture } from '../helpers.ts';
import { parseConfig } from '../../src/config.ts';
import { Store } from '../../src/store.ts';
import { normalize } from '../../src/local.ts';
import { Catalog } from '../../src/routing/catalog.ts';
import { maintainV4 } from '../../src/migrations/maintenance.ts';
import { acquireLock } from '../../src/fsutil.ts';
import { conversationScope } from '../../src/orchestration/requests.ts';
import { hash } from '../../src/routing/config.ts';
import { Directories } from '../../src/orchestration/directories.ts';

function config(f: ReturnType<typeof setup>) {
  const plan = JSON.parse(readFileSync('docs/plans/three-layer-agent-bridge/config.hierarchical.example.json', 'utf8'));
  plan.orchestration.controllerRuntime.workRoot = path.join(f.c.stateRoot, 'controllers');
  plan.orchestration.controllerRuntime.home = f.c.codex.home;
  plan.orchestration.answers.root = path.join(f.c.stateRoot, 'artifacts');
  return parseConfig({ ...f.c, models: plan.models, orchestration: plan.orchestration,
    routing: { roots: [{ id: 'root', path: f.root, profile: 'read' }], profiles: [{ id: 'read', version: '1' }],
      workspaces: [{ id: 'test', path: f.workspace, profile: 'read' }] } });
}
test('OFFLINE maintenance migration: SQLite backup captures WAL, dry-run leaves source v3 and preserves original sessions', async t => {
  const f = setup(t), c = config(f), legacy = parseConfig({ ...c, models: undefined, orchestration: undefined }), source = new Store(path.join(c.stateRoot, 'bridge.sqlite'), legacy);
  const catalog = new Catalog(legacy), target = catalog.target(catalog.configured[0]!);
  const job = source.reserve(normalize(fixture('original'), c, 'local:codex'), 'agent', { ...target, reason: 'work', bind: true }).job;
  source.prepared(job.task_id, []); source.claim(); source.persistSession(job.session_key, { kind: 'codex', threadId: 'original-native' }); source.complete(job.task_id, 'succeeded', 'legacy answer');
  const clock = source.session(job.session_key).last_response_at, previousBase = source.session(job.session_key).base_key;
  const route = JSON.parse(job.route_json), oldScope = hash([route.channelId, route.kind, route.targetId, route.senderId]);
  source.put('conversation:' + oldScope, { active: target.directory, aliases: { demo: { directory: target.directory, version: 2, source: 'explicit', messageId: job.message_id, valid: true } }, recent: [] });
  source.db.prepare("INSERT INTO metadata(key,value) VALUES ('wal-marker','committed')").run();
  mkdirSync(c.orchestration!.answers.root); writeFileSync(path.join(c.orchestration!.answers.root, 'existing-evidence.txt'), 'preserve');
  // This open connection retains WAL state; the maintenance service lock has no running owner.
  const report = await maintainV4(c, path.join(f.root, 'backups'));
  assert.equal(report.mode, 'dry-run'); assert.equal(report.requests, 1); assert.equal(report.bindings, 1);
  assert.equal(source.db.prepare('PRAGMA user_version').get()!.user_version, 3);
  assert.equal(source.session(job.session_key).last_response_at, clock); source.close();
  const backup = new DatabaseSync(path.join(report.backup, 'snapshot.sqlite'), { readOnly: true });
  assert.equal(backup.prepare("SELECT value FROM metadata WHERE key='wal-marker'").get()!.value, 'committed'); backup.close();
  const trial = new Store(path.join(report.backup, 'dry-run.sqlite'), c, true);
  assert.equal(trial.db.prepare('PRAGMA user_version').get()!.user_version, 4);
  assert.equal(trial.session(job.session_key).agent_ref_json, JSON.stringify({ kind: 'codex', threadId: 'original-native' }));
  assert.equal(trial.session(job.session_key).last_response_at, clock);
  const policy = trial.value<{ previousBase: string; nextBase: string; previousDigest: string; nextDigest: string }>('legacy-profile-migration:' + job.session_key)!;
  assert.equal(policy.previousBase, previousBase);
  assert.equal(policy.previousDigest, target.digest); assert.notEqual(policy.nextDigest, target.digest);
  assert.equal(trial.session(job.session_key).base_key, policy.nextBase);
  assert.equal(trial.db.prepare('SELECT profile_digest FROM business_bindings WHERE session_key=?').get(job.session_key)!.profile_digest, policy.nextDigest);
  assert.equal(new Directories(c, trial).resolve(conversationScope(route), 'demo').id, 'test'); trial.close();
  assert.equal(statSync(path.join(report.backup, 'snapshot.sqlite')).mode & 0o777, 0o600);
  assert.equal(readFileSync(path.join(report.backup, 'artifacts', 'existing-evidence.txt'), 'utf8'), 'preserve');
  const applied = await maintainV4(c, path.join(f.root, 'applied'), true);
  assert.equal(applied.mode, 'apply');
  const live = new Store(path.join(c.stateRoot, 'bridge.sqlite'), c);
  const scope = conversationScope(JSON.parse(job.route_json));
  live.put('orchestration:conversation:' + scope, { activeWorkspace: 'new-authoritative-state' }); live.close();
  await maintainV4(c, path.join(f.root, 'second-apply'), true);
  const again = new Store(path.join(c.stateRoot, 'bridge.sqlite'), c, true);
  assert.equal(again.value<{ activeWorkspace: string }>('orchestration:conversation:' + scope)!.activeWorkspace, 'new-authoritative-state');
  again.close();
});
test('OFFLINE maintenance migration: active owner and pending jobs stop migration', async t => {
  const f = setup(t), c = config(f), source = new Store(path.join(c.stateRoot, 'bridge.sqlite'), c);
  const release = acquireLock(c.stateRoot);
  await assert.rejects(maintainV4(c, path.join(f.root, 'backups')), /INSTANCE_LOCKED/); release();
  source.reserve(normalize(fixture('pending'), c, 'local:codex'), 'agent'); source.close();
  await assert.rejects(maintainV4(c, path.join(f.root, 'backups')), /MIGRATION_REQUIRES_DRAIN/);
});
test('OFFLINE maintenance migration: transient trust upgrade does not excuse changed operator profiles', async t => {
  const f = setup(t), c = config(f), legacy = parseConfig({ ...c, models: undefined, orchestration: undefined });
  const source = new Store(path.join(c.stateRoot, 'bridge.sqlite'), legacy), catalog = new Catalog(legacy), target = catalog.target(catalog.configured[0]!);
  const job = source.reserve(normalize(fixture('original'), legacy, 'local:codex'), 'agent', { ...target, reason: 'work', bind: true }).job;
  source.prepared(job.task_id, []); source.claim(); source.complete(job.task_id, 'succeeded', 'done');
  const previous = source.session(job.session_key); source.close();
  const changed = parseConfig({ ...c, routing: { ...c.routing, profiles: c.routing!.profiles.map(p => ({ ...p, version: '2' })) } });
  await assert.rejects(maintainV4(changed, path.join(f.root, 'changed-profile')), /MIGRATION_PROFILE_CHANGED/);
  const unchanged = new Store(path.join(c.stateRoot, 'bridge.sqlite'), legacy, true);
  assert.equal(unchanged.db.prepare('PRAGMA user_version').get()!.user_version, 3);
  assert.deepEqual(unchanged.session(job.session_key), previous); unchanged.close();
});
