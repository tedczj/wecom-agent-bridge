import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { BackendStateUnknown, BridgeError, invariant, record } from './errors.ts';
export class JsonlFramer {
    private chunks: Buffer[] = [];
    private size = 0;
    constructor(private maxBytes: number, private emit: (value: Record<string, unknown>) => void) { }
    push(chunk: Buffer): void {
        let start = 0;
        while (start < chunk.length) {
            const lf = chunk.indexOf(10, start);
            const end = lf < 0 ? chunk.length : lf;
            this.size += end - start;
            invariant(this.size <= this.maxBytes, 'RPC_FRAME_TOO_LARGE');
            this.chunks.push(chunk.subarray(start, end));
            if (lf < 0)
                break;
            const bytes = Buffer.concat(this.chunks, this.size);
            this.chunks = [];
            this.size = 0;
            if (bytes.length) {
                try {
                    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
                    if (text.trim())
                        this.emit(record(JSON.parse(text)));
                }
                catch (e) {
                    if (e instanceof BridgeError)
                        throw e;
                    throw new BridgeError('RPC_INVALID_JSON');
                }
            }
            start = lf + 1;
        }
    }
    end(): void { invariant(this.size === 0, 'RPC_TRUNCATED_FRAME'); }
}
export interface RpcOptions {
    command: string;
    args: string[];
    cwd: string;
    env: NodeJS.ProcessEnv;
    maxFrameBytes: number;
    timeoutMs: number;
    killGraceMs: number;
    onSpawn?: (pid: number) => void;
    onStopped?: () => void;
}
interface Pending {
    command: string;
    resolve: (v: Record<string, unknown>) => void;
    reject: (e: Error) => void;
    timer: ReturnType<typeof setTimeout>;
}
export class RpcProcess {
    readonly epoch = randomUUID();
    private child: ChildProcessWithoutNullStreams;
    private pending = new Map<string, Pending>();
    private listeners = new Set<(event: Record<string, unknown>) => void>();
    private errors = new Set<(error: BridgeError) => void>();
    private failure?: BridgeError;
    private stopping = false;
    constructor(private options: RpcOptions) {
        invariant(process.platform !== 'win32', 'PLATFORM_UNSUPPORTED');
        this.child = spawn(options.command, options.args, { cwd: options.cwd, env: options.env, shell: false, detached: true, stdio: 'pipe' });
        const framer = new JsonlFramer(options.maxFrameBytes, value => this.receive(value));
        this.child.stdout.on('data', (chunk: Buffer) => { if (this.stopping)
            return; try {
            framer.push(chunk);
        }
        catch (e) {
            this.fail(e instanceof BridgeError ? e : new BridgeError('RPC_PROTOCOL'));
        } });
        this.child.stdout.on('end', () => { if (!this.stopping) {
            try {
                framer.end();
            }
            catch {
                this.fail(new BridgeError('RPC_TRUNCATED_FRAME'));
            }
        } });
        // Drain but never store/forward stderr: it can contain credentials or user content.
        this.child.stderr.resume();
        this.child.on('error', () => this.fail(new BridgeError('RPC_PROCESS_ERROR')));
        this.child.stdin.on('error', () => this.fail(new BridgeError('RPC_STDIN_ERROR')));
        this.child.on('exit', () => { if (!this.stopping)
            this.fail(new BridgeError('RPC_EXIT')); });
        if (this.child.pid) {
            try {
                options.onSpawn?.(this.child.pid);
            }
            catch {
                this.fail(new BridgeError('PROCESS_RECORD_FAILED'));
            }
        }
    }
    private fail(error: BridgeError): void {
        if (this.failure)
            return;
        this.failure = error;
        for (const p of this.pending.values()) {
            clearTimeout(p.timer);
            p.reject(error);
        }
        this.pending.clear();
        for (const fn of this.errors)
            fn(error);
    }
    subscribe(onEvent: (e: Record<string, unknown>) => void, onError: (e: BridgeError) => void): () => void {
        this.listeners.add(onEvent);
        this.errors.add(onError);
        if (this.failure)
            queueMicrotask(() => { if (this.errors.has(onError))
                onError(this.failure!); });
        return () => { this.listeners.delete(onEvent); this.errors.delete(onError); };
    }
    private receive(frame: Record<string, unknown>): void {
        if (this.failure || this.stopping)
            return;
        invariant(typeof frame.type === 'string', 'RPC_PROTOCOL');
        if (frame.type === 'response') {
            invariant(typeof frame.id === 'string', 'RPC_RESPONSE_ID');
            const p = this.pending.get(frame.id);
            if (!p)
                return;
            invariant(frame.command === p.command, 'RPC_RESPONSE_COMMAND');
            clearTimeout(p.timer);
            this.pending.delete(frame.id);
            if (frame.success === true)
                p.resolve(frame);
            else if (frame.success === false)
                p.reject(new BridgeError('RPC_REJECTED'));
            else {
                p.reject(new BridgeError('RPC_PROTOCOL'));
                throw new BridgeError('RPC_PROTOCOL');
            }
        }
        else
            for (const fn of this.listeners)
                fn(frame);
    }
    write(frame: Record<string, unknown>): Promise<void> {
        if (this.failure)
            return Promise.reject(this.failure);
        if (this.stopping)
            return Promise.reject(new BridgeError('RPC_STOPPED'));
        return new Promise((resolve, reject) => {
            this.child.stdin.write(JSON.stringify(frame) + '\n', error => {
                if (error) {
                    const e = new BridgeError('RPC_STDIN_ERROR');
                    this.fail(e);
                    reject(e);
                }
                else
                    resolve();
            });
        });
    }
    request(command: string, fields: Record<string, unknown> = {}, timeoutMs = this.options.timeoutMs): Promise<Record<string, unknown>> {
        if (this.failure)
            return Promise.reject(this.failure);
        const id = this.epoch + ':' + randomUUID();
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => this.fail(new BridgeError('RPC_TIMEOUT')), timeoutMs);
            this.pending.set(id, { command, resolve, reject, timer });
            void this.write({ ...fields, id, type: command }).catch(() => this.fail(new BridgeError('RPC_WRITE_FAILED')));
        });
    }
    async stop(): Promise<void> {
        if (this.stopping)
            return;
        this.stopping = true;
        this.fail(new BridgeError('RPC_STOPPED'));
        const pid = this.child.pid;
        const alive = () => { if (!pid)
            return false; try {
            process.kill(-pid, 0);
            return true;
        }
        catch (e) {
            return (e as NodeJS.ErrnoException).code !== 'ESRCH';
        } };
        const signal = (s: NodeJS.Signals) => { if (pid)
            try {
                process.kill(-pid, s);
            }
            catch (e) {
                if ((e as NodeJS.ErrnoException).code !== 'ESRCH')
                    throw new BackendStateUnknown();
            } };
        const wait = async () => { const end = Date.now() + this.options.killGraceMs; while (alive() && Date.now() < end)
            await sleep(10); };
        signal('SIGTERM');
        await wait();
        if (alive()) {
            signal('SIGKILL');
            await wait();
        }
        if (alive())
            throw new BackendStateUnknown();
        this.options.onStopped?.();
    }
}
