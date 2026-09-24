import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn,execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { cpSync,existsSync,mkdirSync,readFileSync,writeFileSync,symlinkSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { setup,eventually } from '../helpers.ts';
import type { Maintenance } from '../../src/maintenance.ts';

async function launch(t:Parameters<typeof setup>[0],fixtureRepo=false,mode='normal') {
  const h=setup(t);h.c.agent.env.FAKE_MODE=mode;h.c.agent.env.FAKE_EXIT_DELAY_MS='2000';const config=path.join(h.root,'config.json');writeFileSync(config,JSON.stringify(h.c));
  let cli=path.resolve('dist/src/cli.js'),env:NodeJS.ProcessEnv={PATH:process.env.PATH,HOME:h.home};
  const repo=path.join(h.root,'repo');
  if(fixtureRepo) {
    mkdirSync(repo);cpSync(path.resolve('dist'),path.join(repo,'dist'),{recursive:true});
    symlinkSync(path.resolve('node_modules'),path.join(repo,'node_modules'));
    writeFileSync(path.join(repo,'package.json'),' {"type":"module"}\n');
    writeFileSync(path.join(repo,'.gitignore'),'dist/\nnode_modules/\n');
    const git=(...args:string[])=>execFileSync('git',args,{cwd:repo,stdio:'pipe'});
    git('init','--quiet','--initial-branch=dev');git('config','user.name','Fixture');git('config','user.email','fixture@example.invalid');git('add','.');git('commit','-qm','baseline');
    const origin=path.join(h.root,'origin.git');execFileSync('git',['clone','--bare','--quiet',repo,origin]);git('remote','add','origin',origin);
    const next=path.join(h.root,'next');execFileSync('git',['clone','--quiet',origin,next]);
    writeFileSync(path.join(next,'release.txt'),'second');execFileSync('git',['-C',next,'add','.']);
    execFileSync('git',['-C',next,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','next']);execFileSync('git',['-C',next,'push','--quiet']);
    const bin=path.join(h.root,'bin');mkdirSync(bin);
    // Offline npm double: preserves real Node/bridge processes but does not install or run network/model tests.
    writeFileSync(path.join(bin,'npm'),`#!${process.execPath}\nconst fs=require('fs'),path=require('path');const root=process.cwd();if(process.argv[2]==='ci'){fs.symlinkSync(${JSON.stringify(path.resolve('node_modules'))},path.join(root,'node_modules'));}else if(process.argv[2]==='run'&&process.argv[3]==='check'){if(fs.existsSync(${JSON.stringify(path.join(h.root,'fail-check'))}))process.exit(7);fs.cpSync(${JSON.stringify(path.resolve('dist'))},path.join(root,'dist'),{recursive:true});}else process.exit(9);\n`,{mode:0o755});
    env.PATH=bin+path.delimiter+env.PATH;cli=path.join(repo,'dist/src/cli.js');
  }
  const child=spawn(process.execPath,[cli,'start','--config',config],{env,stdio:'pipe'}),exit=once(child,'exit');let stderr='';const frames:any[]=[];let buffer='';
  child.stderr.on('data',b=>{stderr+=b;});child.stdout.on('data',b=>{buffer+=b;let n;while((n=buffer.indexOf('\n'))>=0){frames.push(JSON.parse(buffer.slice(0,n)));buffer=buffer.slice(n+1);}});
  h.cleanups.push(async()=>{if(child.exitCode===null && child.signalCode===null){child.kill('SIGTERM');await exit;}});
  await eventually(()=>existsSync(path.join(h.c.stateRoot,'instance.lock')) && existsSync(path.join(h.c.stateRoot,'supervisor','worker.json')),10000).catch(e=>{throw Error(e.message+stderr);});
  const store=h.store();
  const send=async(text:string,session='owner',id=randomUUID())=>{
    child.stdin.write(JSON.stringify({id,session,text})+'\n');await eventually(()=>!!store.db.prepare('SELECT 1 FROM jobs WHERE message_id=?').get(id),10000);
    const row=store.db.prepare('SELECT task_id FROM jobs WHERE message_id=?').get(id) as {task_id:string};
    return {id,taskId:row.task_id};
  };
  const delivered=async(id:string)=>eventually(()=>!!store.db.prepare("SELECT 1 FROM outbox WHERE task_id=? AND state='sent'").get(id)&&!store.db.prepare("SELECT 1 FROM outbox WHERE task_id=? AND state!='sent'").get(id),10000);
  const worker=()=>JSON.parse(readFileSync(path.join(h.c.stateRoot,'instance.lock'),'utf8')).pid;
  return {...h,config,child,exit,store,frames,send,delivered,worker,repo,stderr:()=>stderr};
}

test('MG01: /restart waits for next owned /approve, changes worker PID and sends final result once',async t=>{
  const h=await launch(t),pid=h.worker();
  const request=await h.send('/restart');await h.delivered(request.taskId);assert.match(h.store.get(request.taskId).result_text!,/\/approve/);
  const foreign=await h.send('/approve','other');await eventually(()=>h.store.get(foreign.taskId).status==='failed');assert.equal(h.worker(),pid);
  const approval=await h.send('/approve');
  await eventually(()=>h.store.get(approval.taskId).status==='succeeded',15000).catch(e=>{throw Error(e.message+h.stderr());});
  await h.delivered(approval.taskId);assert.notEqual(h.worker(),pid);assert.match(h.store.get(approval.taskId).result_text!,/重启完成/);
  const after=h.worker();await h.send('/approve','owner',approval.id);assert.equal(h.worker(),after);
  assert.equal(h.store.db.prepare("SELECT count(*) n FROM outbox WHERE task_id=? AND purpose='maintenance-final'").get(approval.taskId)!.n,1);
  assert(!existsSync(path.join(h.c.codex.home,'capture.json')));
  h.child.stdin.end();assert.equal((await h.exit)[0],0,h.stderr());
});

test('MG02: a non-approval next message cancels management approval; command arguments cannot execute',async t=>{
  const h=await launch(t),pid=h.worker(),request=await h.send('/restart');await h.delivered(request.taskId);
  await h.send('等一下');const approval=await h.send('/approve');await eventually(()=>h.store.get(approval.taskId).status==='failed');
  assert.equal(h.worker(),pid);assert.equal(h.store.value<Maintenance>('maintenance')!.phase,'failed');
  assert(!existsSync(path.join(h.c.codex.home,'capture.json')));
  const args=await h.send('/update --force');await eventually(()=>h.store.get(args.taskId).status==='failed');assert.equal(h.store.get(args.taskId).error_code,'COMMAND_ARGUMENTS');
});

for(const fail of [false,true])test(`MG03: offline update ${fail?'restores runtime artifacts on check failure':'fast-forwards dev and verifies replacement'} without replaying work`,async t=>{
  const h=await launch(t,true),before=execFileSync('git',['-C',h.repo,'rev-parse','HEAD'],{encoding:'utf8'}).trim(),pid=h.worker();
  if(fail)writeFileSync(path.join(h.root,'fail-check'),'yes');
  writeFileSync(path.join(h.repo,'user-note.txt'),'preserve untracked');
  const request=await h.send('/update');await h.delivered(request.taskId);const approval=await h.send('/approve');
  await eventually(()=>['succeeded','failed'].includes(h.store.get(approval.taskId).status),20000).catch(e=>{throw Error(e.message+h.stderr());});
  await h.delivered(approval.taskId);assert.notEqual(h.worker(),pid);assert.equal(readFileSync(path.join(h.repo,'user-note.txt'),'utf8'),'preserve untracked');
  const result=h.store.get(approval.taskId);assert.equal(result.status,fail?'failed':'succeeded');if(fail)assert.equal(result.error_code,'UPDATE_CHECK_FAILED');
  assert.notEqual(execFileSync('git',['-C',h.repo,'rev-parse','HEAD'],{encoding:'utf8'}).trim(),before);
  assert(existsSync(path.join(h.repo,'dist/src/cli.js')));assert(existsSync(path.join(h.repo,'node_modules')));
  assert(!h.store.db.prepare("SELECT 1 FROM jobs WHERE kind='agent'").get());
});

test('MG04: tracked local changes refuse update without stopping the worker',async t=>{
  const h=await launch(t,true),pid=h.worker();writeFileSync(path.join(h.repo,'package.json'),'{"type":"module","local":true}');
  const request=await h.send('/update');await h.delivered(request.taskId);const approval=await h.send('/approve');
  await eventually(()=>h.store.get(approval.taskId).status==='failed',10000);
  assert.equal(h.store.get(approval.taskId).error_code,'UPDATE_DIRTY_WORKTREE');assert.equal(h.worker(),pid);
});

test('MG05: approved restart drains running work, rejects new work, and keeps result retrieval separate',async t=>{
  const h=await launch(t,false,'late-exit'),work=await h.send('first work'),pid=h.worker();
  await eventually(()=>h.store.get(work.taskId).status==='running');
  const request=await h.send('/restart');await h.delivered(request.taskId);const approval=await h.send('/approve');
  assert.equal(h.store.get(work.taskId).status,'running');assert.equal(h.worker(),pid);
  const rejected=await h.send('do not run');await eventually(()=>h.store.get(rejected.taskId).status==='failed');assert.equal(h.store.get(rejected.taskId).error_code,'MAINTENANCE_DRAINING');
  await eventually(()=>h.store.get(approval.taskId).status==='succeeded',15000);assert.equal(h.store.get(work.taskId).status,'succeeded');
  assert.notEqual(h.worker(),pid);
  const result=await h.send('/result '+approval.taskId);await h.delivered(result.taskId);assert.match(h.store.get(result.taskId).result_text!,/重启完成/);
  assert.equal(h.store.db.prepare("SELECT count(*) n FROM jobs WHERE kind='agent'").get()!.n,1);
});

for(const invalid of ['expired','unknown-delivery'])test(`MG06: ${invalid} approval never restarts`,async t=>{
  const h=await launch(t),pid=h.worker(),request=await h.send('/restart');await h.delivered(request.taskId);
  if(invalid==='expired'){const m=h.store.value<Maintenance>('maintenance')!;h.store.put('maintenance',{...m,at:m.at-900001});}
  else h.store.db.prepare("UPDATE outbox SET state='unknown' WHERE task_id=?").run(request.taskId);
  const approval=await h.send('/approve');await eventually(()=>h.store.get(approval.taskId).status==='failed');
  assert.equal(h.worker(),pid);assert.equal(h.store.value<Maintenance>('maintenance')!.phase,'failed');
});

test('MG07: an unexpected supervisor exit never replays an approved maintenance operation',async t=>{
  const h=await launch(t,false,'late-exit'),work=await h.send('work');await eventually(()=>h.store.get(work.taskId).status==='running');
  const request=await h.send('/restart');await h.delivered(request.taskId);const approval=await h.send('/approve');
  assert.equal(h.store.value<Maintenance>('maintenance')!.phase,'requested');h.child.kill('SIGKILL');await h.exit;
  await eventually(()=>!existsSync(path.join(h.c.stateRoot,'instance.lock')),10000);
  // A fresh supervisor has a new token. Startup marks the abandoned control job failed, never reruns it.
  const cli=path.resolve('dist/src/cli.js');
  execFileSync(process.execPath,[path.resolve('dist/scripts/restart-bridge.js'),h.config,cli],{stdio:'pipe'});
  const child=spawn(process.execPath,[cli,'start','--config',h.config],{stdio:'pipe'}),exit=once(child,'exit');
  child.stdout.resume();child.stderr.resume();h.cleanups.push(async()=>{if(child.exitCode===null&&child.signalCode===null){child.kill('SIGTERM');await exit;}});
  await eventually(()=>h.store.get(approval.taskId).status==='failed',10000);
  assert.equal(h.store.value<Maintenance>('maintenance')!.phase,'failed');assert.equal(h.store.get(work.taskId).status,'interrupted');
});

test('MG08: /update never changes main and refuses an untracked collision without deleting it',async t=>{
  const h=await launch(t,true),pid=h.worker();
  execFileSync('git',['-C',h.repo,'checkout','--quiet','-b','main']);
  let request=await h.send('/update');await h.delivered(request.taskId);let approval=await h.send('/approve');
  await eventually(()=>h.store.get(approval.taskId).status==='failed',10000);assert.equal(h.store.get(approval.taskId).error_code,'UPDATE_BRANCH_REQUIRED');assert.equal(h.worker(),pid);
  execFileSync('git',['-C',h.repo,'checkout','--quiet','dev']);writeFileSync(path.join(h.repo,'release.txt'),'untracked user content');
  request=await h.send('/update');await h.delivered(request.taskId);approval=await h.send('/approve');
  await eventually(()=>h.store.get(approval.taskId).status==='failed',10000);await h.delivered(approval.taskId);
  assert.equal(h.store.get(approval.taskId).error_code,'UPDATE_PULL_FAILED');assert.equal(readFileSync(path.join(h.repo,'release.txt'),'utf8'),'untracked user content');
});
