import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { loadConfig, preparePaths } from '../src/config.ts';
import { clearStaleLock, processAlive } from '../src/fsutil.ts';
import { errorCode, invariant } from '../src/errors.ts';
import { Store } from '../src/store.ts';
import { maintenanceActive,type Maintenance } from '../src/maintenance.ts';

function running(pid:number):boolean {
  if(!processAlive(pid))return false;
  // A stopped supervisor cannot reap its exited worker until it resumes/exits.
  try{return !execFileSync('ps',['-p',String(pid),'-o','stat='],{encoding:'utf8'}).trim().startsWith('Z');}catch{return processAlive(pid);}
}

// Only stop this CLI's instance with the same verified state and owner.
async function main(): Promise<void> {
  const [configFile, cliFile, backend] = process.argv.slice(2);
  invariant(configFile && cliFile, 'RESTART_ARGUMENT');
  const c = loadConfig(configFile);
  invariant(!backend || backend === c.backend, 'START_BACKEND_MISMATCH');
  preparePaths(c);
  // Check even without a live lock: queued work must not cross backend boundaries.
  const safeToSwitch = () => {
    const dbFile = path.join(c.stateRoot, 'bridge.sqlite');
    if (!existsSync(dbFile)) return;
    const store = new Store(dbFile, c, true);
    try {
      const managerFile=path.join(c.stateRoot,'supervisor','instance.lock');
      const manager=existsSync(managerFile)?JSON.parse(readFileSync(managerFile,'utf8')):undefined;
      invariant(!maintenanceActive(store.value<Maintenance>('maintenance')) || !manager || !running(manager.pid),'MAINTENANCE_BUSY');
      const foreign = store.db.prepare(`SELECT 1 FROM jobs j JOIN sessions s USING(session_key)
        WHERE s.backend != ? AND json_extract(j.input_json,'$.routing') IS NULL AND j.status IN ('preparing','queued','running','cancel_requested') LIMIT 1`).get(c.backend);
      invariant(!foreign, 'BACKEND_SWITCH_BUSY');
      // Hierarchical startup revalidates queued directory, profile, selection and effect snapshots.
    } finally { store.close(); }
  };
  safeToSwitch();
  const lockFile = path.join(c.stateRoot, 'instance.lock');
  if (!existsSync(lockFile)) return;
  invariant(!lstatSync(lockFile).isSymbolicLink(), 'UNSAFE_LOCK');
  const lock = JSON.parse(readFileSync(lockFile, 'utf8'));
  const supervisorFile=path.join(c.stateRoot,'supervisor','instance.lock');
  const supervisor=existsSync(supervisorFile)?JSON.parse(readFileSync(supervisorFile,'utf8')):undefined;
  let supervisorIdentity='';
  if(supervisor && running(supervisor.pid)) {
    invariant(!lstatSync(supervisorFile).isSymbolicLink() && typeof supervisor.configFile==='string','RESTART_PROCESS_MISMATCH');
    const parent=Number(execFileSync('ps',['-p',String(lock.pid),'-o','ppid='],{encoding:'utf8'}).trim());
    invariant(parent===supervisor.pid,'RESTART_PROCESS_MISMATCH');
    invariant(execFileSync('ps',['-p',String(lock.pid),'-o','command='],{encoding:'utf8'}).trim().endsWith(' --config '+supervisor.configFile),'RESTART_PROCESS_MISMATCH');
    supervisorIdentity=execFileSync('ps',['-p',String(supervisor.pid),'-o','lstart=','-o','command='],{encoding:'utf8'}).trim();
    invariant(supervisorIdentity.includes(` ${cliFile} start --config ${supervisor.configFile}`),'RESTART_PROCESS_MISMATCH');
  }
  invariant(Number.isSafeInteger(lock.pid) && lock.pid > 1 && typeof lock.token === 'string', 'UNSAFE_LOCK');
  if (running(lock.pid)) {
    const identity = () => {
      try { return execFileSync('ps', ['-p', String(lock.pid), '-o', 'lstart=', '-o', 'command='], {encoding:'utf8'}).trim(); }
      catch { return ''; }
    };
    const original = identity();
    const prefix = ['serve','start'].map(command => ` ${cliFile} ${command} --config `).find(value => original.includes(value));
    invariant(prefix, 'RESTART_PROCESS_MISMATCH');
    const previousFile = original.slice(original.indexOf(prefix) + prefix.length);
    if (previousFile !== configFile) {
      // A different config is accepted only for an explicit backend selection.
      invariant(backend && path.isAbsolute(previousFile) && existsSync(previousFile), 'RESTART_PROCESS_MISMATCH');
      const previous = loadConfig(previousFile); preparePaths(previous);
      invariant(previous.stateRoot === c.stateRoot && previous.workspace.path === c.workspace.path &&
        previous.workspace.id === c.workspace.id && previous.local.actorId === c.local.actorId &&
        previous.transport === c.transport, 'RESTART_PROCESS_MISMATCH');
    }
    const signal = (value: NodeJS.Signals) => {
      if (!running(lock.pid)) return;
      invariant(identity() === original, 'RESTART_PROCESS_MISMATCH');
      invariant(JSON.parse(readFileSync(lockFile, 'utf8')).token === lock.token, 'RESTART_LOCK_CHANGED');
      try { process.kill(lock.pid, value); }
      catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ESRCH') throw e; }
    };
    const wait = async (ms: number) => {
      const until = Date.now() + ms;
      while (running(lock.pid) && Date.now() < until) await sleep(100);
    };
    process.stderr.write(`Stopping bridge PID ${lock.pid}...\n`);
    signal('SIGTERM'); await wait(15000);
    if (running(lock.pid)) {
      process.stderr.write(`Bridge PID ${lock.pid} did not stop; sending SIGKILL.\n`);
      signal('SIGKILL'); await wait(5000);
    }
    invariant(!running(lock.pid), 'INSTANCE_RUNNING');
  }
  if (existsSync(lockFile)) {
    invariant(JSON.parse(readFileSync(lockFile, 'utf8')).token === lock.token, 'RESTART_LOCK_CHANGED');
    clearStaleLock(c.stateRoot);
  }
  if(supervisorIdentity && processAlive(supervisor.pid)) {
    const signal=(value:NodeJS.Signals)=>{
      if(!processAlive(supervisor.pid))return;
      let identity:string,token:string;
      try {identity=execFileSync('ps',['-p',String(supervisor.pid),'-o','lstart=','-o','command='],{encoding:'utf8'}).trim();token=JSON.parse(readFileSync(supervisorFile,'utf8')).token;}
      catch(e) {if(!processAlive(supervisor.pid) || (e as NodeJS.ErrnoException).code==='ENOENT')return;throw e;}
      invariant(identity===supervisorIdentity,'RESTART_PROCESS_MISMATCH');
      invariant(token===supervisor.token,'RESTART_LOCK_CHANGED');try{process.kill(supervisor.pid,value);}catch(e){if((e as NodeJS.ErrnoException).code!=='ESRCH')throw e;}
    };
    signal('SIGTERM');let until=Date.now()+15000;while(processAlive(supervisor.pid)&&Date.now()<until)await sleep(100);
    if(processAlive(supervisor.pid)) {process.stderr.write(`Supervisor PID ${supervisor.pid} did not stop; sending SIGKILL.\n`);signal('SIGKILL');until=Date.now()+5000;while(processAlive(supervisor.pid)&&Date.now()<until)await sleep(100);}
    invariant(!processAlive(supervisor.pid),'INSTANCE_RUNNING');
  }
  if(existsSync(supervisorFile))clearStaleLock(path.dirname(supervisorFile));
  // Do not acknowledge uncertain Agent effects on behalf of the operator.
  invariant(!existsSync(path.join(c.stateRoot, 'agent-process.json')), 'AGENT_PROCESS_REVIEW_REQUIRED');
  safeToSwitch();
}
main().catch(e => {
  process.stderr.write(`Bridge restart failed: ${errorCode(e)}\n`);
  process.exitCode = 1;
});
