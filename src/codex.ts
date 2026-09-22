import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { constants, existsSync, writeFileSync, unlinkSync } from 'node:fs';
import { access } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { type Config, agentEnvironment } from './config.ts';
import { BackendStateUnknown, BridgeError, errorCode, invariant, record } from './errors.ts';
import { JsonlFramer } from './rpc-jsonl.ts';
import { readControlled } from './fsutil.ts';
import { deadline, withSignal } from './async.ts';
import type { AgentBackend, AgentResult, ImageRef, NormalizedInput, RunHooks, SessionRef } from './types.ts';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** CLI contract: options precede resume; image options follow the explicit thread ID. */
export function codexArgs(c: Config, images: ImageRef[], saved?: SessionRef): string[] {
  invariant(c.agent.args.length === 0, 'CODEX_ARGS_NOT_ALLOWED');
  invariant(c.codex.sandbox === 'read-only' || c.codex.sandbox === 'workspace-write', 'UNSAFE_SANDBOX');
  if (saved) invariant(saved.kind === 'codex' && uuid.test(saved.threadId), 'SESSION_BACKEND_MISMATCH');
  const args = ['exec', '--json', '--sandbox', c.codex.sandbox, '--cd', c.workspace.path,
    '--config', 'approval_policy="never"', '--config', `sandbox_workspace_write.network_access=${c.codex.networkAccess}`,
    '--config', 'web_search="disabled"'];
  if (c.codex.model) args.push('--model', c.codex.model);
  if (c.codex.reasoning) args.push('--config', `model_reasoning_effort="${c.codex.reasoning}"`);
  if (saved?.kind === 'codex') args.push('resume', saved.threadId);
  for (const image of images) args.push('--image', image.localPath);
  args.push('-'); // Prompt through stdin, never through a shell or the process argument list.
  return args;
}
function groupAlive(pid: number | undefined): boolean {
  if (!pid) return false;
  try { process.kill(-pid, 0); return true; }
  catch (e) { return (e as NodeJS.ErrnoException).code !== 'ESRCH'; }
}
async function terminateGroup(child: ChildProcessWithoutNullStreams, graceMs: number): Promise<void> {
  const pid = child.pid;
  const signal = async (s: NodeJS.Signals) => {
    if (!pid) return;
    try { process.kill(-pid, s); }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ESRCH') return;
      // A process group can become unsignalable while its exiting child is
      // being reaped. Accept cleanup only after the group actually disappears.
      if ((e as NodeJS.ErrnoException).code === 'EPERM') {
        await wait();
        if (!groupAlive(pid)) return;
      }
      throw new BackendStateUnknown();
    }
  };
  const wait = async () => { const until = Date.now() + graceMs; while (groupAlive(pid) && Date.now() < until) await sleep(10); };
  if (groupAlive(pid)) { await signal('SIGTERM'); await wait(); }
  if (groupAlive(pid)) { await signal('SIGKILL'); await wait(); }
  if (groupAlive(pid)) throw new BackendStateUnknown();
}
/** Uses the installed official Codex CLI; no SDK shim, mock backend or model is shipped as production code. */
export class CodexBackend implements AgentBackend {
  private running = false;
  private active?: { controller: AbortController; done: Promise<void> };
  constructor(private c: Config, private imageReader?: (image: ImageRef) => Promise<Buffer>) {}
  async start(): Promise<void> {
    invariant(process.platform !== 'win32', 'PLATFORM_UNSUPPORTED');
    invariant(this.c.backend === 'codex', 'SESSION_BACKEND_MISMATCH');
    invariant(this.c.agent.isolation === 'native' || this.c.agent.isolation === 'external', 'WORKSPACE_ISOLATION_UNVERIFIED');
    try { await access(this.c.agent.command, constants.X_OK); }
    catch { throw new BridgeError('CODEX_EXECUTABLE_MISSING'); }
  }
  async stop(): Promise<void> {
    const active = this.active;
    if (active) { active.controller.abort(); await active.done; }
  }
  async run(input: NormalizedInput, saved: SessionRef | undefined, hooks: RunHooks, signal: AbortSignal): Promise<AgentResult> {
    invariant(!this.running, 'BACKEND_BUSY'); this.running = true;
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    let resolveDone!: () => void;
    const done = new Promise<void>(resolve => { resolveDone = resolve; });
    this.active = { controller, done };
    let child: ChildProcessWithoutNullStreams | undefined;
    let close: Promise<{ code: number | null; signal: NodeJS.Signals | null }> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined, startup: ReturnType<typeof setTimeout> | undefined;
    let timeoutCode = '', promptSent = false, ownsMarker = false, spawnError = false, stdinError = false;
    let threadSeen = false, turnStarted = false, completed = false, failed = false, fatal = false;
    let finalText = '', ref: SessionRef | undefined = saved;
    let result: AgentResult;
    const marker = path.join(this.c.stateRoot, 'agent-process.json');
    try {
      if (controller.signal.aborted) throw new BridgeError('ABORTED');
      await this.start();
      const args = codexArgs(this.c, input.images, saved);
      for (const image of input.images) {
        // A persisted path alone is never sufficient: validate bytes again immediately before exec.
        const bytes = this.imageReader ? await this.imageReader(image) : await readControlled(path.join(this.c.stateRoot, 'media'), image.localPath, this.c.media.maxImageBytes);
        invariant(bytes.length === image.bytes && createHash('sha256').update(bytes).digest('hex') === image.sha256, 'MEDIA_HASH');
        invariant(!image.localPath.includes(','), 'MEDIA_PATH'); // Codex parses comma-separated --image values.
      }
      if (controller.signal.aborted) throw new BridgeError('ABORTED');
      invariant(!existsSync(marker), 'AGENT_PROCESS_REVIEW_REQUIRED');
      child = spawn(this.c.agent.command, args, { cwd: this.c.workspace.path, env: agentEnvironment(this.c), shell: false, detached: true, stdio: 'pipe' });
      close = new Promise(resolve => { child!.once('close', (code, s) => resolve({ code, signal: s })); });
      child.once('error', () => { spawnError = true; controller.abort(); });
      child.stdin.on('error', () => { stdinError = true; controller.abort(); });
      child.stderr.resume(); // Drain without retaining credentials, prompt text, or raw errors.
      if (child.pid) {
        writeFileSync(marker, JSON.stringify({ pid: child.pid, backend: 'codex', startedAt: Date.now() }), { flag: 'wx', mode: 0o600 });
        ownsMarker = true;
      }
      timer = setTimeout(() => { timeoutCode = 'CODEX_TASK_TIMEOUT'; controller.abort(); }, this.c.agent.taskTimeoutMs);
      startup = setTimeout(() => { timeoutCode = 'CODEX_START_TIMEOUT'; controller.abort(); }, this.c.agent.startupTimeoutMs);
      const collect = async () => {
        let totalBytes = 0;
        let batch: Record<string, unknown>[] = [];
        const framer = new JsonlFramer(this.c.agent.maxFrameBytes, event => batch.push(event));
        for await (const chunk of child!.stdout) {
          totalBytes += (chunk as Buffer).length;
          invariant(totalBytes <= this.c.agent.maxStreamBytes, 'CODEX_STREAM_TOO_LARGE');
          framer.push(chunk as Buffer);
          for (const event of batch) {
            invariant(typeof event.type === 'string', 'CODEX_PROTOCOL');
            if (event.type === 'thread.started') {
              invariant(!threadSeen && !turnStarted && typeof event.thread_id === 'string' && uuid.test(event.thread_id), 'CODEX_THREAD_ID');
              if (saved?.kind === 'codex') invariant(saved.threadId === event.thread_id, 'SESSION_RESTORE_MISMATCH');
              ref = { kind: 'codex', threadId: event.thread_id }; threadSeen = true;
              clearTimeout(startup);
              // Persist sequentially. A persistence failure after stdin was sent is uncertain work.
              try { await hooks.persistSession(ref); } catch { throw new BridgeError('SESSION_PERSISTENCE_AFTER_PROMPT'); }
            } else if (event.type === 'turn.started') {
              invariant(threadSeen && !turnStarted && !completed && !failed, 'CODEX_EVENT_ORDER'); turnStarted = true;
            } else if (event.type === 'item.completed') {
              invariant(threadSeen && turnStarted && !completed && !failed, 'CODEX_EVENT_ORDER');
              const item = record(event.item);
              if (item.type === 'agent_message') {
                invariant(typeof item.text === 'string', 'CODEX_PROTOCOL');
                // Some CLI versions expose phase; never surface an explicitly non-final phase.
                if (item.phase === undefined || item.phase === null || item.phase === 'final_answer') finalText = item.text;
              }
            } else if (event.type === 'turn.completed') {
              invariant(threadSeen && turnStarted && !completed && !failed && !fatal, 'CODEX_EVENT_ORDER'); completed = true;
            } else if (event.type === 'turn.failed') {
              invariant(!completed && !failed, 'CODEX_EVENT_ORDER'); failed = true;
            } else if (event.type === 'error') {
              fatal = true;
            }
            if (['thread.started', 'turn.started', 'turn.completed', 'turn.failed'].includes(event.type)) hooks.progress({ type: event.type });
          }
          batch = [];
        }
        framer.end();
      };
      const collecting = collect();
      void collecting.catch(() => {});
      promptSent = true;
      child.stdin.end(input.text);
      await withSignal(collecting, controller.signal);
      const exit = await withSignal(close, controller.signal);
      if (spawnError) throw new BridgeError('CODEX_PROCESS_ERROR');
      if (stdinError) throw new BridgeError('CODEX_STDIN_ERROR');
      if (failed || (fatal && !turnStarted)) {
        result = { outcome: 'failed', errorCode: 'CODEX_TURN_FAILED', finalText: 'Codex 执行失败；可能已有部分修改，请在本地检查。', sessionRef: ref };
      } else {
        invariant(completed && !fatal && exit.code === 0 && exit.signal === null, 'CODEX_INCOMPLETE_TURN');
        // An owned process group surviving CLI exit is not a completed cleanup.
        invariant(!groupAlive(child.pid), 'CODEX_CHILDREN_STILL_RUNNING');
        result = finalText.trim() ? { outcome: 'success', finalText, sessionRef: ref }
          : { outcome: 'failed', finalText: 'Codex 未返回最终文本；请检查工作目录。', errorCode: 'EMPTY_FINAL', sessionRef: ref };
      }
    } catch (e) {
      const code = spawnError ? 'CODEX_PROCESS_ERROR' : stdinError ? 'CODEX_STDIN_ERROR' : timeoutCode || errorCode(e, 'CODEX_BACKEND_ERROR');
      const uncertain = promptSent && !spawnError;
      result = { outcome: uncertain ? 'interrupted' : controller.signal.aborted && !spawnError ? 'cancelled' : 'failed',
        errorCode: code, sessionRef: ref,
        finalText: uncertain ? `Codex 执行中断（${code}），可能已有修改；工作目录已阻塞，请检查进程和 git diff，未自动重跑。`
          : `Codex 未执行（${code}）。` };
    } finally {
      clearTimeout(timer); clearTimeout(startup); signal.removeEventListener('abort', abort);
      try {
        if (child) {
          await terminateGroup(child, this.c.agent.killGraceMs);
          child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
          if (close) await deadline(close, this.c.agent.killGraceMs, 'CODEX_CLOSE_TIMEOUT');
        }
        if (ownsMarker) unlinkSync(marker);
      } catch {
        // Keep marker for explicit operator recovery. Never silently unlock uncertain execution.
        result = { outcome: 'interrupted', finalText: '无法确认 Codex 已停止；工作目录已阻塞，请在本地检查。', errorCode: 'BACKEND_STATE_UNKNOWN', sessionRef: ref };
      } finally { this.active = undefined; this.running = false; resolveDone(); }
    }
    return result!;
  }
}
