import { spawn,execFileSync,type ChildProcess } from 'node:child_process';
import { existsSync,readFileSync,renameSync,rmSync,writeFileSync } from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { preparePaths,type Config } from './config.ts';
import { acquireLock,clearStaleLock,privateDirectory } from './fsutil.ts';
import { BridgeError,errorCode,invariant,log } from './errors.ts';
import { Store } from './store.ts';
import { type Maintenance } from './maintenance.ts';

function hostEnvironment():NodeJS.ProcessEnv {
  const keys=['HOME','PATH','LANG','TMPDIR','SSH_AUTH_SOCK','HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','NO_PROXY','http_proxy','https_proxy','all_proxy','no_proxy'];
  return Object.fromEntries(keys.flatMap(k=>process.env[k]===undefined?[]:[[k,process.env[k]!]]));
}
function git(root:string,args:string[],env:NodeJS.ProcessEnv):string {
  try{return execFileSync('git',['-C',root,...args],{env,encoding:'utf8',timeout:30000,stdio:['ignore','pipe','ignore']}).trim();}
  catch {throw new BridgeError('UPDATE_GIT_FAILED');}
}
/** A stable parent owns maintenance; stopping a worker never kills the updater or its receipt. */
export async function supervise(c:Config,configFile:string,cliFile:string):Promise<number> {
  preparePaths(c);
  const root=path.resolve(path.dirname(cliFile),'../..'),supervisorRoot=privateDirectory(path.join(c.stateRoot,'supervisor'));
  clearStaleLock(supervisorRoot);const unlock=acquireLock(supervisorRoot);
  const lockFile=path.join(supervisorRoot,'instance.lock'),lock=JSON.parse(readFileSync(lockFile,'utf8')),token=lock.token as string;
  writeFileSync(lockFile,JSON.stringify({...lock,root,configFile}),{mode:0o600});
  const env=hostEnvironment(),database=path.join(c.stateRoot,'bridge.sqlite');
  let child:ChildProcess|undefined,childExited:Promise<void>=Promise.resolve(),ready=false,stopping=false,operation:ChildProcess|undefined;
  let stoppedForMaintenance=false,stopKill:NodeJS.Timeout|undefined;
  const stop=()=>{stopping=true;child?.kill('SIGTERM');if(operation?.pid){try{process.kill(-operation.pid,'SIGTERM');const pid=operation.pid;stopKill=setTimeout(()=>{try{process.kill(-pid,'SIGKILL');}catch{}},5000);}catch{}}};
  process.once('SIGTERM',stop);process.once('SIGINT',stop);
  const startWorker=async(persistent=false)=>{
    ready=false;
    const credentials=Object.fromEntries(c.agent.passEnv.flatMap(k=>process.env[k]===undefined?[]:[[k,process.env[k]!]]));
    child=spawn(process.execPath,[cliFile,'start','--config',configFile],{cwd:root,env:{...env,...credentials,BRIDGE_SUPERVISOR_TOKEN:token},stdio:['pipe','inherit','inherit','ipc']});
    const started=child;childExited=new Promise(resolve=>{started.once('exit',()=>resolve());started.once('error',()=>resolve());});
    started.on('message',message=>{if((message as {type?:string})?.type==='bridge-ready')ready=true;});
    if(started.stdin) {started.stdin.on('error',()=>{});process.stdin.pipe(started.stdin);}
    const until=Date.now()+(c.transport==='weixin' && !existsSync(path.join(c.stateRoot,'weixin-auth.json'))?310000:30000);
    while(!ready && started.exitCode===null && started.signalCode===null && Date.now()<until && !stopping)await sleep(50);
    invariant(ready && (started.exitCode===null && started.signalCode===null || !persistent && started.exitCode===0),'MAINTENANCE_START_FAILED');
    const marker=path.join(supervisorRoot,'worker.json');writeFileSync(marker+'.tmp',JSON.stringify({pid:started.pid,readyAt:Date.now()}),{mode:0o600});renameSync(marker+'.tmp',marker);
  };
  const stopWorker=async()=>{
    if(!child || child.exitCode!==null || child.signalCode!==null)return;
    if(child.stdin){process.stdin.unpipe(child.stdin);process.stdin.pause();}
    child.kill('SIGTERM');
    const until=Date.now()+30000;
    while(child.exitCode===null && child.signalCode===null && Date.now()<until)await sleep(50);
    // Do not force-kill or clear an Agent's uncertain execution state.
    invariant(child.exitCode!==null || child.signalCode!==null,'MAINTENANCE_STOP_FAILED');await childExited;
    invariant(!existsSync(path.join(c.stateRoot,'instance.lock')) && !existsSync(path.join(c.stateRoot,'agent-process.json')),'MAINTENANCE_STOP_UNVERIFIED');
  };
  const run=async(command:string,args:string[],code:string)=>{
    invariant(!stopping,'MAINTENANCE_INTERRUPTED');
    operation=spawn(command,args,{cwd:root,env,stdio:'ignore',detached:true});
    const running=operation;
    const timer=setTimeout(()=>{try{process.kill(-running.pid!,'SIGKILL');}catch{}},900000);
    try {const exit=await new Promise<number|null>(resolve=>{running.once('error',()=>resolve(null));running.once('exit',n=>resolve(n));});invariant(exit===0 && !stopping,stopping?'MAINTENANCE_INTERRUPTED':code);}
    finally {clearTimeout(timer);clearTimeout(stopKill);operation=undefined;}
  };
  const finish=(m:Maintenance,code?:string)=>{
    const store=new Store(database,c);
    try {store.atomic(()=>{
      store.put('maintenance',{...m,phase:code?'failed':'succeeded',code});
      const message=code?`服务管理未完成（${code}），未自动重试。${m.action==='update'?'源码可能已拉取；原运行产物已保留，未重放工作任务。':''}`:
        `${m.action==='update'?'更新检查通过，':'重启完成，'}桥接服务已恢复。${m.newHead?'\n运行版本：'+m.newHead.slice(0,12):''}`;
      store.complete(m.taskId,code?'failed':'succeeded',message,code,['queued'],undefined,'maintenance-final');
    });}finally{store.close();}
  };
  try {
    await startWorker();
    while(!stopping && child?.exitCode===null && child.signalCode===null) {
      await sleep(100);
      let m:Maintenance|undefined;
      const store=new Store(database,c,true);
      try {
        m=store.value<Maintenance>('maintenance');
        if(!m || m.phase!=='requested' || m.supervisorToken!==token)continue;
        if(store.blocked()){finish(m,'WORKSPACE_BLOCKED');continue;}
        if(store.db.prepare("SELECT 1 FROM jobs WHERE kind='agent' AND status IN ('preparing','queued','running','cancel_requested')").get() || existsSync(path.join(c.stateRoot,'routing-agent','state','agent-process.json')))continue;
      }finally{store.close();}
      const backup=path.join(supervisorRoot,'backup-'+m.taskId),moved:string[]=[];
      const save=()=>{const db=new Store(database,c);try{db.put('maintenance',m);}finally{db.close();}};
      try {
        if(m.action==='update') {
          invariant(git(root,['rev-parse','--show-toplevel'],env)===root,'UPDATE_REPOSITORY_MISMATCH');
          invariant(git(root,['branch','--show-current'],env)==='dev','UPDATE_BRANCH_REQUIRED');
          invariant(!git(root,['status','--porcelain','--untracked-files=no'],env),'UPDATE_DIRTY_WORKTREE');
          m.oldHead=git(root,['rev-parse','HEAD'],env);
          invariant(existsSync(path.join(root,'dist')) && existsSync(path.join(root,'node_modules')),'UPDATE_RUNTIME_MISSING');
        }
        m.phase='running';save();await stopWorker();stoppedForMaintenance=true;
        if(m.action==='update') {
          await run('git',['pull','--ff-only','origin','dev'],'UPDATE_PULL_FAILED');
          m.newHead=git(root,['rev-parse','HEAD'],env);save();
          privateDirectory(backup);
          writeFileSync(path.join(backup,'manifest.json'),JSON.stringify({taskId:m.taskId,root,oldHead:m.oldHead,newHead:m.newHead}),{mode:0o600});
          // Move only generated runtime artifacts; source changes and untracked user files stay intact.
          for(const name of ['dist','node_modules']) {renameSync(path.join(root,name),path.join(backup,name));moved.push(name);}
          await run(process.platform==='win32'?'npm.cmd':'npm',['ci','--no-audit','--no-fund'],'UPDATE_INSTALL_FAILED');
          await run(process.platform==='win32'?'npm.cmd':'npm',['run','check'],'UPDATE_CHECK_FAILED');
        }
        m.phase='starting';save();await startWorker(true);stoppedForMaintenance=false;
        finish(m);if(moved.length)try {rmSync(backup,{recursive:true,force:true});}catch {log('maintenance.backup_retained',{code:'BACKUP_CLEANUP_FAILED'});}
      } catch(e) {
        const code=errorCode(e,'MAINTENANCE_FAILED');
        if(moved.length) {
          if(child?.exitCode===null && child.signalCode===null)await stopWorker();
          for(const name of moved) {
            rmSync(path.join(root,name),{recursive:true,force:true});
            if(existsSync(path.join(backup,name)))renameSync(path.join(backup,name),path.join(root,name));
          }
        }
        finish(m,code);
        if(stoppedForMaintenance && !stopping) {await startWorker(true);stoppedForMaintenance=false;}
      }
    }
    return stopping?130:child?.exitCode??1;
  } finally {
    process.removeListener('SIGTERM',stop);process.removeListener('SIGINT',stop);
    if(child?.stdin)process.stdin.unpipe(child.stdin);
    if(child?.exitCode===null && child.signalCode===null){child.kill('SIGTERM');await childExited;}
    unlock();
  }
}
