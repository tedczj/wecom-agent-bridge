import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { setup, eventually } from '../helpers.ts';

const launcher = path.resolve('start.sh');
test('start.sh: restarts its live instance, recovers a stale lock and preserves JSONL stdout', async t => {
  const h = setup(t), config = path.join(h.root, 'config with spaces.json');
  writeFileSync(config, JSON.stringify(h.c));
  const lock = path.join(h.c.stateRoot, 'instance.lock');
  const launch = () => {
    const child = spawn(launcher, [config], {cwd:h.root, stdio:'pipe'});
    const exit = once(child, 'exit'); let stdout = '', stderr = '';
    child.stdout.on('data', b => { stdout += b; });
    child.stderr.on('data', b => { stderr += b; });
    h.cleanups.push(async () => { if (child.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); await exit; } });
    return {child, exit, stdout:()=>stdout, stderr:()=>stderr};
  };
  const ready = (pid: number) => eventually(() => {
    try { return JSON.parse(readFileSync(lock, 'utf8')).pid === pid; } catch { return false; }
  }, 25000);
  const first = launch(); await ready(first.child.pid!);
  const second = launch(); await ready(second.child.pid!);
  await first.exit;
  assert.match(second.stderr(), /Stopping bridge PID/);
  // Suspend the idle bridge so it cannot handle SIGTERM; verify escalation.
  second.child.kill('SIGSTOP');
  const forced = launch(); await ready(forced.child.pid!);
  const [, signal] = await second.exit;
  assert.equal(signal, 'SIGKILL'); assert.match(forced.stderr(), /sending SIGKILL/);
  forced.child.kill('SIGKILL'); await forced.exit;
  assert(existsSync(lock));
  const third = launch(); await ready(third.child.pid!);
  third.child.stdin.end(JSON.stringify({id:'launcher-help',session:'demo',text:'/help',images:[]})+'\n');
  const [code] = await third.exit;
  assert.equal(code, 0, third.stderr());
  const frames = third.stdout().trim().split('\n').map(line => JSON.parse(line));
  assert(frames.some(frame => frame.type === 'result'));
  assert(!existsSync(lock));
  assert(!existsSync(path.join(h.c.codex.home, 'capture.json')));
});

test('start.sh: refuses a lock pointing to an unrelated live process', async t => {
  const h = setup(t), config = path.join(h.root, 'config.json');
  writeFileSync(config, JSON.stringify(h.c));
  const lock = path.join(h.c.stateRoot, 'instance.lock');
  const contents = JSON.stringify({pid:process.pid,token:'unrelated-process'});
  writeFileSync(lock, contents);
  const child = spawn(launcher, [config], {cwd:h.root, stdio:['ignore','pipe','pipe']});
  let stderr = ''; child.stdout.resume(); child.stderr.on('data', b => { stderr += b; });
  const [code] = await once(child, 'exit');
  assert.equal(code, 1); assert.match(stderr, /RESTART_PROCESS_MISMATCH/);
  assert.equal(readFileSync(lock, 'utf8'), contents);
});
