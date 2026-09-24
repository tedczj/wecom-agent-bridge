import * as sqlite from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, readdirSync, copyFileSync, mkdirSync, chmodSync, writeFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import type { Config } from '../config.ts';
import { Store } from '../store.ts';
import { acquireLock, inside, privateDirectory } from '../fsutil.ts';
import { invariant } from '../errors.ts';
import { Catalog, type DirectoryGrant } from '../routing/catalog.ts';
import { hash } from '../routing/config.ts';
import { baseKey } from '../local.ts';
import type { NormalizedInput } from '../types.ts';
import { backendHomeKey, directoryIdentity } from '../history/catalog.ts';
import { conversationScope } from '../orchestration/requests.ts';
import type { State } from '../routing/router.ts';
import { migrateV4, type LegacyBinding } from './v4.ts';

function copyPrivateTree(source: string, destination: string): number {
  if (!existsSync(source)) return 0;
  invariant(lstatSync(source).isDirectory() && !lstatSync(source).isSymbolicLink(), 'BACKUP_UNSAFE_PATH');
  mkdirSync(destination, { mode: 0o700 }); let files = 0;
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    invariant(!entry.isSymbolicLink(), 'BACKUP_UNSAFE_PATH');
    const from = path.join(source, entry.name), to = path.join(destination, entry.name);
    if (entry.isDirectory()) files += copyPrivateTree(from, to);
    else {
      invariant(entry.isFile(), 'BACKUP_UNSAFE_PATH'); const before = lstatSync(from);
      copyFileSync(from, to); chmodSync(to, 0o600); const after = lstatSync(from);
      invariant(before.dev === after.dev && before.ino === after.ino && before.size === after.size && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs, 'BACKUP_SOURCE_CHANGED'); files++;
    }
  }
  return files;
}
export function legacyBindingResolver(store: Store, c: Config): (base: string, session: string) => LegacyBinding {
  return (base, sessionKey) => {
    const row = store.db.prepare('SELECT input_json FROM jobs WHERE session_key=? ORDER BY seq DESC LIMIT 1').get(sessionKey) as { input_json: string } | undefined;
    invariant(row, 'MIGRATION_BINDING_METADATA_REQUIRED');
    const input = JSON.parse(row.input_json) as NormalizedInput;
    invariant(input.routing, 'MIGRATION_BINDING_METADATA_REQUIRED');
    const oldScope = hash([input.route.channelId, input.route.kind, input.route.targetId, input.route.senderId]);
    const grants = store.value<DirectoryGrant[]>('directory-grants:' + oldScope) ?? [];
    const legacy = { ...c, models: undefined, orchestration: undefined };
    const previous = new Catalog(legacy, grants).target(input.routing.directory, input.routing.execution);
    invariant(previous.digest === input.routing.digest && baseKey(input.route, previous.directory.id, previous.digest) === base, 'MIGRATION_PROFILE_CHANGED');
    const target = new Catalog(c, grants).target(input.routing.directory, input.routing.execution);
    if (previous.digest !== target.digest) {
      // The explicit v4 migration introduces the fixed untrusted-project policy.
      // Keep native/session IDs and clocks, but rekey ownership to that policy;
      // the transaction and required backup preserve the original v3 identity.
      invariant(c.orchestration && target.config.backend === 'codex' && hash(previous.config) === hash(target.config), 'MIGRATION_PROFILE_CHANGED');
      const nextBase = baseKey(input.route, target.directory.id, target.digest);
      invariant(store.db.prepare('UPDATE sessions SET base_key=? WHERE session_key=? AND base_key=?').run(nextBase, sessionKey, base).changes === 1, 'MIGRATION_BINDING_MISMATCH');
      store.put('legacy-profile-migration:' + sessionKey, { previousBase: base, nextBase, previousDigest: previous.digest, nextDigest: target.digest,
        reason: 'hierarchical-native-policy', policies: { transientUntrustedProject: 'v1', contextWindow: 'usable-capacity-v1', workspacePermissions: 'scoped-git-v1' } });
    }
    return { conversationScope: conversationScope(input.route), directoryIdentity: directoryIdentity(target), backendHomeKey: backendHomeKey(target), profileDigest: target.digest };
  };
}
/** Import only authoritative directory state; expired choices and pending approvals are not revived. */
export function importRoutingState(store: Store, c: Config): void {
  const scopes = new Set<string>();
  for (const row of store.db.prepare('SELECT DISTINCT route_json FROM jobs').iterate()) {
    const route = JSON.parse(row.route_json as string), scope = conversationScope(route); if (scopes.has(scope)) continue; scopes.add(scope);
    const oldScope = hash([route.channelId, route.kind, route.targetId, route.senderId]);
    const grants = store.value<DirectoryGrant[]>('directory-grants:' + oldScope) ?? [], catalog = new Catalog(c, grants);
    for (const grant of grants) if (grant.version === catalog.version) catalog.validate(grant.directory);
    store.put('directory-grants:' + scope, grants.filter(grant => grant.version === catalog.version));
    const old = store.value<State>('conversation:' + oldScope);
    const state: import('../controllers/handoff.ts').ConversationState = {};
    if (old?.active) {
      const active = catalog.validate(old.active);
      state.activeWorkspace = active.id;
    }
    const aliases: Array<[string, string]> = [];
    for (const [name, alias] of Object.entries(old?.aliases ?? {})) {
      invariant(alias && typeof alias.valid === 'boolean' && typeof alias.messageId === 'string' && Number.isSafeInteger(alias.version), 'MIGRATION_ALIAS_REVIEW_REQUIRED');
      if (alias.valid) { catalog.validate(alias.directory); aliases.push([name, alias.directory.id]); }
      const source = store.db.prepare('SELECT task_id FROM jobs WHERE channel_id=? AND message_id=?').get(route.channelId, alias.messageId) as { task_id: string } | undefined;
      store.put('directory-alias:' + hash([scope, name]), { directoryRef: alias.directory.id, directory: alias.directory, sourceRequestId: source?.task_id ?? '',
        version: catalog.version, removed: !alias.valid, legacyVersion: alias.version, legacySource: alias.source, legacyMessageId: alias.messageId });
    }
    if (aliases.length) state.aliases = Object.fromEntries(aliases);
    store.put('orchestration:conversation:' + scope, state);
    // Legacy execution values lack trustworthy request/session-default provenance.
    // Keep them in the untouched v3 namespace; do not promote them to session-explicit.
  }
}
function assertDrained(store: Store): void {
  invariant(!store.db.prepare("SELECT 1 FROM jobs WHERE status IN ('preparing','queued','running','cancel_requested') LIMIT 1").get(), 'MIGRATION_REQUIRES_DRAIN');
  invariant(!store.db.prepare("SELECT 1 FROM outbox WHERE state='sending' LIMIT 1").get(), 'MIGRATION_DELIVERY_UNCERTAIN');
  if (store.db.prepare('PRAGMA user_version').get()!.user_version === 4) {
    invariant(!store.db.prepare("SELECT 1 FROM controller_effects WHERE state IN ('planned','submitting','uncertain') LIMIT 1").get(), 'MIGRATION_EFFECT_UNCERTAIN');
    invariant(!store.db.prepare("SELECT 1 FROM orchestration_requests WHERE phase NOT IN ('completed','failed','cancelled','interrupted') LIMIT 1").get(), 'MIGRATION_REQUIRES_DRAIN');
  }
}
export interface MigrationReport { backup: string; mode: 'dry-run' | 'apply'; sourceVersion: number; requests: number; bindings: number; artifactFiles: number; mediaFiles: number }
/** Holds the service lock and uses SQLite's online-backup API, including committed WAL pages. */
export async function maintainV4(c: Config, output: string, apply = false): Promise<MigrationReport> {
  invariant(c.orchestration && c.routing, 'HIERARCHICAL_CONFIG_REQUIRED');
  c.workspace.path = realpathSync(c.workspace.path);
  const source = path.join(c.stateRoot, 'bridge.sqlite'); invariant(existsSync(source), 'STATE_NOT_INITIALIZED');
  const artifactRoot = c.orchestration.answers.root;
  invariant(path.isAbsolute(output) && artifactRoot !== c.stateRoot && inside(c.stateRoot, artifactRoot) && !inside(c.workspace.path, output) && !inside(artifactRoot, output) && !inside(path.join(c.stateRoot, 'media'), output), 'BACKUP_UNSAFE_PATH');
  for (const home of [c.codex.home, c.agent.sessionRoot, c.orchestration.controllerRuntime.home]) invariant(!inside(home, artifactRoot) && !inside(artifactRoot, home), 'BACKUP_UNSAFE_PATH');
  const unlock = acquireLock(c.stateRoot); let sourceStore: Store | undefined;
  try {
    invariant(!existsSync(path.join(c.stateRoot, 'agent-process.json')) && !existsSync(path.join(c.stateRoot, 'routing-agent', 'state', 'agent-process.json')), 'AGENT_PROCESS_REVIEW_REQUIRED');
    for (const role of ['bridge', 'route', 'recap']) {
      const root = path.join(c.orchestration.controllerRuntime.workRoot, role); if (!existsSync(root)) continue;
      invariant(lstatSync(root).isDirectory() && !lstatSync(root).isSymbolicLink(), 'CONTROLLER_PROCESS_REVIEW_REQUIRED');
      for (const entry of readdirSync(root)) invariant(!existsSync(path.join(root, entry, 'process.json')), 'CONTROLLER_PROCESS_REVIEW_REQUIRED');
    }
    sourceStore = new Store(source, c, true); assertDrained(sourceStore);
    const dataVersion = sourceStore.db.prepare('PRAGMA data_version').get()!.data_version;
    const sourceVersion = sourceStore.db.prepare('PRAGMA user_version').get()!.user_version as number;
    invariant(sourceVersion === 3 || sourceVersion === 4, 'MIGRATION_SOURCE_VERSION');
    const root = privateDirectory(path.join(path.resolve(output), 'migration-' + randomUUID()));
    writeFileSync(path.join(root, '.gitignore'), '*\n', { mode: 0o600 });
    const backup = (sqlite as unknown as { backup?: (db: sqlite.DatabaseSync, destination: string) => Promise<number> }).backup;
    invariant(backup, 'SQLITE_BACKUP_UNAVAILABLE');
    const snapshot = path.join(root, 'snapshot.sqlite'); await backup(sourceStore.db, snapshot); chmodSync(snapshot, 0o600);
    const artifactFiles = copyPrivateTree(artifactRoot, path.join(root, 'artifacts'));
    const mediaFiles = copyPrivateTree(path.join(c.stateRoot, 'media'), path.join(root, 'media'));
    const trialFile = path.join(root, 'dry-run.sqlite'); await backup(sourceStore.db, trialFile); chmodSync(trialFile, 0o600);
    invariant(sourceStore.db.prepare('PRAGMA data_version').get()!.data_version === dataVersion, 'MIGRATION_SOURCE_CHANGED');
    const trial = new Store(trialFile, c);
    let migrated: { requests: number; bindings: number };
    try {
      migrated = trial.atomic(() => { const result = migrateV4(trial, legacyBindingResolver(trial, c)); if (sourceVersion === 3) importRoutingState(trial, c); return result; });
      invariant(trial.db.prepare('PRAGMA integrity_check').get()!.integrity_check === 'ok' && trial.db.prepare('PRAGMA foreign_key_check').all().length === 0, 'MIGRATION_INTEGRITY');
    } finally { trial.close(); }
    if (apply) {
      const live = new Store(source, c, 'maintenance');
      try { assertDrained(live); live.atomic(() => {
        invariant(sourceStore!.db.prepare('PRAGMA data_version').get()!.data_version === dataVersion && live.db.prepare('PRAGMA user_version').get()!.user_version === sourceVersion, 'MIGRATION_SOURCE_CHANGED');
        migrateV4(live, legacyBindingResolver(live, c)); if (sourceVersion === 3) importRoutingState(live, c);
      }); }
      finally { live.close(); }
    } else invariant(sourceStore.db.prepare('PRAGMA data_version').get()!.data_version === dataVersion, 'MIGRATION_SOURCE_CHANGED');
    sourceStore.close(); sourceStore = undefined;
    const report: MigrationReport = { backup: root, mode: apply ? 'apply' : 'dry-run', sourceVersion, ...migrated, artifactFiles, mediaFiles };
    writeFileSync(path.join(root, 'report.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 }); return report;
  } finally { sourceStore?.close(); unlock(); }
}
