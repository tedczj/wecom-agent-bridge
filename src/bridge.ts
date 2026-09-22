import type { Config } from './config.ts';
import type { AgentBackend, Channel, Job, MediaProvider, NormalizedInput, SessionRef } from './types.ts';
import { Store } from './store.ts';
import { normalize } from './local.ts';
import { BackendStateUnknown, errorCode, invariant, log } from './errors.ts';
import { resultParts } from './reply.ts';
import { deadline } from './async.ts';
export class Bridge {
  private stopped = true;
  private worker?: Promise<void>;
  private wakeAgain = false;
  private active?: {id: string; controller: AbortController};
  private preparing = new Map<string, {controller: AbortController; promise: Promise<void>}>();
  constructor(private c: Config, private channelId: string, readonly store: Store, private channel: Channel, private backend: AgentBackend, private media: MediaProvider, private normalizer: typeof normalize = normalize) {}
  start(): void { this.store.recover(); this.stopped = false; this.kick(); }
  async accept(frame: unknown): Promise<{taskId?: string; duplicate?: boolean; rejected?: string}> {
    if (this.stopped) return { rejected: 'STOPPING' };
    let incoming;
    try { incoming = this.normalizer(frame, this.c, this.channelId); }
    catch (e) { const code = errorCode(e, 'INVALID_MESSAGE'); log('input.rejected', { code }); return { rejected: code }; }
    const control = incoming.text.startsWith('/');
    let reserved;
    try { reserved = this.store.reserve(incoming, control ? 'command' : 'agent'); }
    catch (e) { const code = errorCode(e); this.receipt(incoming.reqId, `未接收任务（${code}），请在本地检查。`); return { rejected: code }; }
    const { job, duplicate } = reserved;
    if (duplicate) return { taskId: job.task_id, duplicate: true };
    if (control) {
      this.store.atomic(() => {
        try { const answer = this.command(job, incoming.text); this.store.complete(job.task_id, 'succeeded', answer.text, undefined, ['queued'], answer.parts); }
        catch (e) { this.store.complete(job.task_id, 'failed', `命令未执行（${errorCode(e)}）。`, errorCode(e)); }
      });
      if (this.active && this.store.get(this.active.id).status === 'cancel_requested') this.active.controller.abort();
      for (const [id, p] of this.preparing) if (this.store.get(id).status === 'cancelled') p.controller.abort();
      this.kick();
    } else {
      this.receipt(incoming.reqId, `已接收 #${job.task_id.slice(0,8)}，正在准备输入并排队。`);
      const controller = new AbortController();
      const promise = Promise.resolve().then(async () => {
        try { const images = await this.media.prepare(job.task_id, incoming.media, controller.signal); if (!controller.signal.aborted) this.store.prepared(job.task_id, images); }
        catch (e) { this.store.complete(job.task_id, 'failed', `输入准备失败（${errorCode(e, 'MEDIA_FAILED')}），请重新提交图片/消息。`, errorCode(e, 'MEDIA_FAILED'), ['preparing']); }
        finally { this.preparing.delete(job.task_id); this.kick(); }
      });
      this.preparing.set(job.task_id, { controller, promise });
    }
    return { taskId: job.task_id, duplicate: false };
  }
  private receipt(reqId: string, text: string): void {
    void deadline(this.channel.receipt(reqId, text), this.c.reply.sendTimeoutMs, 'RECEIPT_TIMEOUT').catch(() => log('receipt.failed', { code: 'RECEIPT_UNKNOWN' }));
  }
  private command(owner: Job, text: string): {text: string; parts?: string[]} {
    const [cmd, ...args] = text.trim().split(/\s+/);
    if (cmd === '/help') { invariant(!args.length, 'COMMAND_ARGUMENTS'); return {text: `工作目录别名：${this.c.workspace.id}\n/help /status /new\n/cancel [taskId]\n/result taskId [part]\n取消和失败都可能已有部分修改。`}; }
    if (cmd === '/status') { invariant(!args.length, 'COMMAND_ARGUMENTS'); return {text: JSON.stringify(this.store.summary(owner), null, 2)}; }
    if (cmd === '/new') { invariant(!args.length, 'COMMAND_ARGUMENTS'); return {text: `已创建新会话 generation=${this.store.newGeneration(owner)}；历史结果保留。`}; }
    if (cmd === '/cancel') {
      invariant(args.length <= 1, 'COMMAND_ARGUMENTS');
      const target = args[0] ? this.store.owned(owner, args[0]) : this.store.activeFor(owner);
      invariant(target, 'TASK_NOT_FOUND');
      return {text: `#${target.task_id.slice(0,8)} 状态：${this.store.cancel(target.task_id)}。cancel_requested 尚未确认停止；请检查可能已发生的修改。`};
    }
    if (cmd === '/result') {
      invariant(args.length >= 1 && args.length <= 2 && (args[1] === undefined || /^[1-9]\d{0,5}$/.test(args[1])), 'COMMAND_ARGUMENTS');
      const target = this.store.owned(owner, args[0]!); invariant(target.result_text !== null, 'RESULT_NOT_READY');
      const answer = resultParts(target.task_id, target.result_text, this.c.reply.chunkBytes)[Number(args[1] ?? 1) - 1];
      invariant(answer, 'RESULT_PART_INVALID'); return {text: answer, parts: [answer]};
    }
    invariant(false, 'UNSUPPORTED_COMMAND');
  }
  private kick(): void {
    if (this.stopped) return;
    if (this.worker) { this.wakeAgain = true; return; }
    this.wakeAgain = false;
    this.worker = (async () => {
      for (;;) { if (this.stopped) return; const job = this.store.claim(); if (!job) return; await this.execute(job); }
    })().catch(() => { this.stopped = true; log('worker.stopped', {code:'WORKER_FAILURE'}); })
      .finally(() => { this.worker = undefined; if (this.wakeAgain && !this.stopped) this.kick(); });
  }
  private async execute(job: Job): Promise<void> {
    const controller = new AbortController(); this.active = {id: job.task_id, controller};
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; this.store.cancel(job.task_id); controller.abort(); }, this.c.agent.taskTimeoutMs);
    try {
      const input: NormalizedInput = JSON.parse(job.input_json), session = this.store.session(job.session_key);
      invariant(session.state !== 'tainted', 'SESSION_TAINTED'); await this.media.validate(input.images);
      const result = await this.backend.run(input, session.agent_ref_json ? JSON.parse(session.agent_ref_json) as SessionRef : undefined, {
        persistSession: async ref => this.store.persistSession(job.session_key, ref), progress: () => {},
      }, controller.signal);
      const status = result.outcome === 'interrupted' ? 'interrupted' : timedOut ? 'timed_out' : result.outcome === 'success' ? 'succeeded' : result.outcome === 'cancelled' ? 'cancelled' : 'failed';
      this.store.complete(job.task_id, status, timedOut && status !== 'interrupted' ? '任务超时，执行已停止；可能已有部分修改，请检查工作目录。' : result.finalText, timedOut ? 'TASK_TIMEOUT' : result.errorCode);
      log('task.finished', {taskId:job.task_id, state:this.store.get(job.task_id).status});
    } catch (e) {
      const unknown = e instanceof BackendStateUnknown;
      this.store.complete(job.task_id, unknown ? 'interrupted' : 'failed', unknown ? '无法确认执行已停止，工作目录已阻塞。请在本地检查进程与 git diff。' : `任务未完成（${errorCode(e)}），未自动重跑。`, errorCode(e));
    } finally { clearTimeout(timer); this.active = undefined; }
  }
  async idle(): Promise<void> {
    while (this.preparing.size || this.worker) { await Promise.all([...this.preparing.values()].map(p => p.promise)); if (this.worker) await this.worker; }
  }
  async stop(): Promise<void> {
    this.stopped = true;
    for (const p of this.preparing.values()) p.controller.abort();
    if (this.active) { this.store.cancel(this.active.id); this.active.controller.abort(); }
    const grace = this.c.agent.cancelGraceMs + this.c.agent.killGraceMs * 3 + 1000;
    try {
      await deadline(Promise.all([...this.preparing.values()].map(p => p.promise).concat(this.worker ? [this.worker] : [])), grace, 'SHUTDOWN_TIMEOUT');
      await deadline(this.backend.stop(), grace, 'SHUTDOWN_TIMEOUT');
    } catch (e) {
      if (this.active) this.store.complete(this.active.id, 'interrupted', '关闭时无法确认执行已停止，请在本地检查。', 'SHUTDOWN_UNKNOWN'); throw e;
    }
  }
}
