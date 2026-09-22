import { mkdtempSync, mkdirSync, rmSync, realpathSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Writable } from 'node:stream';
import { randomUUID } from 'node:crypto';
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
  t.after(async () => { for (const fn of cleanups.reverse()) await fn(); rmSync(root,{recursive:true,force:true}); });
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
