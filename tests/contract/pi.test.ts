import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { PiBackend } from '../../src/pi.ts';
import { MediaStore } from '../../src/media.ts';
import type { SessionRef } from '../../src/types.ts';
import { Catalog } from '../../src/routing/catalog.ts';
import { parseRouting } from '../../src/routing/config.ts';
import { setup, input, eventually } from '../helpers.ts';
const hooks = {persistSession: async (_ref: SessionRef) => {},progress:()=>{}};
for (const contextWindowTokens of [1000000, 828400]) test(`OFFLINE Pi window: configured capacity is checked before prompt (${contextWindowTokens})`, async t => {
 const h = setup(t, 'pi');
 h.c.routing = parseRouting({ roots: [{ id: 'root', path: h.root, profile: 'pi' }], profiles: [{ id: 'pi', version: '1', backend: 'pi' }], workspaces: [{ id: 'test', path: h.workspace, profile: 'pi' }] });
 const catalog = new Catalog(h.c), target = catalog.target(catalog.configured[0]!, { model: 'terra', contextWindowTokens });
 const i = input(); i.routing = { directory: target.directory, digest: target.digest, execution: target.execution, reason: 'window' };
 const result = await new PiBackend(target.config).run(i, undefined, hooks, new AbortController().signal);
 if (contextWindowTokens === 1000000) assert.equal(result.outcome, 'success');
 else { assert.equal(result.errorCode, 'PI_CONTEXT_WINDOW_MISMATCH'); assert.equal(existsSync(path.join(h.c.agent.sessionRoot, 'capture.json')), false); }
});
for(const mode of ['normal','clamp-thinking'])test(`Pi execution selection validates actual RPC state before prompt (${mode})`,async t=>{
 const h=setup(t,'pi',mode);
 h.c.routing=parseRouting({roots:[{id:'root',path:h.root,profile:'pi'}],profiles:[{id:'pi',version:'1',backend:'pi'}],workspaces:[{id:'test',path:h.workspace,profile:'pi'}]});
 const catalog=new Catalog(h.c),target=catalog.target(catalog.configured[0]!,{backend:'pi',model:'terra',reasoning:'high'});
 const i=input();i.routing={directory:target.directory,digest:target.digest,execution:target.execution,reason:'execution-changed'};
 const result=await new PiBackend(target.config).run(i,undefined,hooks,new AbortController().signal);
 if(mode==='clamp-thinking') {assert.equal(result.errorCode,'PI_REASONING_MISMATCH');assert(!existsSync(path.join(h.c.agent.sessionRoot,'capture.json')));}
 else {assert.equal(result.outcome,'success');assert.equal(result.execution!.model,'test-provider/gpt-5.6-terra');const captured=JSON.parse(readFileSync(path.join(h.c.agent.sessionRoot,'capture.json'),'utf8'));assert.equal(captured.thinkingLevel,'high');}
});
test('Pi B01/B02: native image bytes and persisted session resume',async t=>{
 const h=setup(t,'pi'), backend=new PiBackend(h.c),media=new MediaStore(h.c);
 const image=path.join(h.root,'in.png');await sharp({create:{width:2,height:2,channels:3,background:'red'}}).png().toFile(image);
 const i=input();i.images=await media.prepare(i.taskId,[{path:image,source:'message'}]);
 const a=await backend.run(i,undefined,hooks,new AbortController().signal);assert.equal(a.outcome,'success');
 const captured=JSON.parse(readFileSync(path.join(h.c.agent.sessionRoot,'capture.json'),'utf8'));
 assert.equal(captured.images[0].sha256,i.images[0]!.sha256);
 const b=await backend.run({...input(),text:'second'},a.sessionRef,hooks,new AbortController().signal);
 assert.equal(b.outcome,'success');assert.match(b.finalText,/hello\|second/);assert.deepEqual(a.sessionRef,b.sessionRef);
});
for(const mode of ['delayed','retry','stale'])test(`Pi P03/P04/P09: ${mode} never completes on ACK, agent_end or stale events`,async t=>{
 const h=setup(t,'pi',mode),b=new PiBackend(h.c);const start=Date.now();
 const r=await b.run(input(),undefined,hooks,new AbortController().signal);assert.equal(r.outcome,'success');assert.equal(r.finalText,'answer:hello');
 if(mode!=='stale')assert(Date.now()-start>=100);
});
for(const [mode,code] of [['error','PI_MODEL_ERROR'],['reject','RPC_REJECTED'],['session-cancel','SESSION_SWITCH_CANCELLED'],['empty','EMPTY_FINAL']])test(`Pi P05/P06/P07/B04: ${mode}`,async t=>{
 const h=setup(t,'pi',mode),r=await new PiBackend(h.c).run(input(),undefined,hooks,new AbortController().signal);
 assert.equal(r.outcome,'failed');assert.equal(r.errorCode,code);
});
for(const mode of ['exit','malformed','ui'])test(`Pi P08/P10: ${mode} is not successful or automatically approved`,async t=>{
 const h=setup(t,'pi',mode),r=await new PiBackend(h.c).run(input(),undefined,hooks,new AbortController().signal);
 assert.equal(r.outcome,'interrupted');if(mode==='ui')assert.equal(r.errorCode,'NEEDS_LOCAL_INTERACTION');
});
test('Pi P12/B06: missing historical file fails; unsaved fresh ref allowed; persistence failure prevents prompt',async t=>{
 const h=setup(t,'pi'),b=new PiBackend(h.c),r=await b.run(input(),undefined,hooks,new AbortController().signal);
 assert(r.sessionRef?.kind==='pi');rmSync(r.sessionRef.sessionFile);
 const missing=await b.run(input(),r.sessionRef,hooks,new AbortController().signal);assert.equal(missing.errorCode,'SESSION_MISSING');
 const fresh=await b.run(input(),{...r.sessionRef,hasHistory:false},hooks,new AbortController().signal);assert.equal(fresh.outcome,'success');
 rmSync(path.join(h.c.agent.sessionRoot,'capture.json'));
 const bad=await b.run(input(),undefined,{...hooks,persistSession:async()=>{throw Error('secret');}},new AbortController().signal);
 assert.equal(bad.errorCode,'SESSION_PERSISTENCE');assert(!existsSync(path.join(h.c.agent.sessionRoot,'capture.json')));
});
for(const mode of ['hang','ignore-abort'])test(`Pi B05: cancellation ${mode} is settled or conservatively interrupted`,async t=>{
 const h=setup(t,'pi',mode),b=new PiBackend(h.c),c=new AbortController(),p=b.run(input(),undefined,hooks,c.signal);
 await eventually(()=>existsSync(path.join(h.c.agent.sessionRoot,'capture.json')));c.abort();const r=await p;
 assert.equal(r.outcome,mode==='hang'?'cancelled':'interrupted');assert(!existsSync(path.join(h.c.stateRoot,'agent-process.json')));
});
test('Pi marker belonging to another process is never removed',async t=>{
 const h=setup(t,'pi'),marker=path.join(h.c.stateRoot,'agent-process.json');writeFileSync(marker,'foreign');
 const r=await new PiBackend(h.c).run(input(),undefined,hooks,new AbortController().signal);
 assert.equal(r.outcome,'failed');assert.equal(readFileSync(marker,'utf8'),'foreign');
});
