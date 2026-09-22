import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync,writeFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { Bridge } from '../../src/bridge.ts';
import { MediaStore } from '../../src/media.ts';
import { openService } from '../../src/main.ts';
import { OutboxPump } from '../../src/reply.ts';
import type { AgentResult,ImageRef } from '../../src/types.ts';
import { setup,fixture,FakeBackend,FakeChannel,eventually,output } from '../helpers.ts';
function harness(t:Parameters<typeof setup>[0]) {
 const h=setup(t),store=h.store(),backend=new FakeBackend(),channel=new FakeChannel(),media=new MediaStore(h.c);
 const bridge=new Bridge(h.c,'local:codex',store,channel,backend,media);bridge.start();h.cleanups.push(()=>bridge.stop());
 return {...h,store,backend,channel,media,bridge};
}
test('N02/Q01: concurrent duplicate submissions execute once and survive store replay',async t=>{
 const h=harness(t),f=fixture('hello');const results=await Promise.all(Array.from({length:10},()=>h.bridge.accept(f)));await h.bridge.idle();
 assert.equal(h.backend.calls.length,1);assert.equal(new Set(results.map(x=>x.taskId)).size,1);assert.equal(results.filter(x=>x.duplicate).length,9);
 const replay=await h.bridge.accept(f);assert(replay.duplicate);await h.bridge.idle();assert.equal(h.backend.calls.length,1);
});
test('Q05/B03: duplicate /new increments generation once and never invokes Agent',async t=>{
 const h=harness(t);await h.bridge.accept(fixture('a'));await h.bridge.idle();const command=fixture('/new');await h.bridge.accept(command);await h.bridge.accept(command);
 await h.bridge.accept(fixture('b'));await h.bridge.idle();assert.equal(h.backend.calls.length,2);assert.equal(h.backend.calls[1]!.generation,1);assert.equal(h.backend.refs[1],undefined);
});
test('N08: unknown command fails explicitly without running Agent',async t=>{
 const h=harness(t),r=await h.bridge.accept(fixture('/unknown'));assert.equal(h.store.get(r.taskId!).status,'failed');assert.equal(h.store.get(r.taskId!).error_code,'UNSUPPORTED_COMMAND');assert.equal(h.backend.calls.length,0);
});
test('Q08/Q04: control commands do not wait for Agent; rejected tasks start no media work',async t=>{
 const h=harness(t);h.c.queue.maxPendingPerSession=1;let release!:(r:AgentResult)=>void;const held=new Promise<AgentResult>(resolve=>{release=resolve;});h.backend.action=()=>held;
 await h.bridge.accept(fixture('first'));await eventually(()=>h.backend.calls.length===1);
 let preparations=0;const original=h.media.prepare.bind(h.media);h.media.prepare=(...args)=>{preparations++;return original(...args);};
 await h.bridge.accept(fixture('second'));const rejected=await h.bridge.accept(fixture('third'));assert.equal(rejected.rejected,'QUEUE_FULL');assert.equal(preparations,1);
 const begin=Date.now(),status=await h.bridge.accept(fixture('/status'));assert.equal(h.store.get(status.taskId!).status,'succeeded');assert(Date.now()-begin<1000);
 release({outcome:'success',finalText:'done'});await h.bridge.idle();assert.equal(h.backend.maxActive,1);
});
test('M10: later image is persisted while previous Agent turn is still running',async t=>{
 const h=harness(t);let release!:(r:AgentResult)=>void;const held=new Promise<AgentResult>(resolve=>{release=resolve;});h.backend.action=()=>held;
 await h.bridge.accept(fixture('first'));await eventually(()=>h.backend.calls.length===1);
 const file=path.join(h.root,'image.png');writeFileSync(file,await sharp({create:{width:3,height:3,channels:3,background:{r:0,g:0,b:255}}}).png().toBuffer());
 const r=await h.bridge.accept(fixture('describe','default',randomUUID(),[file]));await eventually(()=>h.store.get(r.taskId!).status==='queued');
 assert.equal(JSON.parse(h.store.get(r.taskId!).input_json).images.length,1);assert.equal(h.backend.calls.length,1);
 release({outcome:'success',finalText:'done'});await h.bridge.idle();assert.equal(h.backend.calls.length,2);
});
test('Q03: preparing image cannot be overtaken by a later text',async t=>{
 const h=harness(t);let release!:(images:ImageRef[])=>void,first=true;const held=new Promise<ImageRef[]>(resolve=>{release=resolve;});
 h.media.prepare=async()=>{if(first){first=false;return held;}return [];};
 await h.bridge.accept(fixture('first'));await h.bridge.accept(fixture('second'));await new Promise(r=>setTimeout(r,30));assert.equal(h.backend.calls.length,0);
 release([]);await h.bridge.idle();assert.deepEqual(h.backend.calls.map(x=>x.text),['first','second']);
});
test('Q06: commands cannot cancel or retrieve another conversation task',async t=>{
 const h=harness(t),a=await h.bridge.accept(fixture('private','one'));await h.bridge.idle();
 for(const cmd of ['/cancel','/result']){const r=await h.bridge.accept(fixture(`${cmd} ${a.taskId}`,'two'));assert.equal(h.store.get(r.taskId!).status,'failed');assert.equal(h.store.get(r.taskId!).error_code,'TASK_NOT_FOUND');}
 assert.equal(h.backend.calls.length,1);
});
test('D07/R05: explicit result retrieval is delivery only, never Agent execution',async t=>{
 const h=harness(t),r=await h.bridge.accept(fixture('answer'));await h.bridge.idle();await h.bridge.accept(fixture(`/result ${r.taskId}`));
 const pump=new OutboxPump(h.store,h.channel,h.c.reply);while(await pump.tick()){}
 assert.equal(h.backend.calls.length,1);assert.equal(h.channel.sent.length,2);
});
test('E2E Codex: complete local transport/store/backend/reply and restart resume',async t=>{
 const h=setup(t),out=output();let service=await openService(h.c,out.stream);h.cleanups.push(()=>service.stop());
 const first=await service.accept(fixture('nonce 1280'));await service.settle();assert.equal(service.store.get(first.taskId!).status,'succeeded');await service.stop();
 service=await openService(h.c,out.stream);const second=await service.accept(fixture('follow up'));await service.settle();
 const answer=JSON.parse(service.store.get(second.taskId!).result_text!);assert.deepEqual(answer.history,['nonce 1280','follow up']);assert(out.values().some(v=>v.type==='result'));
});
test('E2E Codex: cancelled task blocks new execution and /new cannot bypass review',async t=>{
 const h=setup(t,'codex','hang'),out=output(),service=await openService(h.c,out.stream);h.cleanups.push(()=>service.stop());
 const task=await service.accept(fixture('long task'));await eventually(()=>existsSync(path.join(h.workspace,'side-effect.txt')));
 await service.accept(fixture(`/cancel ${task.taskId}`));await service.settle();assert.equal(service.store.get(task.taskId!).status,'interrupted');assert(service.store.blocked());
 const next=await service.accept(fixture('do more'));assert.equal(next.rejected,'WORKSPACE_BLOCKED');
 const fresh=await service.accept(fixture('/new'));assert.equal(service.store.get(fresh.taskId!).status,'failed');assert.equal(service.store.get(fresh.taskId!).error_code,'WORKSPACE_BLOCKED');
});
