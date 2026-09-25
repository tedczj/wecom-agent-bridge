import { harness } from '../hierarchical-helpers.ts';
import { normalize } from '../../src/local.ts';
import { Catalog } from '../../src/routing/catalog.ts';
import { RequestStore, sha256 } from '../../src/orchestration/requests.ts';
import { BusinessDispatch } from '../../src/orchestration/dispatch.ts';
import { randomUUID } from 'node:crypto';
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, writeFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { MediaStore } from '../../src/media.ts';
import { OutboxPump } from '../../src/reply.ts';
import { deadline } from '../../src/async.ts';
import { setupService as setup, fixture, FakeBackend, FakeChannel } from '../helpers.ts';
async function crash(t:TestContext,stage:string) {
 const h=setup(t),file=path.join(h.root,'config.json');writeFileSync(file,JSON.stringify(h.c));
 const child=spawn(process.execPath,[path.resolve('tests/fakes/crash.mjs'),file,stage],{stdio:['ignore','pipe','pipe']});let stderr='';child.stderr.on('data',b=>{stderr+=b;});
 const exited=once(child,'exit');h.cleanups.push(()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');});
 await deadline(new Promise<void>((resolve,reject)=>{let text='';child.stdout.on('data',b=>{text+=b;if(text.includes('READY\n'))resolve();});child.once('error',reject);child.once('exit',()=>reject(new Error(stderr)));}),3000,'CRASH_READY_TIMEOUT');
 child.kill('SIGKILL');const [,signal]=await exited;assert.equal(signal,'SIGKILL');
 const store=h.store(),info=JSON.parse(readFileSync(path.join(h.c.stateRoot,'crash-info.json'),'utf8')) as {id:string;frame:unknown};
 const backend=new FakeBackend(),channel=new FakeChannel(),media=new MediaStore(h.c);
 return {...h,store,info,backend,channel,media};
}
test('R01: SIGKILL preparing fails safely and removes orphan partial files',async t=>{
 const h=await crash(t,'preparing');h.store.recover();assert.equal(h.store.get(h.info.id).status,'failed');assert.equal(h.store.get(h.info.id).error_code,'MEDIA_PREPARATION_INTERRUPTED');await h.media.gc(h.store.activeMedia());assert(!existsSync(path.join(h.media.root,h.info.id)));
});
test('R02: SIGKILL queued retains durable input; unverified work is never implicitly replayed',async t=>{
 const h=await crash(t,'queued');h.store.recover();assert.equal(h.store.get(h.info.id).status,'queued');assert.equal(h.backend.calls.length,0);assert.equal(JSON.parse(h.store.get(h.info.id).input_json).text,'crash task');

});
test('R03: SIGKILL after side effects blocks workspace; no automatic rerun or reset',async t=>{
 const h=await crash(t,'running');h.store.recover();assert.equal(h.store.get(h.info.id).status,'interrupted');assert(h.store.blocked());assert.equal(h.backend.calls.length,0);
 assert.equal(readFileSync(path.join(h.workspace,'changed.txt'),'utf8'),'SIDE EFFECT ALREADY HAPPENED');
 assert.equal(h.store.review(),1);assert.equal(h.store.session(h.store.get(h.info.id).session_key).state,'tainted');
});
test('R04: SIGKILL inside transaction rolls back result and terminal status',async t=>{
 const h=await crash(t,'transaction');assert.equal(h.store.get(h.info.id).status,'running');assert.equal(h.store.get(h.info.id).result_text,null);assert.equal(h.store.db.prepare('SELECT count(*) n FROM outbox').get()!.n,0);h.store.recover();assert(h.store.blocked());
});
test('R05: SIGKILL after result commit recovers delivery only, never execution',async t=>{
 const h=await crash(t,'pending');h.store.recover();const pump=new OutboxPump(h.store,h.channel,h.c.reply);assert(await pump.tick());assert.equal(h.channel.sent.length,1);assert.match(h.channel.sent[0]!.text,/durable answer/);assert.equal(h.backend.calls.length,0);
});
test('R06: SIGKILL while sending becomes unknown; /result does not run Agent',async t=>{
 const h=await crash(t,'sending');h.store.recover();assert.equal(h.store.db.prepare('SELECT state FROM outbox').get()!.state,'unknown');const pump=new OutboxPump(h.store,h.channel,h.c.reply);assert.equal(await pump.tick(),false);
 assert.equal(h.store.get(h.info.id).result_text,'durable answer');assert.equal(h.backend.calls.length,0);
});

test('R02 OFFLINE hierarchical cold start executes a verified queued original once and deduplicates replay', async t => {
  const frame = fixture('queued original'), h = await harness(t, undefined, async ({ store, c, controllers, sessions }) => {
    const requests = new RequestStore(store), request = requests.accept(normalize(frame, c, 'local:codex')).request;
    requests.transition(request.request_id, request.conversation_scope, ['accepted'], 'bridge_planning');
    requests.transition(request.request_id, request.conversation_scope, ['bridge_planning'], 'route_planning');
    const catalog = new Catalog(c), target = catalog.target(catalog.configured[0]!, c.models!.daily!);
    const actor = controllers.registry.prepare(request.conversation_scope, 'route', sha256(JSON.stringify([target.directory.path, target.directory.identity])), 'offline-model');
    controllers.registry.registerNative(actor.controller_id, { threadId: randomUUID(), generation: 0 }, 'management-home');
    controllers.registry.activate(actor.controller_id, null); controllers.registry.beginTurn(actor.controller_id);
    const binding = { requestId: request.request_id, scope: request.conversation_scope, controllerId: actor.controller_id, generation: 0 };
    const options = await sessions.resolve(binding, target, 'new');
    const selected = await sessions.select(binding, target, options.options.find(option => option.isDefault)!.optionToken);
    const job = new BusinessDispatch(store, controllers.registry).enqueue(binding, selected.token, selected.selection, () => sessions.validate(binding, target, selected));
    sessions.bind(binding, target, selected, job); store.prepared(job.task_id, []);
  });
  await h.settle(); assert.equal(h.calls.length, 1); assert.equal(h.calls[0]!.text, frame.text);
  const replay = await h.bridge.accept(frame); assert.equal(replay.duplicate, true); await h.settle();
  assert.equal(h.calls.length, 1); assert.equal(h.store.get(replay.taskId!).status, 'succeeded');
});
