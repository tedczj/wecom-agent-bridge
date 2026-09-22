import path from 'node:path';
import { realpathSync } from 'node:fs';
import { opendir, lstat } from 'node:fs/promises';
import { inside, readControlled } from '../fsutil.ts';
import { invariant } from '../errors.ts';
import type { SessionRef } from '../types.ts';
import type { Target } from './catalog.ts';
import { hash } from './config.ts';
export interface HistoryEntry {
  handle: string; ref: SessionRef; file?: string; title: string; createdAt: number | null;
  lastResponseAt: number | null; preview: string[]; resumable: boolean; sessionKey?: string;
}
export interface HistoryScan { queue: string[]; files: string[]; entries: HistoryEntry[] }
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function time(v: unknown): number | null { const n = typeof v === 'string' ? Date.parse(v) : NaN; return Number.isFinite(n) ? n : null; }
function text(v: unknown): string {
  if (typeof v === 'string') return v.slice(0,2000);
  if (!Array.isArray(v)) return '';
  return v.filter(x => x && ['text','input_text','output_text'].includes(x.type) && typeof x.text === 'string').map(x => x.text).join('\n').slice(0,2000);
}
export class NativeHistory {
  root(t: Target): string { return t.config.backend === 'codex' ? path.join(t.config.codex.home,'sessions') : t.config.agent.sessionRoot; }
  async read(t: Target, file: string): Promise<HistoryEntry | undefined> {
    const bytes = await readControlled(this.root(t),file,8*1024*1024);
    invariant(bytes.length > 0 && bytes[bytes.length-1] === 10,'HISTORY_INCOMPLETE');
    let rows: any[];
    try { rows = bytes.toString('utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)); }
    catch { invariant(false,'HISTORY_FORMAT'); }
    const first = rows[0], codex = t.config.backend === 'codex';
    invariant(codex ? first?.type === 'session_meta' : first?.type === 'session' && first.version === 3,'HISTORY_FORMAT');
    const header = codex ? first.payload : first;
    invariant(header && typeof header.cwd === 'string' && uuid.test(header.id),'HISTORY_FORMAT');
    // A removed unrelated cwd is not a failure of the selected workspace.
    let cwd: string; try { cwd = realpathSync(header.cwd); } catch { return; }
    if (cwd !== t.directory.path) return;
    let preview: string[] = [], title = '', lastResponseAt: number | null = null;
    if (codex) {
      let pending = false, final = '', model: string | undefined;
      for (const row of rows) {
        const p = row.payload;
        if (row.type === 'turn_context') {
          if (p?.cwd && p.cwd !== t.directory.path) return;
          if (typeof p?.model === 'string') model = p.model;
        }
        if (row.type === 'response_item' && p?.type === 'message' && ['user','assistant'].includes(p.role)) {
          const message = text(p.content); if (message) preview.push(`${p.role}: ${message}`);
          if (p.role === 'user' && !title) title = message.slice(0,120);
        }
        if (row.type === 'event_msg') {
          if (['task_started','turn_started'].includes(p?.type)) { pending = true; final = ''; }
          if (p?.type === 'agent_message') final = text(p.message);
          if (['task_complete','turn_complete'].includes(p?.type) && pending && text(p.last_agent_message ?? final).trim()) {
            lastResponseAt = time(row.timestamp); pending = false;
          }
          if (['turn_aborted','error'].includes(p?.type)) { pending = true; }
        }
      }
      // Incomplete turns may already have side effects and are not resume candidates.
      if (pending) return;
      if (t.config.codex.model && model !== t.config.codex.model) return;
    } else {
      // Follow only the currently persisted branch, never a discarded assistant leaf.
      const byId = new Map(rows.slice(1).map(r => [r.id,r]));
      let leaf = rows.at(-1); const branch: any[] = [], seen = new Set<string>();
      while (leaf?.id && leaf.type !== 'session') {
        invariant(!seen.has(leaf.id),'HISTORY_BRANCH'); seen.add(leaf.id); branch.unshift(leaf);
        if (leaf.parentId === null) break;
        invariant(typeof leaf.parentId === 'string' && byId.has(leaf.parentId),'HISTORY_BRANCH'); leaf = byId.get(leaf.parentId);
      }
      for (const row of branch) {
        if (row.type === 'session_info' && typeof row.name === 'string') title = row.name.slice(0,120);
        if (row.type === 'message' && ['user','assistant'].includes(row.message?.role)) {
          const msg = text(row.message.content); if (msg) preview.push(`${row.message.role}: ${msg}`);
          if (!title && row.message.role === 'user') title = msg.slice(0,120);
        }
      }
      // A persisted assistant message does not prove RPC agent_settled/cleanup.
      lastResponseAt = null;
    }
    preview = preview.slice(-10);
    const ref: SessionRef = codex ? {kind:'codex',threadId:header.id} : {kind:'pi',sessionId:header.id,sessionFile:file,hasHistory:true};
    return {handle:hash([t.digest,ref]).slice(0,24),ref,file,title:title || '(无标题)',createdAt:time(header.timestamp),lastResponseAt,preview,resumable:true};
  }
  async scan(t: Target, state?: HistoryScan, limit = 100): Promise<{scan: HistoryScan; partial: boolean}> {
    const scan = state ?? {queue:[this.root(t)],files:[],entries:[]};
    const start = Date.now(); let count = 0, totalBytes=0;
    while ((scan.queue.length || scan.files.length) && count < limit && Date.now()-start < 2000) {
      if (scan.files.length) {
        const file = scan.files[0]!;
        const size=(await lstat(file)).size;
        invariant(size<=8*1024*1024,'HISTORY_FILE_LIMIT');
        if(totalBytes+size>32*1024*1024)break;
        totalBytes+=size; scan.files.shift(); count++;
        const entry = await this.read(t,file); if (entry && !scan.entries.some(x => x.handle === entry.handle)) scan.entries.push(entry);
      } else {
        const dir = scan.queue.shift()!;
        let listing;
        try { invariant(inside(this.root(t),dir) && realpathSync(dir)===dir && !(await lstat(dir)).isSymbolicLink(),'HISTORY_PATH'); listing = await opendir(dir); }
        catch(e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT' && dir === this.root(t) && !state) continue; throw e; }
        for await (const entry of listing) {
          if (entry.isDirectory()) scan.queue.push(path.join(dir,entry.name));
          else if (entry.isFile() && entry.name.endsWith('.jsonl')) scan.files.push(path.join(dir,entry.name));
          invariant(scan.queue.length + scan.files.length <= 10000,'HISTORY_SCAN_LIMIT');
        }
        count++;
      }
    }
    invariant(scan.entries.length <= 10000,'HISTORY_SCAN_LIMIT');
    return {scan,partial:!!(scan.queue.length || scan.files.length)};
  }
}
export function reusable(last: number | null, now: number): boolean { return last !== null && now >= last && now-last <= 24*60*60*1000; }
