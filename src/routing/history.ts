import path from 'node:path';
import { constants, realpathSync, existsSync, lstatSync } from 'node:fs';
import { opendir, lstat, open, type FileHandle } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { inside } from '../fsutil.ts';
import { BridgeError, invariant } from '../errors.ts';
import type { SessionRef } from '../types.ts';
import type { Target } from './catalog.ts';
import { hash } from './config.ts';
export interface HistoryEntry {
  handle: string; ref: SessionRef; file?: string; title: string; createdAt: number | null;
  lastResponseAt: number | null; preview: string[]; resumable: boolean; sessionKey?: string;
  activity?: 'idle' | 'active' | 'interrupted' | 'unknown';
}
export interface HistoryScan { queue: string[]; files: string[]; entries: HistoryEntry[]; issues?: Record<string,number>; source?: 'native-index' | 'files' }
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const fileLimit=256*1024*1024, frameLimit=8*1024*1024;
function time(v: unknown): number | null { const n = typeof v === 'string' ? Date.parse(v) : NaN; return Number.isFinite(n) ? n : null; }
function text(v: unknown): string {
  if (typeof v === 'string') return v.slice(0,2000);
  if (!Array.isArray(v)) return '';
  return v.filter(x => x && ['text','input_text','output_text'].includes(x.type) && typeof x.text === 'string').map(x => x.text).join('\n').slice(0,2000);
}
function parse(line:string):any { try { const row=JSON.parse(line);invariant(row && typeof row==='object' && !Array.isArray(row),'HISTORY_FORMAT');return row; } catch { throw new BridgeError('HISTORY_FORMAT'); } }
async function controlled(root:string,file:string):Promise<FileHandle> {
  invariant(path.isAbsolute(file) && inside(root,file),'HISTORY_PATH');
  for(let parent=path.dirname(file);inside(root,parent);parent=path.dirname(parent)) {
    invariant(!(await lstat(parent)).isSymbolicLink(),'HISTORY_PATH');if(parent===root)break;
  }
  const handle=await open(file,constants.O_RDONLY|constants.O_NOFOLLOW);
  if(!(await handle.stat()).isFile()){await handle.close();throw new BridgeError('HISTORY_PATH');}return handle;
}
/** First-line scope inspection precedes body parsing, size limits and preview extraction. */
async function headerLine(handle:FileHandle):Promise<{line:string;offset:number}> {
  const chunks:Buffer[]=[];let bytes=0;
  while(bytes<262144) {
    const chunk=Buffer.alloc(4096),{bytesRead}=await handle.read(chunk,0,chunk.length,bytes);
    invariant(bytesRead>0,'HISTORY_INCOMPLETE');const end=chunk.subarray(0,bytesRead).indexOf(10);
    if(end>=0){chunks.push(chunk.subarray(0,end));return {line:Buffer.concat(chunks).toString('utf8').replace(/^\uFEFF/,''),offset:bytes+end+1};}
    chunks.push(chunk.subarray(0,bytesRead));bytes+=bytesRead;
  }
  throw new BridgeError('HISTORY_HEADER_LIMIT');
}
async function* rows(handle:FileHandle,offset:number,size:number):AsyncGenerator<any|undefined> {
  const decoder=new TextDecoder('utf-8',{fatal:true});let pending='';
  while(offset<size) {
    const chunk=Buffer.alloc(Math.min(65536,size-offset));const {bytesRead}=await handle.read(chunk,0,chunk.length,offset);
    invariant(bytesRead>0,'HISTORY_CHANGED');offset+=bytesRead;
    try{pending+=decoder.decode(chunk.subarray(0,bytesRead),{stream:true});}catch{throw new BridgeError('HISTORY_FORMAT');}
    let end:number;
    while((end=pending.indexOf('\n'))>=0) {
      const line=pending.slice(0,end);pending=pending.slice(end+1);invariant(Buffer.byteLength(line)<=frameLimit,'HISTORY_FRAME_LIMIT');if(line.trim())yield parse(line);
    }
    invariant(Buffer.byteLength(pending)<=frameLimit,'HISTORY_FRAME_LIMIT');
  }
  try{pending+=decoder.decode();}catch{throw new BridgeError('HISTORY_FORMAT');}
  // A live writer can end at a partial record. Preserve the readable history but forbid resume.
  if(pending.trim())yield undefined;
}
export class NativeHistory {
  root(t: Target): string { return t.config.backend === 'codex' ? path.join(t.config.codex.home,'sessions') : t.config.agent.sessionRoot; }
  async read(t: Target, file: string): Promise<HistoryEntry | undefined> {
    const handle=await controlled(this.root(t),file);
    try {
      const firstLine=await headerLine(handle),first=parse(firstLine.line),codex=t.config.backend==='codex';
      // Recognized legacy Codex headers have no cwd. They cannot establish workspace ownership.
      if(codex && first.type===undefined && uuid.test(first.id) && typeof first.timestamp==='string' && 'instructions' in first && first.cwd===undefined)return;
      invariant(codex?first.type==='session_meta':first.type==='session' && first.version===3,'HISTORY_FORMAT');
      const header=codex?first.payload:first;
      invariant(header && typeof header.cwd==='string' && uuid.test(header.id),'HISTORY_FORMAT');
      let cwd:string;try{cwd=realpathSync(header.cwd);}catch{return;}if(cwd!==t.directory.path)return;
      const size=(await handle.stat()).size;invariant(size<=fileLimit,'HISTORY_FILE_LIMIT');
      let preview:string[]=[],title='',lastResponseAt:number|null=null,model:string|undefined,effort:string|undefined;
      let activity:NonNullable<HistoryEntry['activity']>='unknown',incomplete=false;
      const append=(role:string,message:string)=>{if(message){preview.push(`${role}: ${message}`);preview=preview.slice(-10);}};
      const piRows=new Map<string,any>();let piLeaf:any;
      for await(const row of rows(handle,firstLine.offset,size)) {
        if(!row){incomplete=true;continue;}
        if(codex) {
          const p=row.payload;
          if(row.type==='turn_context') {
            if(p?.cwd && p.cwd!==t.directory.path)return;
            if(typeof p?.model==='string')model=p.model;
            if(typeof p?.effort==='string')effort=p.effort; else if(typeof p?.effort?.effort==='string')effort=p.effort.effort;
          }
          if(row.type==='response_item' && p?.type==='message' && ['user','assistant'].includes(p.role)) {
            const message=text(p.content);append(p.role,message);
            if(p.role==='user' && !title && !message.startsWith('# AGENTS.md') && !message.includes('<environment_context>'))title=message.slice(0,120);
          }
          if(row.type==='event_msg') {
            if(['task_started','turn_started'].includes(p?.type))activity='active';
            if(p?.type==='user_message') {const message=text(p.message);if(message && !title)title=message.slice(0,120);}
            if(['task_complete','turn_complete'].includes(p?.type) && activity==='active' && text(p.last_agent_message).trim()) {
              lastResponseAt=time(row.timestamp);activity='idle';
              const final=text(p.last_agent_message);if(preview.at(-1)!==`assistant: ${final}`)append('assistant',final);
            }
            if(['turn_aborted','error'].includes(p?.type))activity='interrupted';
          }
        } else {
          invariant(typeof row.id==='string' && piRows.size<100000,'HISTORY_BRANCH');
          // Keep only the fields needed for branch history, never tools/images/thoughts.
          piLeaf={id:row.id,parentId:row.parentId,type:row.type,name:row.name,role:row.message?.role,content:text(row.message?.content)};piRows.set(row.id,piLeaf);
        }
      }
      if(!codex) {
        const branch:any[]=[],seen=new Set<string>();let leaf=piLeaf;
        while(leaf) {invariant(!seen.has(leaf.id),'HISTORY_BRANCH');seen.add(leaf.id);branch.unshift(leaf);if(leaf.parentId===null)break;invariant(piRows.has(leaf.parentId),'HISTORY_BRANCH');leaf=piRows.get(leaf.parentId);}
        for(const row of branch) {
          if(row.type==='session_info' && typeof row.name==='string')title=row.name.slice(0,120);
          if(row.type==='message' && ['user','assistant'].includes(row.role)){append(row.role,row.content);if(!title && row.role==='user')title=row.content.slice(0,120);}
        }
        // Native Pi messages alone do not prove RPC agent_settled and cleanup.
        lastResponseAt=null;
      }
      if(incomplete)activity='active';
      const ref:SessionRef=codex?{kind:'codex',threadId:header.id}:{kind:'pi',sessionId:header.id,sessionFile:file,hasHistory:true};
      const resumable=!incomplete && activity!=='active' && activity!=='interrupted' && (!codex || ((!t.config.codex.model || model===t.config.codex.model) && (!t.config.codex.reasoning || effort===t.config.codex.reasoning)));
      return {handle:hash([t.digest,ref]).slice(0,24),ref,file,title:title||'(无标题)',createdAt:time(header.timestamp),lastResponseAt,preview,resumable,activity};
    } finally {await handle.close();}
  }
  private initial(t:Target):HistoryScan {
    const scan:HistoryScan={queue:[this.root(t)],files:[],entries:[],issues:{},source:'files'};
    const index=path.join(t.config.codex.home,'state_5.sqlite');
    if(t.config.backend!=='codex' || !existsSync(index))return scan;
    invariant(!lstatSync(index).isSymbolicLink() && realpathSync(index)===index,'HISTORY_PATH');
    const db=new DatabaseSync(index,{readOnly:true});
    try {
      db.exec('PRAGMA busy_timeout=1000;');
      const cols=db.prepare('PRAGMA table_info(threads)').all() as {name:string}[];
      if(!['cwd','rollout_path','archived','updated_at'].every(name=>cols.some(c=>c.name===name)))return scan;
      const records=db.prepare('SELECT cwd,rollout_path FROM threads WHERE archived=0 ORDER BY updated_at DESC LIMIT 10001').all() as {cwd:string;rollout_path:string}[];
      invariant(records.length<=10000,'HISTORY_SCAN_LIMIT');const canonical=new Map<string,string>();
      scan.queue=[];scan.source='native-index';
      for(const row of records) {
        if(!canonical.has(row.cwd)) {try{canonical.set(row.cwd,realpathSync(row.cwd));}catch{canonical.set(row.cwd,'');}}
        if(canonical.get(row.cwd)===t.directory.path) {invariant(inside(this.root(t),row.rollout_path),'HISTORY_PATH');scan.files.push(row.rollout_path);}
      }
      return scan;
    } finally {db.close();}
  }
  async scan(t: Target, state?: HistoryScan, limit = 100): Promise<{scan: HistoryScan; partial: boolean}> {
    const scan=state??this.initial(t);scan.issues??={};const start=Date.now();let count=0,totalBytes=0;
    while((scan.queue.length||scan.files.length) && count<limit && Date.now()-start<2000) {
      if(scan.files.length) {
        const file=scan.files.shift()!;count++;
        try {
          const entry=await this.read(t,file);
          if(entry){totalBytes+=(await lstat(file)).size;if(!scan.entries.some(x=>x.handle===entry.handle))scan.entries.push(entry);}
        } catch(e) {
          const code=e instanceof BridgeError?e.code:(e as NodeJS.ErrnoException).code==='ENOENT'?'HISTORY_FILE_MISSING':undefined;
          if(!code || !['HISTORY_FORMAT','HISTORY_INCOMPLETE','HISTORY_FILE_LIMIT','HISTORY_FRAME_LIMIT','HISTORY_HEADER_LIMIT','HISTORY_CHANGED','HISTORY_BRANCH','HISTORY_FILE_MISSING'].includes(code))throw e;
          scan.issues[code]=(scan.issues[code]??0)+1;
        }
        if(totalBytes>=32*1024*1024)break;
      } else {
        const dir=scan.queue.shift()!;let listing;
        try{invariant(inside(this.root(t),dir) && realpathSync(dir)===dir && !(await lstat(dir)).isSymbolicLink(),'HISTORY_PATH');listing=await opendir(dir);}
        catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT' && dir===this.root(t) && !state)continue;throw e;}
        for await(const entry of listing) {
          if(entry.isDirectory())scan.queue.push(path.join(dir,entry.name));
          else if(entry.isFile() && entry.name.endsWith('.jsonl'))scan.files.push(path.join(dir,entry.name));
          invariant(scan.queue.length+scan.files.length<=10000,'HISTORY_SCAN_LIMIT');
        }
        count++;
      }
    }
    invariant(scan.entries.length<=10000,'HISTORY_SCAN_LIMIT');return {scan,partial:!!(scan.queue.length||scan.files.length)};
  }
}
export function reusable(last: number | null, now: number): boolean { return last !== null && now >= last && now-last <= 24*60*60*1000; }
