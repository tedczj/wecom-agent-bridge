import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { BridgeError, BackendStateUnknown, invariant, record, errorCode } from '../errors.ts';
import { JsonlFramer, type RpcOptions } from '../rpc-jsonl.ts';

type Frame = Record<string, unknown>;
type Pending = { resolve: (value: Frame) => void; reject: (error: Error) => void; timer: NodeJS.Timeout };

/** App-server JSON-RPC is different from Pi's command/response JSONL protocol. */
export class ControllerProtocol {
  private child: ChildProcessWithoutNullStreams;
  private pending = new Map<string, Pending>();
  private listeners = new Set<(method: string, params: Frame) => void>();
  private errors = new Set<(error: BridgeError) => void>();
  private failure?: BridgeError;
  private closing?: Promise<void>;
  onRequest?: (method: string, params: Frame) => Promise<unknown>;

  constructor(private options: RpcOptions) {
    invariant(process.platform !== 'win32', 'PLATFORM_UNSUPPORTED');
    this.child = spawn(options.command, options.args, { cwd: options.cwd, env: options.env, shell: false, detached: true, stdio: 'pipe' });
    const framer = new JsonlFramer(options.maxFrameBytes, frame => this.receive(frame));
    this.child.stdout.on('data', (chunk: Buffer) => {
      if (this.failure) return;
      try { framer.push(chunk); } catch { this.fail(new BridgeError('CONTROLLER_PROTOCOL')); }
    });
    this.child.stdout.on('end', () => {
      if (this.closing) return;
      try { framer.end(); } catch { this.fail(new BridgeError('CONTROLLER_TRUNCATED_FRAME')); }
    });
    this.child.stderr.resume(); // Never publish raw runtime diagnostics or credentials.
    this.child.once('error', () => this.fail(new BridgeError('CONTROLLER_PROCESS_ERROR')));
    this.child.stdin.on('error', () => this.fail(new BridgeError('CONTROLLER_STDIN_ERROR')));
    this.child.once('exit', () => this.fail(new BridgeError('CONTROLLER_EXIT')));
    if (this.child.pid) try { options.onSpawn?.(this.child.pid); } catch { this.fail(new BridgeError('CONTROLLER_PROCESS_RECORD_FAILED')); }
  }

  private fail(error: BridgeError): void {
    if (this.failure) return;
    this.failure = error;
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(error); }
    this.pending.clear();
    for (const fn of this.errors) fn(error);
  }

  subscribe(event: (method: string, params: Frame) => void, error: (error: BridgeError) => void): () => void {
    this.listeners.add(event); this.errors.add(error);
    if (this.failure) queueMicrotask(() => { if (this.errors.has(error)) error(this.failure!); });
    return () => { this.listeners.delete(event); this.errors.delete(error); };
  }

  private receive(frame: Frame): void {
    if (typeof frame.method === 'string') {
      const params = record(frame.params ?? {});
      if (frame.id !== undefined) {
        invariant(typeof frame.id === 'string' || typeof frame.id === 'number', 'CONTROLLER_REQUEST_ID');
        const id = frame.id;
        // Unknown requests are rejected; there is no approval or shell fallback.
        void Promise.resolve().then(() => {
          invariant(this.onRequest, 'CONTROLLER_TOOL_DENIED');
          return this.onRequest(frame.method as string, params);
        }).then(result => this.write({ id, result }), error => {
          const code = errorCode(error, 'CONTROLLER_TOOL_DENIED');
          return this.write({ id, error: { code: code === 'CONTROLLER_TOOL_ARGUMENTS' ? -32602 : code === 'CONTROLLER_TOOL_DENIED' ? -32601 : -32000, message: code } });
        })
          .catch(() => this.fail(new BridgeError('CONTROLLER_WRITE_FAILED')));
      } else for (const fn of this.listeners) fn(frame.method, params);
      return;
    }
    invariant(typeof frame.id === 'string', 'CONTROLLER_RESPONSE_ID');
    const pending = this.pending.get(frame.id);
    if (!pending) return; // Late response to an expired request cannot authorize an effect.
    this.pending.delete(frame.id); clearTimeout(pending.timer);
    if (frame.error !== undefined) {
      const error = new BridgeError('CONTROLLER_REJECTED');
      error.cause = frame.error; // Private diagnostic only; errorCode never publishes it.
      pending.reject(error);
    }
    else {
      try { pending.resolve(record(frame.result)); }
      catch { pending.reject(new BridgeError('CONTROLLER_RESPONSE')); }
    }
  }

  private write(frame: Frame): Promise<void> {
    if (this.failure) return Promise.reject(this.failure);
    return new Promise((resolve, reject) => this.child.stdin.write(JSON.stringify(frame) + '\n', error => {
      if (error) reject(new BridgeError('CONTROLLER_WRITE_FAILED')); else resolve();
    }));
  }

  notify(method: string, params: Frame = {}): Promise<void> { return this.write({ method, params }); }

  request(method: string, params: Frame = {}): Promise<Frame> {
    if (this.failure) return Promise.reject(this.failure);
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.fail(new BridgeError('CONTROLLER_RPC_TIMEOUT')), this.options.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      void this.write({ id, method, params }).catch(() => this.fail(new BridgeError('CONTROLLER_WRITE_FAILED')));
    });
  }

  close(): Promise<void> { return this.closing ??= this.stop(); }
  private async stop(): Promise<void> {
    this.fail(new BridgeError('CONTROLLER_CLOSED'));
    const pid = this.child.pid;
    const alive = () => {
      if (!pid) return false;
      try { process.kill(-pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code !== 'ESRCH'; }
    };
    const signal = (sig: NodeJS.Signals) => {
      if (pid) try { process.kill(-pid, sig); } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ESRCH') throw new BackendStateUnknown();
      }
    };
    const wait = async () => { const end = Date.now() + this.options.killGraceMs; while (alive() && Date.now() < end) await sleep(10); };
    signal('SIGTERM'); await wait();
    if (alive()) { signal('SIGKILL'); await wait(); }
    if (alive()) throw new BackendStateUnknown();
    this.options.onStopped?.();
  }
}
