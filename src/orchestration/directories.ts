import path from 'node:path';
import type { Config } from '../config.ts';
import type { Store } from '../store.ts';
import { Catalog, score, type Directory, type DirectoryGrant } from '../routing/catalog.ts';
import { hash } from '../routing/config.ts';
import { invariant } from '../errors.ts';
import { readConversationState } from '../controllers/handoff.ts';
import { RequestStore } from './requests.ts';

interface Consent { directory: Directory; version: string; digest: string; sourceRequestId: string; expiresAt: number; permissions: string }
interface AliasRecord { directoryRef: string; directory?: Directory; sourceRequestId: string; version: string; removed: boolean }

/** Only trusted transport scope and explicit control replies can grant a directory. */
export class Directories {
  private baseline: Catalog;
  constructor(private c: Config, private store: Store) { this.baseline = new Catalog(c); }
  catalog(scope: string): Catalog {
    invariant(hash(this.c.routing) === this.baseline.version, 'PROFILE_CHANGED');
    const grants = this.store.value<DirectoryGrant[]>('directory-grants:' + scope) ?? [];
    return new Catalog(this.c, grants, this.baseline);
  }
  resolve(scope: string, ref: string): Directory {
    const catalog = this.catalog(scope);
    const names = [ref, ...Object.entries(readConversationState(this.store, scope).aliases ?? {}).filter(([, value]) => value === ref).map(([name]) => name)];
    for (const name of names) {
      const alias = this.store.value<AliasRecord>('directory-alias:' + hash([scope, name]));
      if (alias && !alias.removed && alias.version === catalog.version) {
        if (alias.directory) return catalog.validate(alias.directory);
        ref = alias.directoryRef; break;
      }
    }
    const exact = catalog.directories.find(directory => directory.id === ref);
    if (exact) return catalog.validate(exact);
    if (path.isAbsolute(ref)) return catalog.describe(ref);
    const candidates = catalog.directories.map(directory => ({ directory, score: score(ref, directory) })).filter(item => item.score > 0).sort((a, b) => b.score - a.score);
    invariant(candidates[0] && (!candidates[1] || candidates[0].score > candidates[1].score), 'DIRECTORY_AMBIGUOUS');
    return catalog.validate(candidates[0].directory);
  }
  alias(scope: string, sourceRequestId: string, alias: string, directory: Directory | undefined): void {
    invariant(/^[\p{L}\p{N}][\p{L}\p{N} _.-]{0,63}$/u.test(alias), 'ALIAS_INVALID');
    new RequestStore(this.store).get(sourceRequestId, scope);
    const catalog = this.catalog(scope);
    if (directory) catalog.validate(directory);
    invariant(!catalog.configured.some(candidate => (candidate.id === alias || candidate.aliases.includes(alias)) && candidate.id !== directory?.id), 'ALIAS_CONFIGURED');
    const state = readConversationState(this.store, scope);
    const aliases = new Map(Object.entries(state.aliases ?? {}));
    if (directory) aliases.set(alias, directory.id); else aliases.delete(alias);
    state.aliases = Object.fromEntries(aliases);
    this.store.atomic(() => {
      this.store.put('directory-alias:' + hash([scope, alias]), { directoryRef: directory?.id ?? '', directory, sourceRequestId, version: catalog.version, removed: !directory } satisfies AliasRecord);
      this.store.put('orchestration:conversation:' + scope, state);
    });
  }
  propose(scope: string, sourceRequestId: string, directoryPath: string): Consent {
    const request = new RequestStore(this.store).get(sourceRequestId, scope);
    invariant(request.phase === 'bridge_planning' && !request.job_task_id && !request.source_request_id, 'AUTHORIZATION_REQUEST_STATE');
    const catalog = this.catalog(scope), directory = catalog.propose(directoryPath, catalog.authorizationProfile());
    const granted = new Catalog(this.c, [{ directory, version: catalog.version }], catalog);
    const target = granted.target(directory);
    const consent: Consent = { directory, version: catalog.version,
      digest: hash([target.digest, this.c.models, this.c.orchestration?.business]), sourceRequestId, expiresAt: Date.now() + 900000,
      permissions: target.config.backend === 'codex' ? `codex / ${target.config.codex.sandbox} / network=${target.config.codex.networkAccess}` : 'pi / 已配置的外部权限策略' };
    this.store.atomic(() => {
      this.store.put('directory-consent:' + scope, consent);
      this.store.db.prepare('UPDATE orchestration_requests SET route_snapshot_json=? WHERE request_id=?').run(JSON.stringify({ pendingSelection: true, expiresAt: consent.expiresAt, authorization: true }), sourceRequestId);
    });
    return consent;
  }
  approve(scope: string, controlRequestId: string): { directory: Directory; sourceRequestId: string } {
    return this.store.atomic(() => {
      const consent = this.store.value<Consent>('directory-consent:' + scope), catalog = this.catalog(scope);
      invariant(consent && consent.version === catalog.version && Date.now() < consent.expiresAt, 'AUTHORIZATION_EXPIRED');
      const proposed = catalog.propose(consent.directory.path, consent.directory.profile);
      invariant(proposed.identity === consent.directory.identity, 'DIRECTORY_CHANGED');
      const granted = new Catalog(this.c, [{ directory: proposed, version: catalog.version }], catalog);
      invariant(hash([granted.target(proposed).digest, this.c.models, this.c.orchestration?.business]) === consent.digest, 'PROFILE_CHANGED');
      const requests = new RequestStore(this.store); requests.referencePending(controlRequestId, consent.sourceRequestId, scope);
      const grant: DirectoryGrant = { directory: proposed, version: catalog.version, requestTaskId: consent.sourceRequestId, approvalMessageId: controlRequestId };
      const previous = this.store.value<DirectoryGrant[]>('directory-grants:' + scope) ?? [];
      this.store.put('directory-grants:' + scope, [...previous.filter(item => item.directory.id !== proposed.id), grant]);
      this.store.db.prepare('UPDATE orchestration_requests SET route_snapshot_json=? WHERE request_id=?').run(JSON.stringify({ forcedDirectoryRef: proposed.id }), controlRequestId);
      this.store.put('directory-consent:' + scope, null);
      return { directory: proposed, sourceRequestId: consent.sourceRequestId };
    });
  }
  cancelConsent(scope: string): void { this.store.put('directory-consent:' + scope, null); }
}
