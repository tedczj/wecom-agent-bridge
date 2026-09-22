import { spawn,execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { cpSync,existsSync,mkdirSync,mkdtempSync,readFileSync,realpathSync,symlinkSync,writeFileSync } from 'node:fs';
import { tmpdir,homedir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { parseConfig,preparePaths } from '../src/config.ts';
import { Store } from '../src/store.ts';
import { invariant,errorCode } from '../src/errors.ts';

/** Real Git + npm + supervisor, isolated local clone/state; no Agent and no Weixin. */
async function main():Promise<void> {
  invariant(process.argv.slice(2).join(' ')==='--live','LIVE_OPT_IN_REQUIRED');
  const source=process.cwd(),root=mkdtempSync(path.join(realpathSync(tmpdir()),'bridge-maintenance-live-')),repo=path.join(root,'repo');mkdirSync(repo);
  const git=(cwd:string,...args:string[])=>execFileSync('git',['-C',cwd,...args],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
  const files=git(source,'ls-files','--cached','--others','--exclude-standard').split('\n');
  for(const name of new Set(files)) {invariant(!path.isAbsolute(name) && !name.split('/').includes('..'),'SMOKE_PATH');const target=path.join(repo,name);mkdirSync(path.dirname(target),{recursive:true});cpSync(path.join(source,name),target);}
  cpSync(path.join(source,'dist'),path.join(repo,'dist'),{recursive:true});symlinkSync(path.join(source,'node_modules'),path.join(repo,'node_modules'));
  git(repo,'init','--quiet','--initial-branch=dev');git(repo,'config','user.name','Maintenance smoke');git(repo,'config','user.email','smoke@example.invalid');git(repo,'add','.');git(repo,'commit','-qm','isolated baseline');
  const origin=path.join(root,'origin.git');git(root,'clone','--bare','--quiet',repo,origin);git(repo,'remote','add','origin',origin);
  const next=path.join(root,'next');git(root,'clone','--quiet',origin,next);writeFileSync(path.join(next,'MAINTENANCE_SMOKE.txt'),'synthetic update\n');git(next,'add','MAINTENANCE_SMOKE.txt');git(next,'-c','user.name=Maintenance smoke','-c','user.email=smoke@example.invalid','commit','-qm','synthetic update');git(next,'push','--quiet');
  const expected=git(next,'rev-parse','HEAD'),home=path.join(root,'home');mkdirSync(home);
  const c=parseConfig({workspace:{id:'smoke',path:repo},stateRoot:path.join(root,'state'),agent:{command:path.join(repo,'tests/fakes/codex.mjs'),env:{HOME:home}}});preparePaths(c);
  const config=path.join(root,'config.json');writeFileSync(config,JSON.stringify(c),{mode:0o600});
  const env=Object.fromEntries(['PATH','HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','NO_PROXY','http_proxy','https_proxy','all_proxy','no_proxy'].flatMap(k=>process.env[k]===undefined?[]:[[k,process.env[k]!]]));
  const child=spawn(process.execPath,[path.join(repo,'dist/src/cli.js'),'start','--config',config],{env:{...env,HOME:homedir()},stdio:'pipe'}),exited=once(child,'exit');child.stdout.resume();child.stderr.resume();
  let store:Store|undefined;
  const wait=async(check:()=>boolean)=>{const until=Date.now()+240000;while(!check()){invariant(child.exitCode===null && child.signalCode===null,'SMOKE_SERVICE_EXIT');invariant(Date.now()<until,'SMOKE_TIMEOUT');await sleep(100);}};
  try {
    await wait(()=>existsSync(path.join(c.stateRoot,'supervisor','worker.json')));
    store=new Store(path.join(c.stateRoot,'bridge.sqlite'),c);
    const before=JSON.parse(readFileSync(path.join(c.stateRoot,'instance.lock'),'utf8')).pid;
    const send=async(text:string)=>{const id=randomUUID();child.stdin.write(JSON.stringify({id,session:'smoke',text})+'\n');await wait(()=>!!store!.db.prepare('SELECT 1 FROM jobs WHERE message_id=?').get(id));return (store!.db.prepare('SELECT task_id FROM jobs WHERE message_id=?').get(id) as {task_id:string}).task_id;};
    const request=await send('/update');await wait(()=>!!store!.db.prepare("SELECT 1 FROM outbox WHERE task_id=? AND state='sent'").get(request)&&!store!.db.prepare("SELECT 1 FROM outbox WHERE task_id=? AND state!='sent'").get(request));
    console.log(JSON.stringify({check:'real-update-question',passed:true,agentInvoked:false,weixinSent:false}));
    const task=await send('/approve');await wait(()=>['failed','succeeded'].includes(store!.get(task).status));
    invariant(store.get(task).status==='succeeded',store.get(task).error_code??'SMOKE_UPDATE_FAILED');
    await wait(()=>!store!.db.prepare("SELECT 1 FROM outbox WHERE task_id=? AND state!='sent'").get(task));
    invariant(git(repo,'rev-parse','HEAD')===expected,'SMOKE_UPDATE_HEAD');
    invariant(JSON.parse(readFileSync(path.join(c.stateRoot,'instance.lock'),'utf8')).pid!==before,'SMOKE_WORKER_NOT_REPLACED');
    invariant(!store.db.prepare("SELECT 1 FROM jobs WHERE kind='agent'").get(),'SMOKE_AGENT_EXECUTED');
    console.log(JSON.stringify({check:'real-git-npm-update-restart-receipt',passed:true,fastForward:true,dependencyInstall:true,fullCheck:true,workerReplaced:true,finalDeliveredLocally:true,agentInvoked:false,weixinSent:false}));
  } finally {store?.close();if(child.exitCode===null && child.signalCode===null){child.kill('SIGTERM');await exited;}}
}
main().catch(e=>{console.error(JSON.stringify({event:'maintenance.smoke_failed',code:errorCode(e)}));process.exitCode=1;});
