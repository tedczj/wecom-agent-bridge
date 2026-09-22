import path from 'node:path';
import { lstatSync, realpathSync, statSync } from 'node:fs';
import { opendir } from 'node:fs/promises';
import { configSources, parseConfig, preparePaths, type Config } from '../config.ts';
import { inside, readControlled } from '../fsutil.ts';
import { invariant } from '../errors.ts';
import { hash } from './config.ts';
import { availableModels, executable, resolveModel, validateExecution, type Execution } from './execution.ts';
export interface Directory { id: string; path: string; identity: string; profile: string; aliases: string[]; description: string }
export interface DirectoryGrant { directory: Directory; version: string; requestTaskId?: string; approvalMessageId?: string }
export interface Target { directory: Directory; config: Config; digest: string; execution?: Execution }
export interface Scan { queue: Array<{path: string; depth: number; after?: string}>; deferred: Array<{path: string; depth: number}>; matches: Directory[] }
const skip = new Set(['.git','node_modules','.cache','__pycache__','.venv','venv','dist','build','target','.next']);
export function physical(file: string): string { const s = statSync(file); invariant(s.isDirectory(),'DIRECTORY_MISSING'); return `${s.dev}:${s.ino}`; }
export class Catalog {
  readonly version: string;
  readonly roots: Array<{id: string; path: string; profile?: string; identity: string}>;
  readonly configured: Directory[];
  constructor(readonly base: Config, readonly grants: DirectoryGrant[] = [], snapshot?:Catalog) {
    const r = base.routing!;
    this.version = hash(r);
    this.roots = snapshot?.roots ?? r.roots.map(root => ({...root,path:realpathSync(root.path),identity:physical(root.path)}));
    this.configured = snapshot?.configured ?? r.workspaces.map(w => this.describe(w.path,w));
    invariant(this.configured.some(w => w.id === base.workspace.id && w.path === base.workspace.path),'ROUTING_DEFAULT_MISSING');
    invariant(new Set(this.configured.map(w => w.identity)).size === this.configured.length,'ROUTING_DUPLICATE_DIRECTORY');
    if(!snapshot)for (const w of this.configured) this.target(w);
  }
  get directories(): Directory[] { return [...this.configured,...this.grants.filter(g=>g.version===this.version).map(g=>g.directory)]; }
  authorizationProfile(): string {
    const root=this.roots.filter(r=>inside(r.path,this.base.workspace.path)).sort((a,b)=>b.path.length-a.path.length)[0];
    invariant(root?.profile,'DIRECTORY_NO_PROFILE');return root.profile;
  }
  private authorize(file: string): string {
    const resolved = realpathSync(file);
    invariant(resolved === path.resolve(file) && !lstatSync(file).isSymbolicLink(),'DIRECTORY_SYMLINK');
    invariant(this.roots.some(r => inside(r.path,resolved) && physical(r.path) === r.identity) || this.grants.some(g=>g.version===this.version && g.directory.path===resolved && physical(resolved)===g.directory.identity),'DIRECTORY_UNAUTHORIZED');
    // Discovery must not expose control state or authentication/session files.
    for (const root of [this.base.stateRoot,this.base.codex.home,this.base.agent.sessionRoot]) invariant(!inside(root,resolved),'DIRECTORY_PRIVATE');
    return resolved;
  }
  describe(file: string, explicit = this.base.routing!.workspaces.find(w => path.resolve(w.path) === path.resolve(file)) ?? this.grants.find(g=>g.version===this.version && g.directory.path===path.resolve(file))?.directory): Directory {
    const resolved = this.authorize(file), identity = physical(resolved);
    const root = this.roots.filter(r => inside(r.path,resolved)).sort((a,b) => b.path.length-a.path.length)[0]!;
    return {id:explicit?.id ?? 'dir_' + hash([resolved,identity]).slice(0,20),path:resolved,identity,profile:explicit?.profile ?? root?.profile ?? '',aliases:explicit?.aliases ?? [],description:explicit?.description ?? ''};
  }
  propose(file: string, profile: string): Directory {
    invariant(path.isAbsolute(file) && !/[\x00-\x1f\x7f]/.test(file),'DIRECTORY_PATH');
    const resolved=realpathSync(file),identity=physical(resolved);
    invariant(resolved===path.resolve(file) && !lstatSync(file).isSymbolicLink(),'DIRECTORY_SYMLINK');
    const d:Directory={id:'dir_'+hash([resolved,identity]).slice(0,20),path:resolved,identity,profile,aliases:[],description:''};
    // Validate private-path/profile boundaries without reading the proposed directory's contents.
    new Catalog(this.base,[{directory:d,version:this.version}],this).target(d);
    return d;
  }
  validate(d: Directory): Directory {
    const fresh = this.describe(d.path); invariant(fresh.identity === d.identity,'DIRECTORY_CHANGED');
    invariant(fresh.id === d.id && fresh.profile === d.profile,'DIRECTORY_REVOKED'); return fresh;
  }
  target(d: Directory, execution?: Execution): Target {
    d = this.validate(d);
    if(execution)execution=validateExecution(execution);
    let p = this.base.routing!.profiles.find(p => p.id === d.profile); invariant(p,'DIRECTORY_NO_PROFILE');
    if(execution?.backend && execution.backend!==(p.backend??this.base.backend)) {
      const backend=execution.backend,choices=this.base.routing!.profiles.filter(x=>(x.backend??this.base.backend)===backend);
      invariant(choices.length,'BACKEND_UNAVAILABLE');invariant(choices.length===1,'BACKEND_AMBIGUOUS');p=choices[0]!;
    }
    const {routing: _routing,...base} = this.base;
    const c = parseConfig({...base,workspace:{id:d.id,path:d.path},backend:p.backend ?? base.backend,agent:{...base.agent,...p.agent},codex:{...base.codex,...p.codex}});
    if(c.backend==='codex' && (execution?.model || execution?.reasoning)) {
      if(execution.model)c.codex.model=resolveModel(execution.model,c);
      if(execution.reasoning)c.codex.reasoning=execution.reasoning;
      execution={...execution,...(execution.model?{model:c.codex.model}:{})};
    }
    if(execution)executable(c);
    preparePaths(c);
    invariant(c.agent.env.HOME && path.isAbsolute(c.agent.env.HOME),'AGENT_HOME_REQUIRED');
    invariant(c.backend === 'codex' ? ['native','external'].includes(c.agent.isolation) : c.agent.isolation === 'external','WORKSPACE_ISOLATION_UNVERIFIED');
    const privatePaths=[c.stateRoot,c.codex.home,c.agent.sessionRoot];
    for(const profile of this.base.routing!.profiles) privatePaths.push(profile.codex?.home ?? this.base.codex.home,profile.agent?.sessionRoot ?? this.base.agent.sessionRoot);
    const source=configSources.get(this.base); if(source)invariant(!inside(d.path,source),'CONFIG_IN_WORKSPACE');
    invariant(!inside(d.path,c.agent.env.HOME),'HOME_IN_WORKSPACE');
    for (const root of privatePaths) invariant(!inside(d.path,root) && !inside(root,d.path),'ROUTING_PRIVATE_OVERLAP');
    const identity:unknown[]=[p.version,c,d.identity];
    if(c.backend==='pi' && (execution?.model || execution?.reasoning))identity.push({model:execution.model,reasoning:execution.reasoning});
    return {directory:d,config:c,digest:hash(identity),execution};
  }
  capabilities(): Array<{backend:string;models:string[];reasoning:string[]}> {
    return this.base.routing!.profiles.map(p=>{
      const c={...this.base,backend:p.backend??this.base.backend,agent:{...this.base.agent,...p.agent},codex:{...this.base.codex,...p.codex}};
      return {backend:c.backend,models:c.backend==='codex'?availableModels(c):[],reasoning:['minimal','low','medium','high','xhigh']};
    });
  }
  initialScan(): Scan { return {queue:this.roots.map(r => ({path:r.path,depth:0})),deferred:[],matches:[]}; }
  async metadata(d: Directory): Promise<string> {
    this.validate(d);
    const parts = [d.description];
    for (const name of ['package.json','README.md']) {
      try { parts.push((await readControlled(d.path,path.join(d.path,name),16384)).toString('utf8').slice(0,4000)); }
      catch (e) { if (!['ENOENT','MEDIA_SIZE','MEDIA_SYMLINK'].includes(String((e as {code?: string}).code))) throw e; }
    }
    return parts.join('\n').slice(0,8000);
  }
  async search(query: string, scan = this.initialScan(), budget = 200): Promise<{scan: Scan; partial: boolean}> {
    const start = Date.now(); let entries = 0;
    if (!scan.queue.length && scan.deferred.length) { scan.queue = scan.deferred.map(x => ({...x,depth:0})); scan.deferred = []; }
    while (scan.queue.length && entries < budget && Date.now()-start < 2000) {
      const node = scan.queue.shift()!; this.authorize(node.path);
      const dir = await opendir(node.path); let exhausted = true;
      // Resume re-enumeration by name with a bounded per-directory sorted page.
      const names: string[] = [];
      try { for await (const entry of dir) if (entry.isDirectory() && !skip.has(entry.name) && (!node.after || entry.name > node.after)) {
        names.push(entry.name); if (names.length > 10000) { invariant(false,'DIRECTORY_TOO_WIDE'); }
      } } finally { /* async iterator closes the handle */ }
      names.sort();
      for (const name of names) {
        if (entries >= budget || Date.now()-start >= 2000) { exhausted = false; break; }
        entries++; node.after = name;
        const file = path.join(node.path,name);
        let d: Directory;
        try { d = this.describe(file); } catch (e) { if (['DIRECTORY_PRIVATE','DIRECTORY_SYMLINK'].includes(String((e as {code?: string}).code))) continue; throw e; }
        if (!score(query,d)) d.description = await this.metadata(d);
        if (score(query,d) > 0 && !scan.matches.some(x => x.identity === d.identity)) scan.matches.push(d);
        if (node.depth >= 7) scan.deferred.push({path:file,depth:node.depth+1}); else scan.queue.push({path:file,depth:node.depth+1});
      }
      if (!exhausted) scan.queue.unshift(node);
      invariant(scan.queue.length + scan.deferred.length <= 10000 && scan.matches.length <= 1000,'DIRECTORY_SCAN_LIMIT');
    }
    return {scan,partial:!!(scan.queue.length || scan.deferred.length)};
  }
}
export function score(query: string, d: Directory): number {
  const norm = (s: string) => s.toLowerCase().replace(/[\s_.\-]/g,'');
  const q = norm(query.replace(/^(那个|这个)/,'').replace(/(那个)?项目$/,'').replace(/的$/,'').replace(/(那个|这个)$/,'').trim()); if (!q) return 0;
  const names = [d.id,path.basename(d.path),...d.aliases].map(norm);
  if (names.includes(q)) return 100;
  if (names.some(n => n.includes(q)) || norm(d.description).includes(q)) return 50;
  const acronym = path.basename(d.path).split(/[-_ ]/).map(x => x[0] ?? '').join('').toLowerCase();
  if (q.length >= 2 && q === acronym) return 70;
  if(norm(d.path).includes(q))return 10;
  // Bounded single-edit fuzzy names, only for sufficiently long queries.
  if(q.length>=4 && names.some(n=>oneEdit(q,n)))return 20;
  return 0;
}

function oneEdit(a:string,b:string):boolean {
  if(Math.abs(a.length-b.length)>1)return false;
  let i=0,j=0,edits=0;
  while(i<a.length && j<b.length) {
    if(a[i]===b[j]){i++;j++;continue;}
    if(++edits>1)return false;
    if(a.length>=b.length)i++;
    if(b.length>=a.length)j++;
  }
  return edits+(a.length-i)+(b.length-j)<=1;
}
