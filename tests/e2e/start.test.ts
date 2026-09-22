import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { setup, eventually, input } from '../helpers.ts';

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

test('start.sh: explicit backend switch preserves shared state and stops only the matching instance', async t => {
  const h = setup(t), codexConfig = path.join(h.root, 'codex config.json'), piConfig = path.join(h.root, 'pi config.json');
  writeFileSync(codexConfig, JSON.stringify(h.c));
  writeFileSync(piConfig, JSON.stringify({...h.c, backend:'pi', agent:{...h.c.agent,
    command:path.resolve('tests/fakes/pi.mjs'), isolation:'external', sessionRoot:path.join(h.root,'pi-sessions')}}));
  const store = h.store();
  store.db.prepare("INSERT INTO metadata(key,value) VALUES ('test:cursor','preserve-me')").run();
  const lock = path.join(h.c.stateRoot, 'instance.lock');
  const launch = (backend: string, config: string) => {
    const child = spawn(launcher, ['--backend',backend,config], {cwd:h.root,stdio:'pipe'});
    const exit = once(child,'exit'); let stderr = '';
    child.stdout.resume(); child.stderr.on('data', b => { stderr += b; });
    h.cleanups.push(async () => { if (child.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); await exit; } });
    return {child,exit,stderr:()=>stderr};
  };
  const ready = (pid: number) => eventually(() => {
    try { return JSON.parse(readFileSync(lock,'utf8')).pid === pid; } catch { return false; }
  },25000);
  const first = launch('codex',codexConfig); await ready(first.child.pid!);
  const mismatch = launch('pi',codexConfig);
  assert.equal((await mismatch.exit)[0],1); assert.match(mismatch.stderr(),/START_BACKEND_MISMATCH/);
  assert.equal(JSON.parse(readFileSync(lock,'utf8')).pid,first.child.pid);
  const second = launch('pi',piConfig); await ready(second.child.pid!); await first.exit;
  assert.match(second.stderr(),/Stopping bridge PID/);
  const third = launch('codex',codexConfig); await ready(third.child.pid!); await second.exit;
  third.child.stdin.end(); assert.equal((await third.exit)[0],0,third.stderr());
  assert.equal(store.db.prepare("SELECT value FROM metadata WHERE key='test:cursor'").get()!.value,'preserve-me');
  assert(!existsSync(lock));
});

test('start.sh: refuses switching queued work to another backend, including after a crash', async t => {
  const h = setup(t), store = h.store(), i = input();
  const {job} = store.reserve({messageId:i.messageId,reqId:i.messageId,receivedAt:i.receivedAt,text:i.text,media:[],route:i.route},'agent');
  store.db.prepare("UPDATE jobs SET status='queued' WHERE task_id=?").run(job.task_id);
  const config = path.join(h.root,'pi.json');
  writeFileSync(config,JSON.stringify({...h.c,backend:'pi',agent:{...h.c.agent,command:path.resolve('tests/fakes/pi.mjs'),isolation:'external'}}));
  const child = spawn(launcher,['--backend','pi',config],{cwd:h.root,stdio:['ignore','pipe','pipe']});
  let stderr=''; child.stdout.resume(); child.stderr.on('data', b => { stderr+=b; });
  assert.equal((await once(child,'exit'))[0],1); assert.match(stderr,/BACKEND_SWITCH_BUSY/);
  assert.equal(store.get(job.task_id).status,'queued');
  assert(!existsSync(path.join(h.c.stateRoot,'instance.lock')));
});
