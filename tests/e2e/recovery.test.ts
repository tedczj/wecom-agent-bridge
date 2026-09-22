import { test,type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync,writeFileSync,readFileSync } from 'node:fs';
import path from 'node:path';
import { Bridge } from '../../src/bridge.ts';
import { MediaStore } from '../../src/media.ts';
import { OutboxPump } from '../../src/reply.ts';
import { deadline } from '../../src/async.ts';
import { setup,fixture,FakeBackend,FakeChannel } from '../helpers.ts';
async function crash(t:TestContext,stage:string) {
 const h=setup(t),file=path.join(h.root,'config.json');writeFileSync(file,JSON.stringify(h.c));
 const child=spawn(process.execPath,[path.resolve('tests/fakes/crash.mjs'),file,stage],{stdio:['ignore','pipe','pipe']});let stderr='';child.stderr.on('data',b=>{stderr+=b;});
 const exited=once(child,'exit');h.cleanups.push(()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');});
 await deadline(new Promise<void>((resolve,reject)=>{let text='';child.stdout.on('data',b=>{text+=b;if(text.includes('READY\n'))resolve();});child.once('error',reject);child.once('exit',()=>reject(new Error(stderr)));}),3000,'CRASH_READY_TIMEOUT');
 child.kill('SIGKILL');const [,signal]=await exited;assert.equal(signal,'SIGKILL');
 const store=h.store(),info=JSON.parse(readFileSync(path.join(h.c.stateRoot,'crash-info.json'),'utf8')) as {id:string;frame:unknown};
 const backend=new FakeBackend(),channel=new FakeChannel(),media=new MediaStore(h.c),bridge=new Bridge(h.c,'local:codex',store,channel,backend,media);h.cleanups.push(()=>bridge.stop());
 return {...h,store,info,backend,channel,media,bridge};
}
test('R01: SIGKILL preparing fails safely and removes orphan partial files',async t=>{
 const h=await crash(t,'preparing');h.store.recover();assert.equal(h.store.get(h.info.id).status,'failed');assert.equal(h.store.get(h.info.id).error_code,'MEDIA_PREPARATION_INTERRUPTED');await h.media.gc(h.store.activeMedia());assert(!existsSync(path.join(h.media.root,h.info.id)));
});
test('R02: SIGKILL queued executes once after restart; replay remains deduplicated',async t=>{
 const h=await crash(t,'queued');h.bridge.start();await h.bridge.idle();assert.equal(h.backend.calls.length,1);assert.equal(h.store.get(h.info.id).status,'succeeded');assert((await h.bridge.accept(h.info.frame)).duplicate);await h.bridge.idle();assert.equal(h.backend.calls.length,1);
});
test('R03: SIGKILL after side effects blocks workspace; no automatic rerun or reset',async t=>{
 const h=await crash(t,'running');h.bridge.start();await h.bridge.idle();assert.equal(h.store.get(h.info.id).status,'interrupted');assert(h.store.blocked());assert.equal(h.backend.calls.length,0);
 assert.equal(readFileSync(path.join(h.workspace,'changed.txt'),'utf8'),'SIDE EFFECT ALREADY HAPPENED');assert.equal((await h.bridge.accept(fixture('new'))).rejected,'WORKSPACE_BLOCKED');
 assert.equal(h.store.review(),1);assert.equal(h.store.session(h.store.get(h.info.id).session_key).state,'tainted');assert.equal((await h.bridge.accept(fixture('new again'))).rejected,'SESSION_TAINTED');
});
test('R04: SIGKILL inside transaction rolls back result and terminal status',async t=>{
 const h=await crash(t,'transaction');assert.equal(h.store.get(h.info.id).status,'running');assert.equal(h.store.get(h.info.id).result_text,null);assert.equal(h.store.db.prepare('SELECT count(*) n FROM outbox').get()!.n,0);h.store.recover();assert(h.store.blocked());
});
test('R05: SIGKILL after result commit recovers delivery only, never execution',async t=>{
 const h=await crash(t,'pending');h.bridge.start();await h.bridge.idle();const pump=new OutboxPump(h.store,h.channel,h.c.reply);assert(await pump.tick());assert.equal(h.channel.sent.length,1);assert.match(h.channel.sent[0]!.text,/durable answer/);assert.equal(h.backend.calls.length,0);
});
test('R06: SIGKILL while sending becomes unknown; /result does not run Agent',async t=>{
 const h=await crash(t,'sending');h.bridge.start();await h.bridge.idle();assert.equal(h.store.db.prepare('SELECT state FROM outbox').get()!.state,'unknown');const pump=new OutboxPump(h.store,h.channel,h.c.reply);assert.equal(await pump.tick(),false);
 await h.bridge.accept(fixture(`/result ${h.info.id}`));await pump.tick();assert.equal(h.channel.sent.length,1);assert.equal(h.backend.calls.length,0);
});
