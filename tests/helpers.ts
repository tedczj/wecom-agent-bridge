import { controllerPolicy } from '../src/controllers/codex-app-server.ts';
import { mkdtempSync, mkdirSync, rmSync, realpathSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Writable } from 'node:stream';
import { createHash, randomUUID } from 'node:crypto';
import type { TestContext } from 'node:test';
import { parseConfig, preparePaths } from '../src/config.ts';
import { Store } from '../src/store.ts';
import type { AgentBackend, AgentResult, Channel, ImageRef, NormalizedInput, Route, RunHooks, SessionRef } from '../src/types.ts';
export function setup(t: TestContext, backend: 'codex' | 'pi' = 'codex', mode = 'normal') {
  const root = mkdtempSync(path.join(realpathSync(os.tmpdir()), 'local-agent-test-'));
  const workspace = path.join(root, 'workspace'), home = path.join(root,'home');
  mkdirSync(workspace); mkdirSync(home);
  const c = parseConfig({backend,workspace:{id:'test',path:workspace},stateRoot:path.join(root,'state'),
    agent:{command:path.resolve(`tests/fakes/${backend}.mjs`),env:{HOME:home,FAKE_MODE:mode},
      isolation:backend === 'codex' ? 'native' : 'external',startupTimeoutMs:1000,taskTimeoutMs:3000,cancelGraceMs:150,killGraceMs:80}});
  preparePaths(c);
  const cleanups: Array<() => void | Promise<void>> = [];
  t.after(async () => { for (const fn of cleanups.reverse()) await fn();
    // Test fixtures may deliberately interrupt a backend. Remove only this fixture's
    // private lock after its child cleanup, so recycled temp inodes cannot affect another test.
    const locks=path.join(realpathSync(os.tmpdir()),`local-agent-bridge-locks-${process.getuid?.() ?? 'user'}`);
    if(existsSync(locks))for(const name of readdirSync(locks)) {
      const file=path.join(locks,name);try {if(JSON.parse(readFileSync(file,'utf8')).stateRoot===c.stateRoot)rmSync(file);}catch{}
    }
    rmSync(root,{recursive:true,force:true}); });
  const store = () => { const s = new Store(path.join(c.stateRoot,'bridge.sqlite'),c); cleanups.push(()=>s.close()); return s; };
  return {root,c,workspace,home,store,cleanups};
}
export function fixture(text = 'hello', session = 'default', id = randomUUID(), images: string[] = []) {
  return {id,session,text,images};
}
export function input(images: ImageRef[] = []): NormalizedInput {
  return {taskId:randomUUID(),messageId:randomUUID(),route:{channelId:'local:codex',kind:'local',senderId:'operator',targetId:'default'},receivedAt:Date.now(),text:'hello',images,workspaceId:'test',sessionKey:'session',generation:0};
}
export class FakeBackend implements AgentBackend {
  calls: NormalizedInput[] = []; refs: Array<SessionRef | undefined> = [];
  active = 0; maxActive = 0;
  action?: (input: NormalizedInput, signal: AbortSignal) => Promise<AgentResult>;
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async run(i: NormalizedInput, ref: SessionRef | undefined, hooks: RunHooks, signal: AbortSignal): Promise<AgentResult> {
    this.calls.push(i); this.refs.push(ref); this.active++; this.maxActive = Math.max(this.maxActive,this.active);
    try { await hooks.persistSession(ref ?? {kind:'codex',threadId:randomUUID()}); return this.action ? await this.action(i,signal) : {outcome:'success',finalText:'answer:' + i.text}; }
    finally { this.active--; }
  }
}
export class FakeChannel implements Channel {
  ready = true;
  sent: Array<{route:Route;text:string}> = [];
  async receipt(): Promise<void> {}
  async send(route: Route,text: string): Promise<void> { this.sent.push({route,text}); }
}
export function output() {
  let text = '';
  const stream = new Writable({write(chunk,_encoding,callback) { text += chunk.toString(); callback(); }});
  return {stream,text:()=>text,values:()=>text.trim().split('\n').filter(Boolean).map(line=>JSON.parse(line))};
}
export async function eventually(condition: () => boolean, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!condition()) { if (Date.now() > deadline) throw new Error('condition timed out'); await new Promise(r=>setTimeout(r,10)); }
}

/** Offline-only service fixture. The proof matches a deterministic executable, never real Codex. */
export function setupService(t: TestContext, backend: 'codex' | 'pi' = 'codex', mode = 'normal') {
  const h = setup(t, backend, mode);
  configureOfflineHierarchy(h.c);
  if (backend === 'pi') { h.c.agent.env.FAKE_MODEL = 'gpt-6-sol'; h.c.agent.env.FAKE_WINDOW = '828400'; }
  return h;
}
export function configureOfflineHierarchy(c: ReturnType<typeof parseConfig>): void {
  const example = JSON.parse(readFileSync('docs/plans/three-layer-agent-bridge/config.hierarchical.example.json', 'utf8'));
  example.orchestration.controllerRuntime = { ...example.orchestration.controllerRuntime,
    command: path.resolve('tests/fakes/hierarchical-controller.mjs'), home: c.codex.home, workRoot: path.join(c.stateRoot, 'controllers') };
  example.orchestration.answers.root = path.join(c.stateRoot, 'artifacts');
  c.models = { daily: { model: 'gpt-6-sol', reasoning: 'high', contextWindowTokens: 828400 } };
  Object.assign(c, parseConfig({ ...c, orchestration: example.orchestration, routing: {
    roots: [{ id: 'root', path: c.workspace.path, profile: 'default' }],
    profiles: [{ id: 'default', version: '1' }], workspaces: [{ ...c.workspace, profile: 'default' }] } }));
  const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
  const runtime = c.orchestration!.controllerRuntime, model = c.models!.daily!;
  mkdirSync(runtime.workRoot, { recursive: true }); mkdirSync(c.codex.home, { recursive: true });
  const configFile = path.join(runtime.home, 'config.toml');
  const proof = { capabilityReady: true, model, binarySha256: hash(readFileSync(runtime.command)),
    configurationDigest: hash(JSON.stringify({ home: realpathSync(runtime.home), model: [model.model, model.reasoning, model.contextWindowTokens],
      policy: controllerPolicy, nativeConfigHash: existsSync(configFile) ? hash(readFileSync(configFile)) : 'absent' })),
    checks: Object.fromEntries(['firstTurnCompleted', 'resumeSameIdentity', 'dynamicTool', 'modelProfileObserved', 'effectiveToolSurfaceVerified',
      'nativeAutoCompactionDisabledVerified', 'mediaVerified', 'cancellationVerified', 'writerOwnershipVerified'].map(key => [key, true])) };
  writeFileSync(path.join(c.codex.home, 'models_cache.json'), JSON.stringify({models:[{slug:'gpt-6-sol',effective_context_window_percent:95,max_context_window:872000}]}));
  writeFileSync(path.join(runtime.workRoot, 'runtime-lock.json'), JSON.stringify(proof), { mode: 0o600 });
  mkdirSync(path.join(c.codex.home, 'thread-writer-locks'), { recursive: true });
  writeFileSync(path.join(c.codex.home, 'thread-writer-locks', '.coordination.lock'), '');
}
