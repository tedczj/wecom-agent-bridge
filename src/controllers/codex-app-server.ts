import { invariant, record, BridgeError } from '../errors.ts';
import { ControllerProtocol } from './protocol.ts';
import { completedUsage } from './rotation.ts';
import type { ControllerRef, ControllerRuntime, ControllerTool, ControllerToolHandler, ControllerTurn, ContextUsageSnapshot, ControllerRequestIdentity } from './runtime.ts';
import type { RpcOptions } from '../rpc-jsonl.ts';
import { createHash } from 'node:crypto';
import { lstatSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { readControlled } from '../fsutil.ts';
import type { ImageRef } from '../types.ts';
import { controllerPolicyEvidence, controllerPolicyPrefix, type ControllerPolicyEvidence, type ControllerPolicyAudit } from './policy.ts';

export interface AppServerOptions extends Omit<RpcOptions, 'args'> {
  model: string;
  reasoning: string;
  contextWindowTokens: number;
  turnTimeoutMs: number;
  maxToolCalls?: number;
  requireRestrictedPolicy?: boolean;
  media?: { root: string; maxImages: number; maxImageBytes: number; maxTotalBytes: number };
  promptAudit?: (event: { threadId: string; requestId?: string; sourceRequestId?: string; textSha256: string; attachmentHashes: string[] }) => void;
  toolResultAudit?: (event: { threadId: string; turnId: string; requestId?: string; callId: string; tool: string; resultSha256: string }) => void;
  policyAudit?: (event: ControllerPolicyAudit) => void;
  onCleanupUnknown?: () => void;
}

// These are configuration requests, not proof of the effective model tool surface.
// Production enablement additionally requires a matching successful capability probe.
export const controllerPolicy: Record<string, unknown> = {
  'features.bridge_controller_only': true,
  'features.shell_tool': false, 'features.unified_exec': false, 'features.view_image': false,
  'features.multi_agent': false, 'features.multi_agent_v2': false, 'features.apps': false,
  'agents.enabled': false,
  'features.plugins': false, 'features.code_mode': false, 'features.js_repl': false,
  'features.browser_use': false, 'features.computer_use': false, 'features.image_generation': false,
  'features.memories': false, 'features.memory_tool': false, 'features.goals': false,
  'features.token_budget': false, 'features.context_management': false,
  'features.hooks': false, 'features.codex_hooks': false, 'features.plugin_hooks': false,
  'features.tool_suggest': false, 'features.skill_search': false, 'features.skip_host_skill_discovery': true,
  'features.sleep_tool': false, 'features.current_time_reminder': false,
  'features.unbounded_connection_retries': false,
  'features.tool_registry': { turn_metadata_includes_tool_info: true },
  'tools.update_plan.enabled': false,
  'project_doc_max_bytes': 0, 'skills.include_instructions': false, 'skills.bundled.enabled': false,
  'web_search': 'disabled', 'include_environment_context': false,
  'include_apps_instructions': false, 'include_collaboration_mode_instructions': false,
};

type ActiveTurn = {
  ref: ControllerRef; turnId?: string; toolCalls: number; pendingTools: number;
  handler: ControllerToolHandler; resolve: (turn: ControllerTurn) => void; reject: (error: Error) => void;
  text: string; usage?: Record<string, unknown>;
  childWaits: number; pauseDeadline: () => void; resumeDeadline: () => void;
  policyObserved: boolean;
  failed: boolean;
  requestId?: string;
  delegatedResult: boolean;
};

export class CodexAppServer implements ControllerRuntime {
  readonly protocol: ControllerProtocol;
  private initialized?: Promise<void>;
  private threadTools = new Map<string, ControllerTool[]>();
  private usages = new Map<string, ContextUsageSnapshot>();
  private active?: ActiveTurn;
  private policy: Record<string, unknown> = {};
  readonly observations: Record<string, unknown>[] = [];
  readonly createdRefs: ControllerRef[] = [];
  readonly policyObservations: ControllerPolicyEvidence[] = [];

  constructor(private options: AppServerOptions) {
    const args = ['app-server', '--stdio', ...Object.entries(controllerPolicy).flatMap(([key, value]) =>
      ['-c', `${key}=${typeof value === 'object' ? '{ turn_metadata_includes_tool_info = true }' : JSON.stringify(value)}`])];
    this.protocol = new ControllerProtocol({ ...options, args });
    this.protocol.onRequest = async (method, params) => {
      const active = this.active;
      invariant(method === 'item/tool/call' && active && params.threadId === active.ref.threadId &&
        typeof params.turnId === 'string' && (!active.turnId || params.turnId === active.turnId), 'CONTROLLER_TOOL_DENIED');
      invariant(!active.failed, 'CONTROLLER_STALE_TURN');
      invariant(!this.options.requireRestrictedPolicy || active.policyObserved, 'CONTROLLER_POLICY_MISSING');
      active.turnId ??= params.turnId;
      invariant(typeof params.tool === 'string' && typeof params.callId === 'string' &&
        this.threadTools.get(active.ref.threadId)?.some(tool => tool.name === params.tool) &&
        ++active.toolCalls <= (this.options.maxToolCalls ?? 12), 'CONTROLLER_TOOL_DENIED');
      active.pendingTools++;
      const passive = params.tool === 'route_delegate' || params.tool === 'business_execute';
      if (passive && active.childWaits++ === 0) active.pauseDeadline();
      try {
        const result = await active.handler(params.tool, record(params.arguments), params.callId);
        invariant(this.active === active, 'CONTROLLER_STALE_TURN');
        if (passive && active.requestId && result !== null && typeof result === 'object' && !Array.isArray(result)) {
          const envelope = record(result);
          active.delegatedResult ||= envelope.requestId === active.requestId && typeof envelope.shortText === 'string' &&
            ['completed', 'failed', 'cancelled', 'interrupted'].includes(String(envelope.status)) &&
            (envelope.status !== 'completed' || typeof envelope.answerRef === 'string' && envelope.answerRef.length > 0);
        }
        const text = JSON.stringify(result);
        this.options.toolResultAudit?.({ threadId: active.ref.threadId, turnId: active.turnId!, requestId: active.requestId,
          callId: params.callId, tool: params.tool, resultSha256: createHash('sha256').update(text).digest('hex') });
        return { contentItems: [{ type: 'inputText', text }], success: true };
      } finally {
        active.pendingTools--;
        if (passive && --active.childWaits === 0 && this.active === active) active.resumeDeadline();
      }
    };
    this.protocol.subscribe((method, params) => this.event(method, params), error => this.active?.reject(error));
  }

  initialize(): Promise<void> {
    return this.initialized ??= (async () => {
      await this.protocol.request('initialize', { clientInfo: { name: 'three_layer_bridge', version: '0.2.0' }, capabilities: { experimentalApi: true } });
      await this.protocol.notify('initialized');
      // Read only to derive explicit disables; config contents never enter logs/model context.
      const response = await this.protocol.request('config/read', { includeLayers: false });
      const config = record(response.config);
      this.policy = { ...controllerPolicy, model_reasoning_effort: this.options.reasoning };
      for (const name of Object.keys(record(config.mcp_servers ?? {}))) this.policy[`mcp_servers.${name}.enabled`] = false;
      for (const name of Object.keys(record(config.plugins ?? {}))) this.policy[`plugins.${name}.enabled`] = false;
      for (const name of Object.keys(record(config.model_providers ?? {}))) {
        if (name === 'openai') continue;
        this.policy[`model_providers.${name}.request_max_retries`] = 0;
        this.policy[`model_providers.${name}.stream_max_retries`] = 0;
      }
    })();
  }

  private settings(instructions: string): Record<string, unknown> {
    return { cwd: this.options.cwd, model: this.options.model, config: this.policy,
      approvalPolicy: 'never', approvalsReviewer: 'user', sandbox: 'read-only',
      baseInstructions: instructions, developerInstructions: '', runtimeWorkspaceRoots: [] };
  }

  async create(generation: number, instructions: string, tools: ControllerTool[]): Promise<ControllerRef> {
    await this.initialize();
    const response = await this.protocol.request('thread/start', { ...this.settings(instructions),
      environments: [], ephemeral: false, allowProviderModelFallback: false, dynamicTools: tools });
    const thread = record(response.thread);
    invariant(typeof thread.id === 'string', 'CONTROLLER_THREAD_ID');
    this.createdRefs.push({ threadId: thread.id, generation });
    this.observe(response);
    this.threadTools.set(thread.id, tools);
    return { threadId: thread.id, generation };
  }

  async resume(ref: ControllerRef, instructions: string, tools: ControllerTool[], expectedTurnId?: string): Promise<void> {
    await this.initialize();
    const response = await this.protocol.request('thread/resume', { ...this.settings(instructions), threadId: ref.threadId, excludeTurns: true });
    invariant(record(response.thread).id === ref.threadId, 'CONTROLLER_RESUME_IDENTITY');
    this.observe(response);
    if (expectedTurnId) {
      const turns = await this.protocol.request('thread/turns/list', { threadId: ref.threadId, limit: 1, sortDirection: 'desc', itemsView: 'summary' });
      invariant(Array.isArray(turns.data) && turns.data.length === 1 && record(turns.data[0]).id === expectedTurnId && record(turns.data[0]).status === 'completed', 'CONTROLLER_RESUME_TURN_MISMATCH');
    }
    this.threadTools.set(ref.threadId, tools);
  }

  private observe(response: Record<string, unknown>): void {
    const observation = { model: response.model, modelProvider: response.modelProvider,
      reasoning: response.reasoningEffort, instructionSources: response.instructionSources, sandbox: response.sandbox };
    this.observations.push(observation);
    invariant(response.model === this.options.model && response.reasoningEffort === this.options.reasoning, 'CONTROLLER_MODEL_MISMATCH');
    // The declared login home's personal instructions are distinct from project
    // rules. Their presence never proves tool isolation; the capability gate is separate.
    const home = this.options.env.CODEX_HOME;
    const personal = home ? ['AGENTS.md', 'AGENTS.override.md'].map(name => path.join(realpathSync(home), name)) : [];
    invariant(Array.isArray(response.instructionSources) && response.instructionSources.every(source => {
      if (typeof source !== 'string' || !personal.includes(source)) return false;
      try { return !lstatSync(source).isSymbolicLink() && realpathSync(source) === source; } catch { return false; }
    }), 'CONTROLLER_INSTRUCTIONS_UNCONTROLLED');
  }

  private event(method: string, params: Record<string, unknown>): void {
    const active = this.active;
    if (!active || params.threadId !== active.ref.threadId) return;
    try {
      if (method === 'warning' && typeof params.message === 'string' && params.message.startsWith(controllerPolicyPrefix)) {
        invariant(!active.failed, 'CONTROLLER_STALE_TURN');
        let value: unknown;
        try { value = JSON.parse(params.message.slice(controllerPolicyPrefix.length)); } catch { throw new BridgeError('CONTROLLER_POLICY_INVALID'); }
        const policy = controllerPolicyEvidence(value, active.ref.threadId, active.turnId ?? '', this.threadTools.get(active.ref.threadId)!);
        this.options.policyAudit?.({ threadId: policy.threadId, turnId: policy.turnId, requestId: active.requestId,
          valid: this.options.requireRestrictedPolicy === true, evidence: policy });
        this.policyObservations.push(policy); active.policyObserved = true;
      }
      if (method === 'thread/tokenUsage/updated') active.usage = params;
      if (method === 'turn/started') {
        const turn = record(params.turn);
        invariant(typeof turn.id === 'string' && (!active.turnId || active.turnId === turn.id), 'CONTROLLER_TURN_ID');
        active.turnId = turn.id;
      }
      if (method === 'item/completed') {
        const item = record(params.item);
        if (item.type === 'agentMessage' && item.phase === 'final_answer') {
          invariant(typeof item.text === 'string', 'CONTROLLER_FINAL'); active.text = item.text;
        }
        if (item.type === 'contextCompaction') throw new BridgeError('CONTROLLER_UNEXPECTED_COMPACTION');
      }
      if (method === 'turn/completed') {
        invariant(!this.options.requireRestrictedPolicy || active.policyObserved, 'CONTROLLER_POLICY_MISSING');
        const turn = record(params.turn);
        invariant(turn.id === active.turnId && turn.status === 'completed' && !turn.error && active.pendingTools === 0 &&
          (active.text.length > 0 || active.delegatedResult), 'CONTROLLER_INCOMPLETE');
        const usage = active.usage ? completedUsage(active.usage, active.ref, active.turnId!, this.options.contextWindowTokens) : undefined;
        if (usage) this.usages.set(active.ref.threadId, usage); else this.usages.delete(active.ref.threadId);
        active.resolve({ turnId: active.turnId!, text: active.text, usage, policyVerified: this.options.requireRestrictedPolicy === true && active.policyObserved });
      }
    } catch (e) {
      active.failed = true;
      if (e instanceof BridgeError && ['CONTROLLER_POLICY_INVALID', 'CONTROLLER_UNEXPECTED_COMPACTION', 'CONTROLLER_TURN_ID', 'CONTROLLER_STALE_TURN'].includes(e.code)) {
        active.policyObserved = false;
        try { this.options.policyAudit?.({ threadId: active.ref.threadId, turnId: active.turnId ?? '', requestId: active.requestId, valid: false }); }
        catch { /* Missing durable evidence remains unverifiable. */ }
      }
      active.reject(e instanceof Error ? e : new BridgeError('CONTROLLER_EVENT'));
    }
  }

  async run(ref: ControllerRef, rawQuery: string, handler: ControllerToolHandler, signal?: AbortSignal, images: readonly ImageRef[] = [], identity?: ControllerRequestIdentity): Promise<ControllerTurn> {
    invariant(!this.active && this.threadTools.has(ref.threadId), 'CONTROLLER_NOT_READY');
    invariant(!signal?.aborted, 'CONTROLLER_CANCELLED');
    let timer: NodeJS.Timeout | undefined;
    let remaining = this.options.turnTimeoutMs, started = Date.now();
    const abort = () => { void this.interrupt(ref).catch(() => {}); this.active?.reject(new BridgeError('CONTROLLER_CANCELLED')); };
    const result = new Promise<ControllerTurn>((resolve, reject) => {
      const resumeDeadline = () => {
        started = Date.now();
        timer = setTimeout(() => { void this.interrupt(ref).catch(() => {}); reject(new BridgeError('CONTROLLER_TURN_TIMEOUT')); }, Math.max(1, remaining));
      };
      const pauseDeadline = () => { clearTimeout(timer); remaining -= Date.now() - started; };
      this.active = { ref, handler, resolve, reject, text: '', toolCalls: 0, pendingTools: 0, childWaits: 0, pauseDeadline, resumeDeadline,
        policyObserved: false, failed: false, requestId: identity?.requestId, delegatedResult: false };
      resumeDeadline();
    });
    // Attach rejection handling before awaiting the start ACK (notifications may precede it).
    void result.catch(() => {});
    signal?.addEventListener('abort', abort, { once: true });
    try {
      const input: Record<string, unknown>[] = [{ type: 'text', text: rawQuery, text_elements: [] }];
      if (images.length) {
        const media = this.options.media; invariant(media && images.length <= media.maxImages, 'CONTROLLER_IMAGES_NOT_CONFIGURED');
        let total = 0;
        for (const image of images) {
          const bytes = await readControlled(media.root, image.localPath, media.maxImageBytes);
          total += bytes.length;
          invariant(bytes.length === image.bytes && createHash('sha256').update(bytes).digest('hex') === image.sha256 && total <= media.maxTotalBytes, 'MEDIA_HASH');
          // Let the installed runtime prepare a local attachment after host hash validation.
          input.push({ type: 'localImage', path: image.localPath });
        }
      }
      invariant(!signal?.aborted, 'CONTROLLER_CANCELLED');
      this.options.promptAudit?.({ threadId: ref.threadId, ...identity,
        textSha256: createHash('sha256').update(input[0]!.text as string).digest('hex'), attachmentHashes: images.map(image => image.sha256) });
      const response = await this.protocol.request('turn/start', { threadId: ref.threadId,
        input, clientUserMessageId: identity?.requestId, model: this.options.model,
        effort: this.options.reasoning, environments: [] });
      const turn = record(response.turn);
      const active = this.active as ActiveTurn | undefined;
      invariant(active && typeof turn.id === 'string' && (!active.turnId || active.turnId === turn.id), 'CONTROLLER_TURN_ID');
      active.turnId = turn.id;
      return await result;
    } catch (e) {
      // Never resubmit a turn after an ACK, transport, timeout or completion failure.
      await this.close(); throw e;
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); this.active = undefined; }
  }

  getUsage(ref: ControllerRef): ContextUsageSnapshot | undefined {
    const usage = this.usages.get(ref.threadId);
    return usage?.validForGeneration === ref.generation ? usage : undefined;
  }
  async interrupt(ref: ControllerRef): Promise<void> {
    const active = this.active;
    invariant(active?.ref.threadId === ref.threadId && active.turnId, 'CONTROLLER_NO_ACTIVE_TURN');
    await this.protocol.request('turn/interrupt', { threadId: ref.threadId, turnId: active.turnId });
  }
  async close(): Promise<void> {
    try { await this.protocol.close(); } catch (error) { this.options.onCleanupUnknown?.(); throw error; }
  }
}
