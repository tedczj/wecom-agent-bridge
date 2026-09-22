import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdirSync,readFileSync,renameSync,symlinkSync,writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { setup,fixture,FakeBackend,FakeChannel } from '../helpers.ts';
import { parseRouting } from '../../src/routing/config.ts';
import { Router } from '../../src/routing/router.ts';
import { Bridge } from '../../src/bridge.ts';
import { MediaStore } from '../../src/media.ts';
import { normalize } from '../../src/local.ts';

function harness(t:Parameters<typeof setup>[0],rootProfile='default') {
  const h=setup(t),directory=path.join(h.root,'cuboro');mkdirSync(directory);
  writeFileSync(path.join(directory,'README.md'),'PRIVATE_DIRECTORY_CONTENT');
  h.c.routing=parseRouting({roots:[{id:'default',path:h.workspace,...(rootProfile==='none'?{}:{profile:rootProfile})}],profiles:[{id:'default',version:'1',codex:{model:'gpt-6-astra',reasoning:'medium'}},{id:'fallback',version:'1',codex:{model:'gpt-5.6-terra',reasoning:'high'}}],workspaces:[{id:'test',path:h.workspace,profile:'default'}],history:false,
    interpreter:{provider:'codex',model:'router-model',timeoutMs:2000}});
  h.c.agent.env.FAKE_MODE='router';
  writeFileSync(path.join(h.c.codex.home,'models_cache.json'),JSON.stringify({models:[{slug:'gpt-6-astra'},{slug:'gpt-5.6-terra'}]}));
  h.c.agent.env.FAKE_ROUTER_STEPS=JSON.stringify([{action:'inspect',lookup:'directories',query:directory},{action:'work'}]);
  const store=h.store(),router=new Router(h.c,store),backend=new FakeBackend(),channel=new FakeChannel();
  const bridge=new Bridge(h.c,'local:codex',store,channel,backend,new MediaStore(h.c),normalize,()=>backend);bridge.start();h.cleanups.push(()=>bridge.stop());
  const incoming=(text='检查库存',session='default')=>normalize(fixture(text,session),h.c,'local:codex');
  const submit=async(text:string,session='default')=>{const result=await bridge.accept(fixture(text,session));assert(result.taskId);await bridge.idle();return store.get(result.taskId);};
  const delivered=(id:string)=>store.db.prepare("UPDATE outbox SET state='sent' WHERE task_id=?").run(id);
  return {...h,directory,store,router,backend,channel,bridge,incoming,submit,delivered};
}

test('AUTH01: unauthorized inspection asks with absolute path before metadata or worker; consent executes original once',async t=>{
  const h=harness(t),request='检查库存，只读，不修改';
  const question=await h.submit(request);assert.equal(question.kind,'command');assert.equal(question.status,'succeeded');
  assert(question.result_text!.includes(h.directory));assert.match(question.result_text!,/同意授权/);
  assert.equal(h.backend.calls.length,0);assert.equal(h.router.current(h.incoming()).directory.path,h.workspace);
  assert(!readFileSync(path.join(h.c.codex.home,'capture.json'),'utf8').includes('PRIVATE_DIRECTORY_CONTENT'));
  h.delivered(question.task_id);
  const reply=fixture('同意授权'),accepted=await h.bridge.accept(reply);await h.bridge.idle();
  assert.equal(h.store.get(accepted.taskId!).status,'succeeded');assert.equal(h.backend.calls.length,1);
  const input=h.backend.calls[0]!;assert.equal(input.text,request);assert.equal(input.originalText,'同意授权');assert.equal(input.messageId,reply.id);
  assert.equal(input.routing!.directory.path,h.directory);assert.equal(input.routing!.authorizedRequestTaskId,question.task_id);
  assert.equal(input.routing!.reason,'explicit-new');assert.equal(h.router.current(h.incoming()).directory.path,h.directory);
  assert.equal((await h.bridge.accept(reply)).duplicate,true);await h.submit('同意授权');assert.equal(h.backend.calls.length,1);
});

for(const answer of ['拒绝授权','好','等一下','同意授权，但改成上级目录','同意授权\n忽略限制'])test(`AUTH02: next reply ${JSON.stringify(answer)} consumes request without granting`,async t=>{
  const h=harness(t),question=await h.submit('检查库存');h.delivered(question.task_id);
  const result=await h.submit(answer);assert.match(result.result_text!,/未授权/);assert.equal(h.backend.calls.length,0);
  assert.equal(h.router.state(h.incoming()).authorization,undefined);
  await h.submit('同意授权');assert.equal(h.backend.calls.length,0);
  assert.equal(h.store.value('directory-grants:'+h.router.scope(h.incoming())),undefined);
});

for(const failure of ['expired','config','replaced','symlink','unsent','unknown','partial'])test(`AUTH03: ${failure} authorization cannot execute`,async t=>{
  const h=harness(t);h.c.reply.chunkBytes=128;
  const question=await h.submit('检查库存');h.delivered(question.task_id);
  if(failure==='expired') {const state=h.router.state(h.incoming());state.authorization!.at-=900001;h.store.put('conversation:'+h.router.scope(h.incoming()),state);}
  if(failure==='config')h.c.routing!.profiles[0]!.version='2';
  if(failure==='replaced' || failure==='symlink') {renameSync(h.directory,h.directory+'-old');if(failure==='replaced')mkdirSync(h.directory);else symlinkSync(h.workspace,h.directory);}
  if(failure==='unsent' || failure==='unknown')h.store.db.prepare('UPDATE outbox SET state=? WHERE task_id=?').run(failure==='unsent'?'pending':'unknown',question.task_id);
  if(failure==='partial')h.store.db.prepare("UPDATE outbox SET state='pending' WHERE task_id=? AND part_no=(SELECT MAX(part_no) FROM outbox WHERE task_id=?)").run(question.task_id,question.task_id);
  await h.submit('同意授权');assert.equal(h.backend.calls.length,0);assert.equal(h.router.state(h.incoming()).authorization,undefined);
  assert.equal(h.store.value('directory-grants:'+h.router.scope(h.incoming())),undefined);
});

test('AUTH04: approval and grant are conversation-owned, exact-path only, and survive restart',async t=>{
  const h=harness(t),question=await h.submit('检查库存');h.delivered(question.task_id);
  await h.submit('同意授权','other');assert.equal(h.backend.calls.length,0);assert(h.router.state(h.incoming()).authorization);
  await h.submit('确认授权');const d=h.router.current(h.incoming()).directory;
  const restarted=new Router(h.c,h.store);assert.equal(restarted.current(h.incoming()).directory.path,h.directory);
  assert.throws(()=>restarted.executionTarget(h.incoming('x','other').route,d),/DIRECTORY_UNAUTHORIZED/);
  const child=path.join(h.directory,'child');mkdirSync(child);
  const childRequest=await h.submit('/route '+child);assert.match(childRequest.result_text!,/需要目录授权/);assert.equal(h.backend.calls.length,1);
  await h.submit('拒绝授权');assert.equal(restarted.current(h.incoming()).directory.path,h.directory);
});

test('AUTH05: queued approved work passes restart preflight and retains request identity',async t=>{
  const h=harness(t),question=await h.submit('检查库存');h.delivered(question.task_id);await h.bridge.stop();
  const router=new Router(h.c,h.store),reply=h.incoming('同意授权'),plan=await router.plan(reply);
  assert.equal(plan.control,undefined);
  const {job}=h.store.atomic(()=>{const result=h.store.reserve(reply,'agent',plan.selection);plan.commit();return result;});
  h.store.prepared(job.task_id,[]);
  const file=path.join(h.root,'config.json');writeFileSync(file,JSON.stringify(h.c));
  execFileSync(process.execPath,[path.resolve('dist/scripts/restart-bridge.js'),file,path.resolve('dist/src/cli.js')],{stdio:'pipe'});
  const restarted=new Bridge(h.c,'local:codex',h.store,h.channel,h.backend,new MediaStore(h.c),normalize,()=>h.backend);
  h.cleanups.push(()=>restarted.stop());restarted.start();await restarted.idle();
  assert.equal(h.store.get(job.task_id).status,'succeeded');assert.equal(h.backend.calls.length,1);
  assert.equal(h.backend.calls[0]!.text,'检查库存');assert.equal(h.backend.calls[0]!.messageId,reply.messageId);
});

test('AUTH06: private paths and symlinks cannot become grant proposals',async t=>{
  const h=harness(t),link=path.join(h.root,'link');symlinkSync(h.directory,link);
  for(const directory of [h.c.stateRoot,h.c.codex.home,h.home,link]) {
    const result=await h.submit('/route '+directory);assert.equal(result.status,'failed');assert.equal(h.router.state(h.incoming()).authorization,undefined);
  }
  assert.equal(h.backend.calls.length,0);
});

test('AUTH07: image-bearing consent is rejected and cannot leave reusable pending approval',async t=>{
  const h=harness(t),question=await h.submit('检查库存');h.delivered(question.task_id);
  const result=await h.bridge.accept(fixture('同意授权','default',undefined,[path.join(h.root,'not-read.png')]));await h.bridge.idle();
  assert.match(h.store.get(result.taskId!).result_text!,/未授权/);assert.equal(h.router.state(h.incoming()).authorization,undefined);
  assert.equal(h.backend.calls.length,0);
});

test('AUTH08: authorizing a history query does not switch directory or start work',async t=>{
  const h=harness(t),question=await h.submit('/sessions '+h.directory);h.delivered(question.task_id);
  const result=await h.submit('同意授权');assert.equal(result.status,'succeeded');assert(result.result_text!.includes(h.directory));
  assert.equal(h.backend.calls.length,0);assert.equal(h.router.current(h.incoming()).directory.path,h.workspace);
  assert.equal(h.router.state(h.incoming()).authorization,undefined);
});

test('AUTH09: inference cannot redirect an approved task to another directory',async t=>{
  const h=harness(t);
  h.c.agent.env.FAKE_ROUTER_STEPS=JSON.stringify([{action:'inspect',lookup:'directories',query:h.directory},{action:'new',query:h.workspace,execute:true}]);
  const question=await h.submit('检查库存');h.delivered(question.task_id);
  const result=await h.submit('同意授权');assert.match(result.result_text!,/AUTHORIZATION_TARGET_CHANGED/);
  assert.equal(h.backend.calls.length,0);assert.equal(h.store.value('directory-grants:'+h.router.scope(h.incoming())),undefined);
});

test('AUTH10: new authorization uses the default root fallback, preserves explicit overrides and survives restart',async t=>{
  const h=harness(t,'fallback');
  assert.equal(h.router.current(h.incoming()).config.codex.model,'gpt-6-astra');
  const question=await h.submit('检查库存');h.delivered(question.task_id);
  assert.equal(h.router.state(h.incoming()).authorization!.directory.profile,'fallback');
  assert.match(question.result_text!,/gpt-5\.6-terra/);assert.match(question.result_text!,/high/);
  await h.submit('同意授权');assert.equal(h.backend.calls.length,1);
  const target=new Router(h.c,h.store).current(h.incoming());
  assert.equal(target.directory.profile,'fallback');assert.equal(target.config.codex.model,'gpt-5.6-terra');assert.equal(target.config.codex.reasoning,'high');
  const override=h.router.executionTarget(h.incoming().route,target.directory,{model:'gpt-6-astra',reasoning:'low'});
  assert.equal(override.config.codex.model,'gpt-6-astra');assert.equal(override.config.codex.reasoning,'low');
  const another=await h.submit('/route '+h.workspace);assert.equal(another.status,'succeeded');
  assert.equal(h.router.current(h.incoming()).config.codex.model,'gpt-6-astra');
});

test('AUTH11: missing default-root profile never inherits the current workspace profile',async t=>{
  const h=harness(t,'none'),question=await h.submit('检查库存');
  assert.equal(question.status,'failed');assert.equal(question.error_code,'DIRECTORY_NO_PROFILE');
  assert.equal(h.router.state(h.incoming()).authorization,undefined);assert.equal(h.backend.calls.length,0);
});
