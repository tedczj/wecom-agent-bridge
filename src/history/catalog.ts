import path from 'node:path';
import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { invariant } from '../errors.ts';
import { inside } from '../fsutil.ts';
import type { Store } from '../store.ts';
import type { SessionRef } from '../types.ts';
import type { Target } from '../routing/catalog.ts';
import { sha256 } from '../orchestration/requests.ts';
import { nativeRoot, nativeFiles, nativeHeader } from './files.ts';
import type { ResumeCheck } from './verifier.ts';

export interface CandidateMetadata {
  ref: SessionRef; file: string; title: string; createdAt: number | null; updatedAt: number | null;
  lastCompletedAt: number | null; role: 'business' | 'external' | 'unknown'; sourceRevision: string;
}
export interface CandidatePage {
  entries: CandidateMetadata[]; nextCursor?: string; discoveryCoverage: 'complete' | 'partial' | 'unknown';
  orderBasis: 'last-completed-response' | 'updated-at' | 'created-at' | 'unknown'; diagnostics: string[];
}
export const backendHomeKey = (target: Target): string => sha256(JSON.stringify([target.config.backend,
  target.config.backend === 'codex' ? target.config.codex.home : target.config.agent.sessionRoot]));
export const directoryIdentity = (target: Pick<Target, 'directory'>): string => sha256(JSON.stringify([target.directory.path, target.directory.identity]));
export function historyRevision(file: string): string {
  const stat = lstatSync(file); invariant(stat.isFile() && !stat.isSymbolicLink(), 'HISTORY_PATH');
  return sha256(JSON.stringify([stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs]));
}

/** Metadata only: locating one bound native ID never opens unrelated session bodies. */
export class NativeCatalog {
  constructor(private store: Store, private conversationScope: string) {}
  /** Reuse only completed verification for this exact file revision; never derive completion from file timestamps. */
  recordVerified(target: Target, candidate: CandidateMetadata, check: ResumeCheck): void {
    invariant(target.digest === check.profileDigest && JSON.stringify(candidate.ref) === JSON.stringify(check.ref) &&
      check.sourceRevision === candidate.sourceRevision && historyRevision(candidate.file) === check.sourceRevision, 'HISTORY_CHANGED');
    const home = backendHomeKey(target), id = candidate.ref.kind === 'codex' ? candidate.ref.threadId : candidate.ref.sessionId;
    invariant(target.config.backend === candidate.ref.kind && this.metadata(target, { id, cwd: target.directory.path, rollout_path: candidate.file }), 'HISTORY_SCOPE');
    const existing = this.store.db.prepare('SELECT role,directory_identity FROM native_session_catalog WHERE backend_home_key=? AND backend=? AND native_id=?')
      .get(home, target.config.backend, id) as { role: string; directory_identity: string | null } | undefined;
    invariant(!existing || !['bridge', 'route', 'recap'].includes(existing.role) && (!existing.directory_identity || existing.directory_identity === directoryIdentity(target)), 'HISTORY_SCOPE');
    this.store.db.prepare(`INSERT INTO native_session_catalog(native_ref_key,backend_home_key,backend,native_id,directory_identity,native_ref_json,role,
      source_revision,created_at,last_completed_at,last_completed_basis,observed_model_json,verification_state,observed_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,'verified-native-completion',?,'verified',?) ON CONFLICT(backend_home_key,backend,native_id) DO UPDATE SET
      directory_identity=excluded.directory_identity,role=excluded.role,native_ref_json=excluded.native_ref_json,
      source_revision=excluded.source_revision,last_completed_at=excluded.last_completed_at,last_completed_basis=excluded.last_completed_basis,
      observed_model_json=excluded.observed_model_json,verification_state=excluded.verification_state,observed_at=excluded.observed_at`)
      .run(sha256(JSON.stringify([home, id])), home, target.config.backend, id, directoryIdentity(target), JSON.stringify(candidate.ref), this.store.nativeOwner(candidate.ref) ? 'business' : candidate.role,
        check.sourceRevision, candidate.createdAt, check.lastCompletedAt, JSON.stringify({ profileDigest: check.profileDigest }), Date.now());
  }
  private ordered(page: CandidatePage): CandidatePage {
    if (page.discoveryCoverage !== 'complete' || !page.entries.length || page.entries.some(entry => entry.lastCompletedAt === null)) return page;
    return { ...page, orderBasis: 'last-completed-response', entries: [...page.entries].sort((a, b) => b.lastCompletedAt! - a.lastCompletedAt! || a.file.localeCompare(b.file)) };
  }
  private index(target: Target): DatabaseSync | undefined {
    if (target.config.backend !== 'codex') return;
    const file = path.join(target.config.codex.home, 'state_5.sqlite');
    if (!existsSync(file)) return;
    invariant(!lstatSync(file).isSymbolicLink() && realpathSync(file) === file, 'HISTORY_PATH');
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      db.exec('PRAGMA busy_timeout=1000;');
      const columns = db.prepare('PRAGMA table_info(threads)').all() as { name: string }[];
      invariant(['id', 'cwd', 'rollout_path', 'archived', 'created_at', 'updated_at', 'title'].every(name => columns.some(col => col.name === name)), 'HISTORY_INDEX_SCHEMA');
      return db;
    } catch (error) { db.close(); throw error; }
  }
  private metadata(target: Target, row: Record<string, unknown>): CandidateMetadata | undefined {
    invariant(typeof row.id === 'string' && /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(row.id) && typeof row.cwd === 'string' && typeof row.rollout_path === 'string', 'HISTORY_METADATA');
    invariant(realpathSync(row.cwd) === target.directory.path, 'HISTORY_SCOPE');
    const file = row.rollout_path, root = nativeRoot(target);
    invariant(path.isAbsolute(file) && inside(root, file) && realpathSync(file) === file, 'HISTORY_PATH');
    const revision = historyRevision(file), homeKey = backendHomeKey(target);
    const registered = this.store.db.prepare('SELECT role,source_revision,last_completed_at,verification_state,directory_identity FROM native_session_catalog WHERE backend_home_key=? AND backend=? AND native_id=?')
      .get(homeKey, target.config.backend, row.id) as Record<string, unknown> | undefined;
    if (registered && ['bridge', 'route', 'recap'].includes(String(registered.role))) return;
    const ref: SessionRef = target.config.backend === 'codex' ? { kind: 'codex', threadId: row.id } : { kind: 'pi', sessionId: row.id, sessionFile: file, hasHistory: true };
    const owner = this.store.nativeOwner(ref);
    if (owner) {
      const scopes = this.store.db.prepare(`SELECT DISTINCT r.conversation_scope FROM orchestration_requests r
        JOIN jobs j ON j.task_id=r.job_task_id WHERE j.session_key=?`).all(owner.session_key) as { conversation_scope: string }[];
      if (scopes.length !== 1 || scopes[0]!.conversation_scope !== this.conversationScope) return;
    }
    if (registered?.directory_identity) invariant(registered.directory_identity === directoryIdentity(target), 'HISTORY_SCOPE');
    const timestamp = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && Number.isSafeInteger(value * 1000) ? value * 1000 : null;
    return { ref, file,
      title: typeof row.title === 'string' ? Array.from(row.title).slice(0, 120).join('') : '',
      createdAt: timestamp(row.created_at), updatedAt: timestamp(row.updated_at), sourceRevision: revision,
      lastCompletedAt: registered?.verification_state === 'verified' && registered.source_revision === revision && typeof registered.last_completed_at === 'number' ? registered.last_completed_at : null,
      role: registered?.role === 'business' ? 'business' : registered?.role === 'unknown' ? 'unknown' : 'external' };
  }
  async listMetadata(target: Target, cursor?: string, limit = 10): Promise<CandidatePage> {
    invariant(Number.isSafeInteger(limit) && limit >= 1 && limit <= 100, 'HISTORY_LIMIT');
    invariant(cursor === undefined || /^\d{1,6}$/.test(cursor), 'HISTORY_CURSOR');
    const offset = Number(cursor ?? 0); invariant(offset <= 100000, 'HISTORY_CURSOR');
    const db = this.index(target);
    if (!db) {
      const scan = await nativeFiles(target), entries: CandidateMetadata[] = [], diagnostics = [...scan.diagnostics];
      for (const file of scan.files.slice(offset, offset + limit)) {
        try {
          const row = await nativeHeader(target, file);
          if (typeof row.cwd === 'string' && realpathSync(row.cwd) !== target.directory.path) continue;
          const entry = this.metadata(target, row); if (entry) entries.push(entry);
        } catch { diagnostics.push('CANDIDATE_UNVERIFIED'); }
      }
      const nextCursor = offset + limit < scan.files.length ? String(offset + limit) : undefined;
      return this.ordered({ entries, nextCursor, discoveryCoverage: diagnostics.length || nextCursor || cursor !== undefined ? 'partial' : 'complete', orderBasis: 'unknown', diagnostics });
    }
    try {
      db.exec('BEGIN');
      // Older CLI entries can record a symlink alias. Resolve directory metadata only,
      // otherwise an exact string WHERE cwd clause could falsely claim no history.
      const directories = db.prepare('SELECT DISTINCT cwd FROM threads WHERE archived=0 LIMIT 10001').all() as { cwd: string }[];
      invariant(directories.length <= 10000, 'HISTORY_SCAN_LIMIT');
      const aliases = directories.flatMap(row => {
        try { return typeof row.cwd === 'string' && path.isAbsolute(row.cwd) && realpathSync(row.cwd) === target.directory.path ? [row.cwd] : []; }
        catch { return []; }
      });
      const rows = aliases.length ? db.prepare(`SELECT id,cwd,rollout_path,title,created_at,updated_at FROM threads WHERE cwd IN (${aliases.map(() => '?').join(',')})
        AND archived=0 ORDER BY updated_at DESC,id LIMIT ? OFFSET ?`).all(...aliases, limit + 1, offset) as Array<Record<string, unknown>> : [];
      const entries: CandidateMetadata[] = [], diagnostics: string[] = [];
      for (const row of rows.slice(0, limit)) {
        try { const entry = this.metadata(target, row); if (entry) entries.push(entry); }
        catch { diagnostics.push('CANDIDATE_UNVERIFIED'); }
      }
      const nextCursor = rows.length > limit ? String(offset + limit) : undefined;
      return this.ordered({ entries, nextCursor, discoveryCoverage: diagnostics.length || nextCursor || cursor !== undefined ? 'partial' : 'complete', orderBasis: 'updated-at', diagnostics });
    } finally { db.close(); }
  }
  async locateExact(target: Target, ref: SessionRef): Promise<CandidateMetadata> {
    invariant(target.config.backend === ref.kind, 'HISTORY_BACKEND');
    const db = this.index(target);
    if (!db) {
      let file: string;
      if (ref.kind === 'pi') file = ref.sessionFile;
      else {
        const scan = await nativeFiles(target), matches = scan.files.filter(file => path.basename(file).includes(ref.threadId));
        invariant(matches.length === 1, matches.length > 1 ? 'HISTORY_EXACT_AMBIGUOUS' : scan.files.length || scan.diagnostics.length ? 'HISTORY_DISCOVERY_UNVERIFIED' : 'HISTORY_EXACT_NOT_FOUND');
        file = matches[0]!;
      }
      const row = await nativeHeader(target, file);
      invariant(row.id === (ref.kind === 'codex' ? ref.threadId : ref.sessionId), 'HISTORY_SCOPE');
      const entry = this.metadata(target, row); invariant(entry, 'HISTORY_SESSION_UNAVAILABLE'); return entry;
    }
    try {
      invariant(ref.kind === 'codex', 'HISTORY_BACKEND');
      const row = db.prepare('SELECT id,cwd,rollout_path,title,created_at,updated_at FROM threads WHERE id=?').get(ref.threadId) as Record<string, unknown> | undefined;
      invariant(row, 'HISTORY_EXACT_NOT_FOUND');
      const entry = this.metadata(target, row); invariant(entry, 'HISTORY_SESSION_UNAVAILABLE');
      const header = await nativeHeader(target, entry.file);
      invariant(header.id === ref.threadId && typeof header.cwd === 'string' && realpathSync(header.cwd) === target.directory.path, 'HISTORY_SCOPE');
      invariant(historyRevision(entry.file) === entry.sourceRevision, 'HISTORY_CHANGED'); return entry;
    } finally { db.close(); }
  }
}
