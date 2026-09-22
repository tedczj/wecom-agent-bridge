import { DatabaseSync } from 'node:sqlite';
import { randomUUID, createHash } from 'node:crypto';
import { chmodSync, existsSync, lstatSync } from 'node:fs';
import type { Config } from './config.ts';
import type { Incoming, Job, JobStatus, Session, SessionRef, NormalizedInput, ImageRef, Delivery, DeliveryState } from './types.ts';
import { invariant } from './errors.ts';
import { baseKey } from './local.ts';
import { boundedResult, resultParts } from './reply.ts';
const schema = `
CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sessions (
 session_key TEXT PRIMARY KEY, base_key TEXT NOT NULL, generation INTEGER NOT NULL,
 backend TEXT NOT NULL, workspace_id TEXT NOT NULL, actor_id TEXT NOT NULL, agent_ref_json TEXT,
 state TEXT NOT NULL CHECK(state IN ('new','ready','tainted')), created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
 UNIQUE(base_key,generation));
CREATE TABLE IF NOT EXISTS jobs (
 seq INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL UNIQUE, channel_id TEXT NOT NULL, message_id TEXT NOT NULL,
 request_hash TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('agent','command')), session_key TEXT NOT NULL REFERENCES sessions(session_key),
 route_json TEXT NOT NULL, input_json TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('preparing','queued','running','cancel_requested','succeeded','failed','cancelled','timed_out','interrupted')),
 result_text TEXT, error_code TEXT, reviewed_at INTEGER, created_at INTEGER NOT NULL, started_at INTEGER, finished_at INTEGER,
 UNIQUE(channel_id,message_id));
CREATE TABLE IF NOT EXISTS outbox (
 delivery_id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES jobs(task_id), purpose TEXT NOT NULL, part_no INTEGER NOT NULL,
 target_json TEXT NOT NULL, body_json TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('pending','sending','sent','unknown','failed')),
 attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at INTEGER, last_error_code TEXT, created_at INTEGER NOT NULL, sent_at INTEGER,
 UNIQUE(task_id,purpose,part_no));
CREATE INDEX IF NOT EXISTS jobs_status_seq ON jobs(status,seq);
CREATE INDEX IF NOT EXISTS outbox_state_due ON outbox(state,next_attempt_at);
`;
export interface Selection {
  config: Config; digest: string; directory: import('./routing/catalog.ts').Directory; reason: string;
  sessionKey?: string; fresh?: boolean; bind?: boolean; ref?: SessionRef; lastResponseAt?: number | null;
}
export class Store {
  readonly db: DatabaseSync; private depth = 0;
  constructor(file: string, private c: Config, readOnly = false) {
    if (file !== ':memory:') for (const name of [file, file + '-wal', file + '-shm']) if (existsSync(name)) invariant(!lstatSync(name).isSymbolicLink(), 'UNSAFE_DB_PATH');
    this.db = new DatabaseSync(file, { readOnly });
    try {
      const version = (this.db.prepare('PRAGMA user_version').get() as {user_version: number}).user_version;
      // No implicit migration/replay of historical network-origin tasks. Keep the old database untouched.
      invariant(version === 0 || version === 2 || version === 3, version === 1 ? 'LEGACY_STATE_REQUIRES_NEW_ROOT' : 'SCHEMA_TOO_NEW');
      this.db.exec('PRAGMA busy_timeout=5000;');
      if (readOnly) {
        invariant(version === 2 || version === 3, 'STATE_NOT_INITIALIZED');
        const identity = this.db.prepare("SELECT value FROM metadata WHERE key='identity'").get() as {value: string} | undefined;
        invariant(identity?.value === JSON.stringify([c.workspace.id, c.workspace.path, c.local.actorId]), 'STATE_IDENTITY_MISMATCH');
        return;
      }
      this.db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
      const identity = JSON.stringify([c.workspace.id, c.workspace.path, c.local.actorId]);
      this.atomic(() => {
        this.db.exec(schema);
        if (!(this.db.prepare('PRAGMA table_info(sessions)').all() as {name:string}[]).some(x => x.name === 'last_response_at')) this.db.exec('ALTER TABLE sessions ADD COLUMN last_response_at INTEGER;');
        this.db.exec('CREATE TABLE IF NOT EXISTS routing_state (key TEXT PRIMARY KEY,value TEXT NOT NULL);');
        const old = this.db.prepare("SELECT value FROM metadata WHERE key='identity'").get() as {value: string} | undefined;
        invariant(!old || old.value === identity, 'STATE_IDENTITY_MISMATCH');
        this.db.prepare("INSERT OR IGNORE INTO metadata(key,value) VALUES ('identity',?)").run(identity);
        const homeKey = 'home:' + c.backend, home = c.backend === 'codex' ? c.codex.home : c.agent.sessionRoot;
        const priorHome = this.db.prepare('SELECT value FROM metadata WHERE key=?').get(homeKey) as {value: string} | undefined;
        invariant(!priorHome || priorHome.value === home, 'STATE_BACKEND_HOME_MISMATCH');
        this.db.prepare('INSERT OR IGNORE INTO metadata(key,value) VALUES (?,?)').run(homeKey, home);
        this.db.exec('PRAGMA user_version=3;');
      });
      if (file !== ':memory:') for (const name of [file, file + '-wal', file + '-shm']) if (existsSync(name)) chmodSync(name, 0o600);
    } catch (e) { this.db.close(); throw e; }
  }
  value<T>(key: string): T | undefined {
    const row = this.db.prepare('SELECT value FROM routing_state WHERE key=?').get(key) as {value:string} | undefined;
    return row ? JSON.parse(row.value) as T : undefined;
  }
  put(key: string, value: unknown): void { this.db.prepare('INSERT INTO routing_state(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key,JSON.stringify(value)); }
  duplicate(incoming: Incoming): Job | undefined {
    const job = this.db.prepare('SELECT * FROM jobs WHERE channel_id=? AND message_id=?').get(incoming.route.channelId,incoming.messageId) as (Job & {request_hash:string}) | undefined;
    if (job) invariant(job.request_hash === createHash('sha256').update(JSON.stringify([incoming.route,incoming.text,incoming.media])).digest('hex'),'REQUEST_ID_CONFLICT');
    return job;
  }
  bound(base: string): Session | undefined {
    const key = this.value<string>('binding:' + base); return key ? this.session(key) : undefined;
  }
  busy(key: string): boolean { return !!this.db.prepare("SELECT 1 FROM jobs WHERE session_key=? AND kind='agent' AND status IN ('preparing','queued','running','cancel_requested')").get(key); }
  sessions(base: string): Session[] { return this.db.prepare('SELECT * FROM sessions WHERE base_key=? ORDER BY created_at DESC').all(base) as unknown as Session[]; }
  nativeOwner(ref: SessionRef): Session | undefined {
    const field = ref.kind === 'codex' ? 'threadId' : 'sessionId', id = ref.kind === 'codex' ? ref.threadId : ref.sessionId;
    return this.db.prepare(`SELECT * FROM sessions WHERE backend=? AND json_extract(agent_ref_json,'$.${field}')=? LIMIT 1`).get(ref.kind,id) as Session | undefined;
  }
  close(): void { this.db.close(); }
  atomic<T>(fn: () => T): T {
    if (this.depth) return fn();
    this.db.exec('BEGIN IMMEDIATE'); this.depth++;
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (e) { this.db.exec('ROLLBACK'); throw e; }
    finally { this.depth--; }
  }
  private latest(base: string): Session | undefined { return this.db.prepare('SELECT * FROM sessions WHERE base_key=? ORDER BY generation DESC LIMIT 1').get(base) as Session | undefined; }
  session(key: string): Session { const s = this.db.prepare('SELECT * FROM sessions WHERE session_key=?').get(key) as Session | undefined; invariant(s, 'SESSION_MISSING'); return s; }
  private createSession(base: string, actor: string, generation: number, config = this.c): Session {
    const key = base + ':' + generation, now = Date.now();
    this.db.prepare("INSERT INTO sessions(session_key,base_key,generation,backend,workspace_id,actor_id,state,created_at,updated_at) VALUES (?,?,?,?,?,?,'new',?,?)").run(key, base, generation, config.backend, config.workspace.id, actor, now, now);
    return this.session(key);
  }
  get(taskId: string): Job { const j = this.db.prepare('SELECT * FROM jobs WHERE task_id=?').get(taskId) as Job | undefined; invariant(j, 'TASK_NOT_FOUND'); return j; }
  reserve(incoming: Incoming, kind: 'agent' | 'command', selection?: Selection): {job: Job; duplicate: boolean} {
    return this.atomic(() => {
      const digest = createHash('sha256').update(JSON.stringify([incoming.route, incoming.text, incoming.media])).digest('hex');
      const duplicate = this.db.prepare('SELECT * FROM jobs WHERE channel_id=? AND message_id=?').get(incoming.route.channelId, incoming.messageId) as (Job & {request_hash: string}) | undefined;
      if (duplicate) { invariant(duplicate.request_hash === digest, 'REQUEST_ID_CONFLICT'); return { job: duplicate, duplicate: true }; }
      const config = selection?.config ?? this.c;
      const base = baseKey(incoming.route, config.workspace.id, selection?.digest ?? config.backend);
      const session = selection?.sessionKey ? this.session(selection.sessionKey)
        : selection?.fresh ? this.createSession(base,incoming.route.senderId,(this.latest(base)?.generation ?? -1)+1,config)
        : this.latest(base) ?? this.createSession(base, incoming.route.senderId, 0, config);
      invariant(session.base_key === base, 'SESSION_OWNER_MISMATCH');
      if (selection?.ref) {
        this.persistSession(session.session_key, selection.ref);
        this.db.prepare('UPDATE sessions SET last_response_at=? WHERE session_key=?').run(selection.lastResponseAt ?? null,session.session_key);
      }
      if (selection?.bind) {
        this.put('binding:' + base,session.session_key);
        if (selection.reason === 'explicit-resume') this.put('explicit:' + base,session.session_key);
        else if (kind === 'agent') this.put('explicit:' + base,null);
      }
      if (kind === 'agent') {
        invariant(!this.blocked(), 'WORKSPACE_BLOCKED'); invariant(session.state !== 'tainted', 'SESSION_TAINTED');
        const n = this.db.prepare("SELECT count(*) n FROM jobs WHERE kind='agent' AND status IN ('preparing','queued')").get() as {n: number};
        const own = this.db.prepare("SELECT count(*) n FROM jobs WHERE session_key=? AND kind='agent' AND status IN ('preparing','queued')").get(session.session_key) as {n: number};
        invariant(n.n < this.c.queue.maxPendingGlobal && own.n < this.c.queue.maxPendingPerSession, 'QUEUE_FULL');
      }
      const input: NormalizedInput = { taskId: randomUUID(), messageId: incoming.messageId, route: incoming.route, receivedAt: incoming.receivedAt, text: incoming.text, images: [], workspaceId: config.workspace.id, routing: selection ? {directory:selection.directory,digest:selection.digest,reason:selection.reason} : undefined, sessionKey: session.session_key, generation: session.generation };
      this.db.prepare('INSERT INTO jobs(task_id,channel_id,message_id,request_hash,kind,session_key,route_json,input_json,status,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)').run(input.taskId, incoming.route.channelId, incoming.messageId, digest, kind, session.session_key, JSON.stringify(incoming.route), JSON.stringify(input), kind === 'agent' ? 'preparing' : 'queued', Date.now());
      return { job: this.get(input.taskId), duplicate: false };
    });
  }
  prepared(taskId: string, images: ImageRef[]): boolean {
    const input: NormalizedInput = JSON.parse(this.get(taskId).input_json); input.images = images;
    return this.db.prepare("UPDATE jobs SET input_json=?,status='queued' WHERE task_id=? AND status='preparing'").run(JSON.stringify(input), taskId).changes === 1;
  }
  claim(): Job | undefined {
    return this.atomic(() => {
      if (this.blocked() || this.db.prepare("SELECT 1 FROM jobs WHERE status IN ('running','cancel_requested') LIMIT 1").get()) return;
      const next = this.db.prepare("SELECT j.* FROM jobs j WHERE j.kind='agent' AND j.status='queued' AND NOT EXISTS (SELECT 1 FROM jobs p WHERE (p.session_key=j.session_key OR json_extract(j.input_json,'$.routing') IS NOT NULL) AND p.seq<j.seq AND p.status IN ('preparing','queued','running','cancel_requested')) ORDER BY j.seq LIMIT 1").get() as Job | undefined;
      if (!next) return;
      this.db.prepare("UPDATE jobs SET status='running',started_at=? WHERE task_id=? AND status='queued'").run(Date.now(), next.task_id); return this.get(next.task_id);
    });
  }
  persistSession(key: string, ref: SessionRef): void {
    invariant(this.session(key).state !== 'tainted', 'SESSION_TAINTED');
    const owner = this.db.prepare('SELECT backend FROM sessions WHERE session_key=?').get(key) as {backend: string};
    invariant(owner.backend === ref.kind, 'SESSION_BACKEND_MISMATCH');
    this.db.prepare("UPDATE sessions SET agent_ref_json=?,state='ready',updated_at=? WHERE session_key=?").run(JSON.stringify(ref), Date.now(), key);
  }
  complete(taskId: string, status: JobStatus, text: string, code?: string, expected: JobStatus[] = ['running','cancel_requested','preparing','queued'], directParts?: string[]): boolean {
    invariant(['succeeded','failed','cancelled','timed_out','interrupted'].includes(status), 'INVALID_TERMINAL');
    return this.atomic(() => {
      const job = this.get(taskId); if (!expected.includes(job.status)) return false;
      if (job.status === 'cancel_requested' && status === 'succeeded') { status = 'cancelled'; text = '任务已取消；可能已经产生部分代码修改，请检查工作目录。'; }
      const bounded = boundedResult(text, this.c.reply.maxResultBytes);
      this.db.prepare('UPDATE jobs SET status=?,result_text=?,error_code=?,finished_at=? WHERE task_id=?').run(status, bounded.text, bounded.truncated ? 'OUTPUT_TRUNCATED' : code ?? null, Date.now(), taskId);
      if (status === 'succeeded' && job.kind === 'agent' && text.trim()) this.db.prepare('UPDATE sessions SET last_response_at=? WHERE session_key=?').run(Date.now(),job.session_key);
      if (status === 'interrupted') this.db.prepare("UPDATE sessions SET state='tainted' WHERE session_key=?").run(job.session_key);
      if (directParts) invariant(job.kind === 'command' && directParts.every(p => Buffer.byteLength(p) <= this.c.reply.chunkBytes), 'REPLY_TOO_LARGE');
      const pieces = directParts ?? resultParts(taskId, bounded.text, this.c.reply.chunkBytes);
      for (const [i, piece] of pieces.slice(0, this.c.reply.maxAutoParts).entries())
        this.db.prepare("INSERT INTO outbox(delivery_id,task_id,purpose,part_no,target_json,body_json,state,created_at) VALUES (?,?,?,?,?,?,'pending',?)").run(randomUUID(), taskId, job.kind === 'command' ? 'control' : 'final', i + 1, job.route_json, JSON.stringify({ text: piece }), Date.now());
      return true;
    });
  }
  owned(owner: Job, prefix: string): Job {
    invariant(/^(?:[0-9a-f]{8}|[0-9a-f]{8}-[0-9a-f-]{27})$/.test(prefix), 'TASK_ID_INVALID');
    const routed=!!JSON.parse(owner.input_json).routing;
    const jobs = this.db.prepare(`SELECT j.* FROM jobs j JOIN sessions s ON s.session_key=j.session_key WHERE ${routed?'j.route_json':'s.base_key'}=? AND j.task_id LIKE ? AND j.kind='agent' LIMIT 2`).all(routed?owner.route_json:this.session(owner.session_key).base_key, prefix + '%') as unknown as Job[];
    invariant(jobs.length === 1, 'TASK_NOT_FOUND'); return jobs[0]!;
  }
  cancel(taskId: string): JobStatus {
    return this.atomic(() => {
      const job = this.get(taskId);
      if (['queued','preparing'].includes(job.status)) this.complete(taskId, 'cancelled', '任务已取消，尚未开始执行。');
      else if (job.status === 'running') this.db.prepare("UPDATE jobs SET status='cancel_requested' WHERE task_id=? AND status='running'").run(taskId);
      return this.get(taskId).status;
    });
  }
  activeFor(owner: Job): Job | undefined {
    const routed=!!JSON.parse(owner.input_json).routing;
    return this.db.prepare(`SELECT j.* FROM jobs j JOIN sessions s ON s.session_key=j.session_key WHERE ${routed?'j.route_json':'s.base_key'}=? AND j.kind='agent' AND j.status IN ('preparing','queued','running','cancel_requested') ORDER BY CASE WHEN j.status IN ('running','cancel_requested') THEN 0 ELSE 1 END,j.seq DESC LIMIT 1`).get(routed?owner.route_json:this.session(owner.session_key).base_key) as Job | undefined;
  }
  newGeneration(owner: Job): number {
    invariant(!this.activeFor(owner), 'SESSION_BUSY'); invariant(!this.blocked(), 'WORKSPACE_BLOCKED');
    const old = this.session(owner.session_key), route = JSON.parse(owner.route_json);
    return this.createSession(old.base_key, route.senderId, (this.latest(old.base_key)?.generation ?? 0) + 1).generation;
  }
  blocked(): boolean { return !!this.db.prepare("SELECT 1 FROM jobs WHERE status='interrupted' AND reviewed_at IS NULL LIMIT 1").get(); }
  recover(): void {
    this.atomic(() => {
      for (const row of this.db.prepare("SELECT * FROM jobs WHERE status IN ('preparing','running','cancel_requested') OR (kind='command' AND status='queued')").all() as unknown as Job[]) {
        const interrupted = ['running','cancel_requested'].includes(row.status);
        this.complete(row.task_id, interrupted ? 'interrupted' : 'failed', interrupted ? '执行被中断，可能已修改代码；请在本地检查进程和 git diff 后恢复。' : '输入准备或控制命令被中断，请重新提交。', interrupted ? 'EXECUTION_INTERRUPTED' : 'MEDIA_PREPARATION_INTERRUPTED');
      }
      this.db.prepare("UPDATE outbox SET state='unknown',last_error_code='DELIVERY_INTERRUPTED' WHERE state='sending'").run();
    });
  }
  review(): number { return Number(this.db.prepare("UPDATE jobs SET reviewed_at=? WHERE status='interrupted' AND reviewed_at IS NULL").run(Date.now()).changes); }
  activeMedia(): Set<string> { return new Set((this.db.prepare("SELECT task_id FROM jobs WHERE status IN ('preparing','queued','running','cancel_requested')").all() as {task_id: string}[]).map(x => x.task_id)); }
  summary(owner?: Job): unknown {
    const where = owner ? ' WHERE s.base_key=?' : '', args = owner ? [this.session(owner.session_key).base_key] : [];
    const jobs = this.db.prepare(`SELECT j.task_id,j.status,j.error_code FROM jobs j JOIN sessions s ON s.session_key=j.session_key${where} ORDER BY j.seq DESC LIMIT 12`).all(...args);
    const deliveries = this.db.prepare(`SELECT o.task_id,o.state,o.last_error_code FROM outbox o JOIN jobs j ON j.task_id=o.task_id JOIN sessions s ON s.session_key=j.session_key${where}${where ? ' AND' : ' WHERE'} o.state IN ('unknown','failed') LIMIT 12`).all(...args);
    return { blocked: this.blocked(), jobs, deliveries };
  }
  claimDelivery(now: number): Delivery | undefined {
    return this.atomic(() => {
      const row = this.db.prepare("SELECT o.* FROM outbox o WHERE state='pending' AND (next_attempt_at IS NULL OR next_attempt_at<=?) AND NOT EXISTS (SELECT 1 FROM outbox p WHERE p.task_id=o.task_id AND p.purpose=o.purpose AND p.part_no<o.part_no AND p.state!='sent') ORDER BY CASE WHEN purpose='control' THEN 0 ELSE 1 END,created_at,part_no LIMIT 1").get(now) as Delivery | undefined;
      if (!row) return;
      this.db.prepare("UPDATE outbox SET state='sending',attempts=attempts+1 WHERE delivery_id=? AND state='pending'").run(row.delivery_id);
      return { ...row, state: 'sending', attempts: row.attempts + 1 };
    });
  }
  deliveryState(id: string, state: DeliveryState, code?: string, next?: number, undoAttempt = false): void {
    this.db.prepare("UPDATE outbox SET state=?,last_error_code=?,next_attempt_at=?,sent_at=?,attempts=attempts-? WHERE delivery_id=? AND state='sending'").run(state, code ?? null, next ?? null, state === 'sent' ? Date.now() : null, undoAttempt ? 1 : 0, id);
  }
}
