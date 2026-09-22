import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { loadConfig, preparePaths } from '../src/config.ts';
import { clearStaleLock, processAlive } from '../src/fsutil.ts';
import { errorCode, invariant } from '../src/errors.ts';

// Only stop the instance launched with this exact CLI and configuration.
async function main(): Promise<void> {
  const [configFile, cliFile] = process.argv.slice(2);
  invariant(configFile && cliFile, 'RESTART_ARGUMENT');
  const c = loadConfig(configFile); preparePaths(c);
  const lockFile = path.join(c.stateRoot, 'instance.lock');
  if (!existsSync(lockFile)) return;
  invariant(!lstatSync(lockFile).isSymbolicLink(), 'UNSAFE_LOCK');
  const lock = JSON.parse(readFileSync(lockFile, 'utf8'));
  invariant(Number.isSafeInteger(lock.pid) && lock.pid > 1 && typeof lock.token === 'string', 'UNSAFE_LOCK');
  if (processAlive(lock.pid)) {
    const identity = () => {
      try { return execFileSync('ps', ['-p', String(lock.pid), '-o', 'lstart=', '-o', 'command='], {encoding:'utf8'}).trim(); }
      catch { return ''; }
    };
    const original = identity();
    invariant(['serve','start'].some(command => original.endsWith(` ${cliFile} ${command} --config ${configFile}`)), 'RESTART_PROCESS_MISMATCH');
    const signal = (value: NodeJS.Signals) => {
      if (!processAlive(lock.pid)) return;
      invariant(identity() === original, 'RESTART_PROCESS_MISMATCH');
      invariant(JSON.parse(readFileSync(lockFile, 'utf8')).token === lock.token, 'RESTART_LOCK_CHANGED');
      try { process.kill(lock.pid, value); }
      catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ESRCH') throw e; }
    };
    const wait = async (ms: number) => {
      const until = Date.now() + ms;
      while (processAlive(lock.pid) && Date.now() < until) await sleep(100);
    };
    process.stderr.write(`Stopping bridge PID ${lock.pid}...\n`);
    signal('SIGTERM'); await wait(15000);
    if (processAlive(lock.pid)) {
      process.stderr.write(`Bridge PID ${lock.pid} did not stop; sending SIGKILL.\n`);
      signal('SIGKILL'); await wait(5000);
    }
    invariant(!processAlive(lock.pid), 'INSTANCE_RUNNING');
  }
  if (existsSync(lockFile)) {
    invariant(JSON.parse(readFileSync(lockFile, 'utf8')).token === lock.token, 'RESTART_LOCK_CHANGED');
    clearStaleLock(c.stateRoot);
  }
  // Do not acknowledge uncertain Agent effects on behalf of the operator.
  invariant(!existsSync(path.join(c.stateRoot, 'agent-process.json')), 'AGENT_PROCESS_REVIEW_REQUIRED');
}
main().catch(e => {
  process.stderr.write(`Bridge restart failed: ${errorCode(e)}\n`);
  process.exitCode = 1;
});
