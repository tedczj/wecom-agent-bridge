import path from 'node:path';
import { existsSync, lstatSync, realpathSync, writeFileSync, unlinkSync } from 'node:fs';
import { createHash } from 'node:crypto';
import type { AgentBackend, AgentResult, NormalizedInput, RunHooks, SessionRef, ImageRef } from './types.ts';
import { type Config, agentEnvironment } from './config.ts';
import { RpcProcess } from './rpc-jsonl.ts';
import { BackendStateUnknown, BridgeError, errorCode, invariant, record } from './errors.ts';
import { inside, readControlled } from './fsutil.ts';
import { deadline, withSignal } from './async.ts';
/** Fresh process per turn; disk sessions persist. This deliberately prevents stale-epoch reuse. */
export class PiBackend implements AgentBackend {
    private rpc?: RpcProcess;
    private running = false;
    private stopping?: Promise<void>;
    lastHandshakeAt?: number;
    settledSeen = false;
    restoredSession = false;
    imageBytesSent = false;
    constructor(private c: Config, private imageReader?: (image: ImageRef) => Promise<Buffer>) { }
    async start(): Promise<void> {
        if (this.stopping)
            await this.stopping;
        if (this.rpc)
            return;
        const args = [...this.c.agent.args];
        // The adapter owns protocol/session flags; user args only select reviewed provider/profile.
        invariant(!args.some(x => ['--mode', '--session', '--session-dir', '--continue', '--no-session', '-c'].includes(x.split('=')[0]!)), 'PI_ARGS_CONFLICT');
        args.push('--mode', 'rpc', '--session-dir', this.c.agent.sessionRoot);
        const marker = path.join(this.c.stateRoot, 'agent-process.json');
        this.rpc = new RpcProcess({ command: this.c.agent.command, args, cwd: this.c.workspace.path, env: agentEnvironment(this.c),
            maxFrameBytes: this.c.agent.maxFrameBytes, timeoutMs: this.c.agent.startupTimeoutMs, killGraceMs: this.c.agent.killGraceMs,
            onSpawn: pid => writeFileSync(marker, JSON.stringify({ pid, startedAt: Date.now() }), { mode: 0o600 }),
            onStopped: () => { try {
                unlinkSync(marker);
            }
            catch (e) {
                if ((e as NodeJS.ErrnoException).code !== 'ENOENT')
                    throw e;
            } },
        });
        try {
            this.idle(record((await this.rpc.request('get_state')).data));
            this.lastHandshakeAt = Date.now();
        }
        catch (e) {
            await this.stop();
            throw e;
        }
    }
    private idle(state: Record<string, unknown>): void {
        invariant(state.model && state.isStreaming === false && state.isCompacting === false && state.pendingMessageCount === 0, 'PI_NOT_IDLE_OR_UNCONFIGURED');
    }
    private ref(state: Record<string, unknown>, history: boolean): Extract<SessionRef, {
        kind: 'pi';
    }> {
        invariant(typeof state.sessionId === 'string' && typeof state.sessionFile === 'string' && path.isAbsolute(state.sessionFile) && inside(this.c.agent.sessionRoot, state.sessionFile), 'PI_SESSION_PATH');
        return { kind: 'pi', sessionId: state.sessionId, sessionFile: state.sessionFile, hasHistory: history };
    }
    async stop(): Promise<void> {
        if (this.stopping)
            return this.stopping;
        const rpc = this.rpc;
        this.rpc = undefined;
        if (rpc) {
            this.stopping = rpc.stop();
            try {
                await this.stopping;
            }
            finally {
                this.stopping = undefined;
            }
        }
    }
    async run(input: NormalizedInput, saved: SessionRef | undefined, hooks: RunHooks, signal: AbortSignal): Promise<AgentResult> {
        invariant(!this.running, 'BACKEND_BUSY');
        this.running = true;
        let dispose = () => { };
        let promptSent = false;
        let ref: SessionRef | undefined;
        let finalText = '';
        let stopReason = '';
        let needsUi = false;
        let resolveSettled!: () => void;
        let rejectSettled!: (e: Error) => void;
        const settled = new Promise<void>((resolve, reject) => { resolveSettled = resolve; rejectSettled = reject; });
        // Avoid an unhandled rejection while setup/prompt response is still in flight.
        void settled.catch(() => { });
        let result: AgentResult;
        try {
            if (signal.aborted)
                throw new BridgeError('ABORTED');
            await withSignal(this.start(), signal);
            const rpc = this.rpc!;
            dispose = rpc.subscribe(event => {
                if (event.type === 'extension_ui_request') {
                    if (['select', 'confirm', 'input', 'editor'].includes(String(event.method))) {
                        needsUi = true;
                        void rpc.write({ type: 'extension_ui_response', id: event.id, cancelled: true }).catch(() => { });
                        rejectSettled(new BridgeError('NEEDS_LOCAL_INTERACTION'));
                    }
                }
                else if (event.type === 'message_end') {
                    const message = record(event.message);
                    if (message.role === 'assistant') {
                        const blocks = Array.isArray(message.content) ? message.content : [];
                        finalText = blocks.filter(x => x && x.type === 'text' && typeof x.text === 'string').map(x => x.text).join('\n');
                        stopReason = String(message.stopReason ?? '');
                    }
                }
                else if (event.type === 'agent_settled') {
                    this.settledSeen = true;
                    resolveSettled();
                }
                if (['agent_start', 'agent_end', 'agent_settled', 'tool_execution_start', 'tool_execution_end', 'auto_retry_start', 'auto_compaction_start'].includes(String(event.type)))
                    hooks.progress({ type: String(event.type) });
            }, rejectSettled);
            let existing = saved;
            if (existing) {
                invariant(existing.kind === 'pi', 'SESSION_BACKEND_MISMATCH');
                invariant(inside(this.c.agent.sessionRoot, existing.sessionFile), 'PI_SESSION_PATH');
                if (!existsSync(existing.sessionFile)) {
                    invariant(existing.hasHistory === false, 'SESSION_MISSING');
                    existing = undefined;
                }
                else
                    invariant(realpathSync(existing.sessionFile) === path.resolve(existing.sessionFile) && lstatSync(existing.sessionFile).isFile(), 'PI_SESSION_PATH');
            }
            const changed = existing && existing.kind === 'pi'
                ? await withSignal(rpc.request('switch_session', { sessionPath: existing.sessionFile }), signal) : await withSignal(rpc.request('new_session'), signal);
            invariant(record(changed.data).cancelled === false, 'SESSION_SWITCH_CANCELLED');
            const state = record((await withSignal(rpc.request('get_state'), signal)).data);
            this.idle(state);
            ref = this.ref(state, !!existing && existing.kind === 'pi' && existing.hasHistory !== false);
            if (existing && existing.kind === 'pi')
                invariant(ref.sessionFile === existing.sessionFile && ref.sessionId === existing.sessionId, 'SESSION_RESTORE_MISMATCH');
            await hooks.persistSession(ref).catch(() => { throw new BridgeError(promptSent ? 'SESSION_PERSISTENCE_AFTER_PROMPT' : 'SESSION_PERSISTENCE'); });
            if (existing)
                this.restoredSession = true;
            const images = [];
            if (input.images.length)
                invariant(Array.isArray(record(state.model).input) && (record(state.model).input as unknown[]).includes('image'), 'PI_MODEL_NO_IMAGES');
            for (const img of input.images) {
                const bytes = this.imageReader ? await this.imageReader(img) : await readControlled(path.join(this.c.stateRoot, 'media'), img.localPath, this.c.media.maxImageBytes);
                invariant(bytes.length === img.bytes && createHash('sha256').update(bytes).digest('hex') === img.sha256, 'MEDIA_HASH');
                images.push({ type: 'image', mimeType: img.mimeType, data: bytes.toString('base64') });
            }
            if (needsUi)
                throw new BridgeError('NEEDS_LOCAL_INTERACTION');
            if (signal.aborted)
                throw new BridgeError('ABORTED');
            // Collector is installed before this write; prompt ACK is not completion.
            promptSent = true;
            await withSignal(rpc.request('prompt', { message: input.text, images }), signal);
            if (images.length)
                this.imageBytesSent = true;
            ref = { ...ref, hasHistory: true };
            await hooks.persistSession(ref).catch(() => { throw new BridgeError(promptSent ? 'SESSION_PERSISTENCE_AFTER_PROMPT' : 'SESSION_PERSISTENCE'); });
            await withSignal(settled, signal);
            this.idle(record((await withSignal(rpc.request('get_state'), signal)).data));
            if (needsUi)
                throw new BridgeError('NEEDS_LOCAL_INTERACTION');
            if (stopReason === 'error')
                result = { outcome: 'failed', finalText: finalText || '模型执行失败；可能已有部分修改。', errorCode: 'PI_MODEL_ERROR', sessionRef: ref };
            else if (stopReason === 'aborted')
                result = { outcome: 'cancelled', finalText: '任务已取消；请检查可能已发生的修改。', sessionRef: ref };
            else if (!finalText || stopReason === 'toolUse')
                result = { outcome: 'failed', finalText: 'Agent 未返回最终文本；请检查工作目录。', errorCode: 'EMPTY_FINAL', sessionRef: ref };
            else
                result = { outcome: 'success', finalText, sessionRef: ref };
        }
        catch (e) {
            if (signal.aborted && this.rpc) {
                await deadline(Promise.all([this.rpc.request('abort'), settled]), this.c.agent.cancelGraceMs, 'CANCEL_GRACE_EXPIRED').catch(() => { });
            }
            const code = needsUi ? 'NEEDS_LOCAL_INTERACTION' : errorCode(e, 'BACKEND_ERROR');
            const interrupted = promptSent && !signal.aborted && !needsUi && /^RPC_|^PI_NOT_IDLE|^SESSION_PERSISTENCE_AFTER_PROMPT$/.test(code) && code !== 'RPC_REJECTED';
            result = { outcome: signal.aborted ? 'cancelled' : interrupted ? 'interrupted' : 'failed', finalText: signal.aborted ? '任务已取消；可能已发生部分修改，请检查工作目录。' : `执行未完成（${code}）；请在本地检查，未自动重跑。`, errorCode: code, sessionRef: ref };
        }
        finally {
            dispose();
            try {
                await this.stop();
            }
            catch {
                this.running = false;
                throw new BackendStateUnknown();
            }
            this.running = false;
        }
        return result!;
    }
}
