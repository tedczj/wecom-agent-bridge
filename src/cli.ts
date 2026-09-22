import { reviewWorkspaceLock } from './routing/lock.ts';
import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, rmSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadConfig, preparePaths, type Config } from './config.ts';
import { openService, type LocalService } from './main.ts';
import { Store } from './store.ts';
import { JsonlFramer } from './rpc-jsonl.ts';
import { acquireLock, clearStaleLock, processAlive } from './fsutil.ts';
import { errorCode, invariant, log } from './errors.ts';
import { runWeixin } from './weixin.ts';
import { supervise } from './supervisor.ts';
import { supervised } from './maintenance.ts';
const help = `Local Agent Bridge (Codex / Pi)
Usage:
  node dist/src/cli.js start --config FILE
  node dist/src/cli.js run --config FILE --message TEXT [--image FILE ...] [--session NAME] [--id ID]
  node dist/src/cli.js run --config FILE --stdin [--image FILE ...] [--session NAME] [--id ID]
  node dist/src/cli.js serve --config FILE
  node dist/src/cli.js status --config FILE
  node dist/src/cli.js result --config FILE --task ID
  node dist/src/cli.js review --config FILE --acknowledge-side-effects
serve: one JSON object per line: {"id":"request-1","session":"default","text":"...","images":[]}
Control text: /help /status /new /cancel [taskId] /result taskId [part]
run uses a fresh process but resumes the selected persisted conversation; Ctrl-C cancels.
Exit codes: 0 success, 1 rejected/failed, 2 interrupted/nonterminal/undelivered, 130 signal.
`;
interface Args {command: string; options: Map<string,string[]>; flags: Set<string>}
export function parseArgs(args: string[]): Args {
  const [command = 'help', ...rest] = args;
  invariant(['help','--help','start','run','serve','status','result','review'].includes(command), 'CLI_COMMAND');
  const options = new Map<string,string[]>(), flags = new Set<string>();
  const allowed = command === 'run' ? ['--config','--message','--image','--session','--id']
    : command === 'result' ? ['--config','--task'] : ['--config'];
  for (let i = 0; i < rest.length; i++) {
    const k = rest[i]!;
    if ((k === '--stdin' && command === 'run') || (k === '--acknowledge-side-effects' && command === 'review')) {
      invariant(!flags.has(k), 'CLI_DUPLICATE'); flags.add(k); continue;
    }
    invariant(allowed.includes(k) && rest[i+1] !== undefined, 'CLI_ARGUMENT');
    const v = rest[++i]!;
    invariant(k === '--image' || !options.has(k), 'CLI_DUPLICATE');
    options.set(k, [...(options.get(k) ?? []), v]);
  }
  return {command, options, flags};
}
function inspect(c: Config, task?: string): unknown {
  c.workspace.path = realpathSync(c.workspace.path);
  const file = path.join(c.stateRoot, 'bridge.sqlite');
  invariant(existsSync(file), 'STATE_NOT_INITIALIZED');
  const store = new Store(file, c, true);
  try {
    if (!task) return store.summary();
    invariant(/^[0-9a-f]{8}-[0-9a-f-]{27}$/.test(task), 'TASK_ID_INVALID');
    const job = store.get(task);
    return {taskId:job.task_id, status:job.status, text:job.result_text, errorCode:job.error_code};
  } finally { store.close(); }
}
export function review(c: Config, acknowledged: boolean): number {
  invariant(acknowledged, 'REVIEW_ACK_REQUIRED'); preparePaths(c);
  clearStaleLock(c.stateRoot);
  const unlock = acquireLock(c.stateRoot);
  const routerRoot=path.join(c.stateRoot,'routing-agent');
  try {
    for(const marker of [path.join(c.stateRoot,'agent-process.json'),path.join(routerRoot,'state','agent-process.json')]) if (existsSync(marker)) {
      invariant(!lstatSync(marker).isSymbolicLink(), 'UNSAFE_PROCESS_MARKER');
      const data = JSON.parse(readFileSync(marker, 'utf8'));
      invariant(Number.isSafeInteger(data.pid) && data.pid > 0 && !processAlive(data.pid), 'AGENT_STILL_RUNNING');
      let groupAlive = false;
      try { process.kill(-data.pid, 0); groupAlive = true; }
      catch (e) { invariant((e as NodeJS.ErrnoException).code === 'ESRCH', 'AGENT_STATE_UNKNOWN'); }
      invariant(!groupAlive, 'AGENT_STILL_RUNNING');
      rmSync(marker);
    }
    if(existsSync(routerRoot))clearStaleLock(routerRoot);
    const store = new Store(path.join(c.stateRoot, 'bridge.sqlite'), c);
    try {
      store.recover();
      reviewWorkspaceLock(c.workspace.path,c.stateRoot);
      for(const row of store.db.prepare("SELECT DISTINCT json_extract(input_json,'$.routing.directory') directory FROM jobs WHERE json_extract(input_json,'$.routing.directory') IS NOT NULL").all() as {directory:string}[]) {
        const directory=JSON.parse(row.directory);reviewWorkspaceLock(directory.path,c.stateRoot,directory.identity);
      }
      return store.review();
    } finally { store.close(); }
  } finally { unlock(); }
}
export async function runCli(argv = process.argv.slice(2)): Promise<number> {
  const args = parseArgs(argv);
  if (args.command === 'help' || args.command === '--help') { process.stdout.write(help); return 0; }
  const one = (k: string) => args.options.get(k)?.[0];
  invariant(one('--config'), 'CONFIG_ARGUMENT_REQUIRED');
  const c = loadConfig(one('--config')!);
  if(args.command==='start' && !supervised(c)) {
    invariant(!process.env.BRIDGE_SUPERVISOR_TOKEN,'SUPERVISOR_IDENTITY_MISMATCH');
    return supervise(c,path.resolve(one('--config')!),path.resolve(process.argv[1]!));
  }
  if (args.command === 'start' && c.transport === 'weixin') {
    const controller = new AbortController();
    const stop = () => controller.abort();
    process.once('SIGINT',stop); process.once('SIGTERM',stop);process.once('disconnect',stop);
    try { await runWeixin(c,process.stdout,controller.signal); return 0; }
    catch(e) { if (controller.signal.aborted) return 130; throw e; }
    finally { process.removeListener('SIGINT',stop); process.removeListener('SIGTERM',stop);process.removeListener('disconnect',stop); }
  }
  if (args.command === 'status' || args.command === 'result') {
    if (args.command === 'result') invariant(one('--task'), 'TASK_ID_INVALID');
    process.stdout.write(JSON.stringify(inspect(c, one('--task'))) + '\n'); return 0;
  }
  if (args.command === 'review') { process.stdout.write(JSON.stringify({reviewed:review(c, args.flags.has('--acknowledge-side-effects'))}) + '\n'); return 0; }
  let service: LocalService | undefined, signalSeen = false;
  const shutdown = () => {
    signalSeen = true;
    // Stop intake, then stop the actual Agent rather than merely returning from the caller.
    process.stdin.destroy();
    void service?.bridge.stop().catch(e => log('shutdown.failed', {code:errorCode(e)}));
  };
  process.once('SIGINT', shutdown); process.once('SIGTERM', shutdown);process.once('disconnect',shutdown);
  try {
    service = await openService(c, process.stdout);
    if (args.command === 'run') {
      invariant(!(one('--message') !== undefined && args.flags.has('--stdin')), 'CLI_PROMPT_CONFLICT');
      let text = one('--message') ?? '';
      if (args.flags.has('--stdin')) {
        const chunks: Buffer[] = []; let bytes = 0;
        for await (const chunk of process.stdin) {
          const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk); bytes += b.length;
          invariant(bytes <= 65536, 'INPUT_TEXT'); chunks.push(b);
        }
        text = new TextDecoder('utf-8', {fatal:true}).decode(Buffer.concat(chunks));
      }
      const accepted = await service.accept({id:one('--id') ?? randomUUID(), session:one('--session') ?? 'default', text,
        images:(args.options.get('--image') ?? []).map(file => path.resolve(file))});
      if (accepted.rejected || !accepted.taskId) return 1;
      await service.settle(); if (signalSeen) return 130;
      const job = service.store.get(accepted.taskId);
      const undelivered = !!service.store.db.prepare("SELECT 1 FROM outbox WHERE task_id=? AND state!='sent'").get(job.task_id);
      await service.channel.write({type:'status', taskId:job.task_id, status:job.status, duplicate:accepted.duplicate, errorCode:job.error_code, undelivered});
      return job.status === 'succeeded' && !undelivered ? 0 : ['failed','cancelled','timed_out'].includes(job.status) ? 1 : 2;
    }
    let batch: Record<string,unknown>[] = [];
    const framer = new JsonlFramer(c.local.maxInputBytes, value => batch.push(value));
    for await (const chunk of process.stdin) {
      framer.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      for (const frame of batch) { if (signalSeen) break; await service.accept(frame); }
      batch = []; if (signalSeen) break;
    }
    if (!signalSeen) { framer.end(); await service.settle(); }
    return signalSeen ? 130 : 0;
  } finally {
    process.removeListener('SIGINT', shutdown); process.removeListener('SIGTERM', shutdown);process.removeListener('disconnect',shutdown);
    await service?.stop();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  runCli().then(code => { process.exitCode = code; }).catch(e => { log('cli.failed', {code:errorCode(e)}); process.exitCode = 1; }).finally(()=>{if(process.connected)process.disconnect();});
}
