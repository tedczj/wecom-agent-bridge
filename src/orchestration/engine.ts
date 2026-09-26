import type { Config } from '../config.ts';
import type { Store } from '../store.ts';
import type { AgentBackend, Channel, ImageRef, Incoming, Job, MediaProvider, NormalizedInput, SessionRef } from '../types.ts';
import { normalize } from '../local.ts';
import { BackendStateUnknown, errorCode, invariant, log } from '../errors.ts';
import { deadline } from '../async.ts';
import { type Directory, type Target } from '../routing/catalog.ts';
import { Directories } from './directories.ts';
import { workspaceLock } from '../routing/lock.ts';
import { resultParts } from '../reply.ts';
import { ControllerManager } from '../controllers/manager.ts';
import { bridgeInstructions } from '../controllers/bridge-agent.ts';
import { routeInstructions } from '../controllers/route-agent.ts';
import { readConversationState } from '../controllers/handoff.ts';
import type { ControllerSession } from './registry.ts';
import { RequestStore, type OriginalRequest, sha256 } from './requests.ts';
import { BusinessDispatch, type EffectBinding } from './dispatch.ts';
import { BusinessSessions, type SelectedBusiness } from './business-sessions.ts';
import { RoleTools, type ToolHandlers } from './tools.ts';
import { auditTools } from './audit.ts';
import { selectModel } from './config.ts';
import { orchestrationDebug } from './debug.ts';
import { finishHierarchicalMaintenance } from './maintenance-result.ts';
import { ArtifactStore } from '../answers/artifact-store.ts';
import { RecapService } from '../answers/recap.ts';
import { recordFailureNotice } from '../answers/failure-notice.ts';
import { listInteractions } from '../answers/projection.ts';
import { readAnswerOutline, readAnswerRange } from '../answers/history-tools.ts';
import { NativeCatalog, directoryIdentity, historyRevision } from '../history/catalog.ts';
import { NativeReader } from '../history/reader.ts';
import { HistoryReferences } from '../history/references.ts';
import type { PiCompletionProof } from '../history/verifier.ts';
import { approveMaintenance, proposeMaintenance, maintenanceActive, supervised, type Maintenance } from '../maintenance.ts';

export interface JobResultEnvelope { requestId: string; status: string; businessSessionKey?: string; answerRef?: string; shortText: string; recapState: string }
export interface HierarchicalDependencies {
  controllers: ControllerManager; sessions: BusinessSessions; artifacts: ArtifactStore; recaps: RecapService;
  backend: (config: Config) => AgentBackend;
}
type QueuedBusiness = { target: Target; selected: SelectedBusiness; request: OriginalRequest; abort: AbortController; resolve: (result: JobResultEnvelope) => void };
type SessionListSnapshot = { directory: Directory; profileDigest: string; entries: Array<{ sessionRef: string; title: string; nativeId: string }>;
  expiresAt: number; nextCursor?: string; query?: string };

/** Durable ingress and control commands do not wait for the management parent chain. */
export class HierarchicalBridge {
  private requests: RequestStore;
  private dispatch: BusinessDispatch;
  private planning: Promise<void> = Promise.resolve();
  private stopped = true;
  private aborts = new Map<string, AbortController>();
  private queued = new Map<string, QueuedBusiness>();
  private worker?: Promise<void>;
  private wakeAgain = false;
  private controls = new Set<Promise<void>>();
  private preparations = new Map<string, Promise<void>>();
  private postprocessing = new Set<Promise<void>>();
  private shutdown = new AbortController();
  private activeBackend?: AgentBackend;
  private directoryCache = new Map<string, Directory>();
  private failureNotices = new Map<string, Promise<void>>();
  private authority: Directories;
  constructor(private c: Config, private channelId: string, readonly store: Store, private channel: Channel, private media: MediaProvider,
    private dependencies: HierarchicalDependencies, private normalizer: typeof normalize = normalize) {
    invariant(c.orchestration && c.routing && c.models, 'HIERARCHICAL_CONFIG_REQUIRED');
    this.authority = new Directories(c, store);
    this.requests = new RequestStore(store); this.dispatch = new BusinessDispatch(store, dependencies.controllers.registry);
  }
  async start(): Promise<void> {
    invariant(this.stopped, 'HIERARCHICAL_ALREADY_STARTED');
    const recovered = this.dependencies.controllers.recover(); this.dispatch.recover();
    for (const id of recovered.requests) {
      const row = this.store.db.prepare('SELECT conversation_scope FROM orchestration_requests WHERE request_id=?').get(id) as { conversation_scope: string };
      const request = this.requests.get(id, row.conversation_scope), job = this.controlJob(request);
      this.store.complete(job.task_id, 'failed', '请求在路由期间中断，未提交业务，未自动重试。', 'CONTROLLER_RESTARTED');
    }
    this.store.db.prepare("UPDATE answer_recaps SET state='failed',failure_code='RECAP_INTERRUPTED',completed_at=? WHERE state='pending'").run(Date.now());
    const maintenanceResult = this.store.value<Maintenance>('maintenance');
    if (maintenanceResult && this.store.db.prepare("SELECT 1 FROM answer_artifacts WHERE request_id=? AND job_task_id=? AND producer_role='system' AND state IN ('staging','ready') AND finish_evidence_json IS NOT NULL")
      .get(maintenanceResult.taskId, maintenanceResult.taskId)) await finishHierarchicalMaintenance(this.c, this.store, maintenanceResult);
    const staging = this.store.db.prepare("SELECT answer_id,job_task_id FROM answer_artifacts WHERE state='staging' AND finish_evidence_json IS NOT NULL AND job_task_id IS NOT NULL").all() as { answer_id: string; job_task_id: string }[];
    for (const row of staging) {
      try {
        await this.dependencies.artifacts.recover(row.answer_id, raw => { this.store.completeArtifact(row.job_task_id, row.answer_id, raw); });
        this.store.db.prepare("UPDATE controller_effects SET state='completed',updated_at=? WHERE job_task_id=?").run(Date.now(), row.job_task_id);
      } catch (error) { log('answer.recovery_unverified', { taskId: row.job_task_id, code: errorCode(error) }); }
    }
    const maintenance = this.store.value<Maintenance>('maintenance');
    const preserved = supervised(this.c) && maintenance?.supervisorToken === process.env.BRIDGE_SUPERVISOR_TOKEN && maintenanceActive(maintenance) ? maintenance!.taskId : undefined;
    this.store.recover(preserved);
    const jobs = this.store.db.prepare(`SELECT r.request_id,r.conversation_scope,r.phase,r.route_snapshot_json,j.status,j.kind,j.input_json FROM orchestration_requests r
      JOIN jobs j ON j.task_id=r.job_task_id WHERE r.phase NOT IN ('completed','failed','cancelled','interrupted') ORDER BY r.ingress_seq`).all() as Array<Record<string, unknown>>;
    for (const row of jobs) {
      const request = this.requests.get(row.request_id as string, row.conversation_scope as string), job = this.store.get(request.job_task_id!);
      if (job.task_id === preserved) continue;
      if (row.status === 'queued' && row.kind === 'agent') {
        try {
          const input = JSON.parse(row.input_json as string) as NormalizedInput;
          invariant(input.requestId === request.request_id && input.routing && !input.contextTaskIds?.length, 'QUEUED_REQUEST_UNVERIFIED');
          const target = this.target(input.routing.directory, request.conversation_scope, input.routing.modelProfile), saved = this.store.value<Omit<SelectedBusiness, 'selection'>>('business-selection:' + request.request_id);
          invariant(saved && target.digest === input.routing.digest && saved.snapshot.profileDigest === target.digest && saved.snapshot.scope === request.conversation_scope, 'PROFILE_CHANGED');
          const effect = this.store.db.prepare("SELECT state FROM controller_effects WHERE job_task_id=? AND stage='route' AND effect_key='business-submit'").get(job.task_id) as { state: string } | undefined;
          invariant(effect?.state === 'submitted', 'BUSINESS_EXECUTION_UNCERTAIN');
          const selected: SelectedBusiness = { ...saved, selection: { ...target, reason: input.routing.reason, sessionKey: job.session_key, bind: false } };
          const abort = new AbortController(); this.aborts.set(request.request_id, abort);
          this.queued.set(job.task_id, { target, selected, request, abort, resolve: () => { this.aborts.delete(request.request_id); } });
        } catch (error) {
          this.store.complete(job.task_id, 'failed', `排队任务未执行（${errorCode(error)}），未自动重做。`, errorCode(error));
          this.store.db.prepare("UPDATE orchestration_requests SET phase='failed',failure_code=?,updated_at=? WHERE request_id=?").run(errorCode(error), Date.now(), request.request_id);
        }
      } else if (row.status === 'succeeded') {
        const artifact = this.store.db.prepare("SELECT answer_id,producer_role FROM answer_artifacts WHERE request_id=? AND state='ready' AND kind='final'").get(request.request_id) as { answer_id: string; producer_role: 'bridge' | 'route' | 'business' } | undefined;
        if (artifact) {
          const input = JSON.parse(row.input_json as string) as NormalizedInput;
          const snapshot = row.route_snapshot_json ? JSON.parse(row.route_snapshot_json as string) as { selectedDirectory?: Directory; intentKind?: string } : undefined;
          this.planning = this.planning.then(async () => {
            try { await this.recordAnswer(request, input.routing?.directory ?? snapshot?.selectedDirectory, artifact.producer_role,
              row.kind === 'agent' ? 'work' : snapshot?.intentKind === 'history_query' ? 'history_query' : 'control', artifact.answer_id, row.kind === 'agent' ? job.session_key : undefined); }
            catch { this.store.db.prepare("UPDATE orchestration_requests SET phase='completed',updated_at=? WHERE request_id=?").run(Date.now(), request.request_id); }
          });
        } else this.store.db.prepare("UPDATE orchestration_requests SET phase='completed',updated_at=? WHERE request_id=?").run(Date.now(), request.request_id);
      } else if (['failed', 'cancelled', 'timed_out', 'interrupted'].includes(String(row.status))) {
        this.store.db.prepare('UPDATE orchestration_requests SET phase=?,updated_at=? WHERE request_id=?')
          .run(row.status === 'timed_out' ? 'failed' : row.status as string, Date.now(), request.request_id);
      } else if (row.kind === 'command') {
        this.store.complete(job.task_id, 'failed', '只读结果处理中断，未重新执行请求。', 'RESULT_PROCESSING_INTERRUPTED');
        this.store.db.prepare("UPDATE orchestration_requests SET phase='interrupted',updated_at=? WHERE request_id=?").run(Date.now(), request.request_id);
      }
    }
    const notices = this.store.db.prepare(`SELECT r.request_id,r.conversation_scope FROM orchestration_requests r LEFT JOIN interaction_records i ON i.request_id=r.request_id
      WHERE r.hash_version='raw-v4' AND r.phase IN ('failed','cancelled','interrupted') AND i.request_id IS NULL ORDER BY r.ingress_seq`).all() as { request_id: string; conversation_scope: string }[];
    for (const row of notices) await this.recordFailure(this.requests.get(row.request_id, row.conversation_scope));
    this.stopped = false;
    const rows = this.store.db.prepare("SELECT request_id,conversation_scope FROM orchestration_requests WHERE phase IN ('accepted','media_preparing') ORDER BY ingress_seq").all() as { request_id: string; conversation_scope: string }[];
    for (const row of rows) this.schedule(this.requests.get(row.request_id, row.conversation_scope), true);
    this.kick();
  }
  async accept(frame: unknown): Promise<{ taskId?: string; duplicate?: boolean; rejected?: string }> {
    if (this.stopped) return { rejected: 'STOPPING' };
    let incoming: Incoming;
    try { incoming = this.normalizer(frame, this.c, this.channelId); }
    catch (error) { return { rejected: errorCode(error, 'INVALID_MESSAGE') }; }
    try {
      const { request, duplicate } = this.store.atomic(() => {
        const result = this.requests.accept(incoming);
        if (!result.duplicate && !incoming.text.trim().startsWith('/')) {
          invariant(!this.store.blocked(), 'WORKSPACE_BLOCKED');
          const pending = this.store.db.prepare(`SELECT count(*) n FROM orchestration_requests r LEFT JOIN jobs j ON j.task_id=r.job_task_id
            WHERE r.phase IN ('accepted','media_preparing','bridge_planning','route_planning') OR r.phase='awaiting_business' AND j.status IN ('preparing','queued')`).get() as { n: number };
          invariant(pending.n <= this.c.queue.maxPendingGlobal, 'QUEUE_FULL');
          const conversationPending = this.store.db.prepare(`SELECT count(*) n FROM orchestration_requests r LEFT JOIN jobs j ON j.task_id=r.job_task_id
            WHERE r.conversation_scope=? AND (r.phase IN ('accepted','media_preparing','bridge_planning','route_planning') OR r.phase='awaiting_business' AND j.status IN ('preparing','queued'))`).get(result.request.conversation_scope) as { n: number };
          invariant(conversationPending.n <= this.c.queue.maxPendingPerSession, 'QUEUE_FULL');
        }
        return result;
      });
      if (duplicate) return { taskId: request.request_id, duplicate: true };
      log('request.accepted', { taskId: request.request_id });
      const maintenance = this.store.value<Maintenance>('maintenance'), approval = ['/approve', '同意授权'].includes(request.raw_query.trim());
      if (!approval) this.authority.cancelConsent(request.conversation_scope);
      if (maintenance?.phase === 'approval' && maintenance.route === request.route_json && !approval) this.store.put('maintenance', { ...maintenance, phase: 'failed', code: 'APPROVAL_CANCELLED' });
      if (maintenanceActive(maintenance) && !/^\/(?:status|debug|cancel|result|help)(?:\s|$)/.test(request.raw_query.trim())) {
        await this.systemAnswer(request, '服务正在等待更新或重启，未接收新工作；可用 /status 查看。', 'failed', 'MAINTENANCE_DRAINING');
        return { taskId: request.request_id, duplicate: false };
      }
      if (request.raw_query.trim().startsWith('/') || request.raw_query.trim() === '同意授权') {
        const abort = new AbortController(); this.aborts.set(request.request_id, abort);
        const pending = this.control(request, incoming); this.controls.add(pending);
        try { await pending; } finally { this.controls.delete(pending); if (this.aborts.get(request.request_id) === abort) this.aborts.delete(request.request_id); }
      }
      else {
        try {
          this.authority.cancelConsent(request.conversation_scope);
          this.pendingChoice(request);
          this.schedule(this.requests.get(request.request_id, request.conversation_scope));
          void deadline(this.channel.receipt(incoming.reqId, `已接收 #${request.request_id.slice(0, 8)}，正在定位目录并排队。`), this.c.reply.sendTimeoutMs, 'RECEIPT_TIMEOUT')
            .catch(() => log('receipt.failed', { code: 'RECEIPT_UNKNOWN' }));
        } catch (error) { await this.fail(request, errorCode(error), false); }
      }
      return { taskId: request.request_id, duplicate: false };
    } catch (error) { return { rejected: errorCode(error) }; }
  }
  private schedule(request: OriginalRequest, recovery = false): void {
    const abort = new AbortController(); this.aborts.set(request.request_id, abort);
    const control = (request.raw_query.trim().startsWith('/') || request.raw_query.trim() === '同意授权') && !request.source_request_id;
    const preparing = control ? Promise.resolve() : this.prepareMedia(request, abort, recovery);
    this.preparations.set(request.request_id, preparing);
    void preparing.catch(() => {});
    this.planning = this.planning.catch(() => {}).then(async () => {
      try {
        await preparing;
        if (this.stopped || abort.signal.aborted || !['accepted', 'media_preparing'].includes(this.requests.get(request.request_id, request.conversation_scope).phase)) return;
        if (control) await this.control(request, this.incoming(request));
        else await this.plan(request, abort);
      }
      catch (error) { await this.fail(request, errorCode(error), abort.signal.aborted); }
      finally { this.aborts.delete(request.request_id); this.preparations.delete(request.request_id); this.kick(); }
    });
  }
  private async prepareMedia(request: OriginalRequest, abort: AbortController, recovery: boolean): Promise<void> {
    try {
      if (request.phase === 'accepted') this.requests.transition(request.request_id, request.conversation_scope, ['accepted'], 'media_preparing');
      const source = this.source(request), cached = this.store.value<ImageRef[]>('request-media:' + source.request_id);
      const images = cached ?? (recovery && this.media.recoverPreparation ? await this.media.recoverPreparation(source.request_id, this.incoming(source).media, abort.signal)
        : await this.media.prepare(source.request_id, this.incoming(source).media, abort.signal));
      await this.media.validate(images); invariant(!abort.signal.aborted, 'CONTROLLER_CANCELLED');
      this.store.put('request-media:' + request.request_id, images);
    } catch (error) { await this.fail(request, errorCode(error), abort.signal.aborted); throw error; }
  }
  async mediaReady(requestId: string): Promise<void> {
    try { await this.preparations.get(requestId); }
    catch (error) {
      const row = this.store.db.prepare('SELECT phase FROM orchestration_requests WHERE request_id=?').get(requestId) as { phase: string } | undefined;
      if (!row || !['failed', 'cancelled', 'interrupted'].includes(row.phase)) throw error;
    }
  }
  reject(incoming: Incoming, code: string, text: string): void {
    const { request, duplicate } = this.requests.accept(incoming); if (duplicate) return;
    const job = this.controlJob(request); this.store.complete(job.task_id, 'failed', text, code);
    this.requests.transition(request.request_id, request.conversation_scope, ['accepted'], 'failed', code);
    void this.recordFailure(request);
  }
  private incoming(request: OriginalRequest): Incoming {
    const row = this.store.db.prepare('SELECT message_id FROM orchestration_requests WHERE request_id=?').get(request.request_id) as { message_id: string };
    return { messageId: row.message_id, reqId: request.request_id, route: JSON.parse(request.route_json), text: request.raw_query,
      media: JSON.parse(request.attachments_json), receivedAt: request.received_at };
  }
  private source(request: OriginalRequest): OriginalRequest {
    return request.source_request_id ? this.requests.get(request.source_request_id, request.conversation_scope) : request;
  }
  private pendingChoice(request: OriginalRequest): void {
    const state = readConversationState(this.store, request.conversation_scope), pending = state.pendingSelection;
    if (!pending) return;
    const choice = request.raw_query.trim().replace(/^(?:请)?(?:选择|选|就是)\s*(?:刚才查的\s*)?/, '').replace(/[。！!]$/, '').trim();
    const choices = new Set([choice, choice.replace(/\s*那个$/, '').trim()]);
    const matches = pending.optionRefs.flatMap((ref, i) => {
      const directory = this.directory(ref, request.conversation_scope), number = i === 0 ? '一' : '二';
      return [String(i + 1), `第${number}个`, `${number}个`, `第${i + 1}个`, directory.id, ...directory.aliases].some(name => choices.has(name)) ? [i] : [];
    });
    invariant(matches.length <= 1, 'DIRECTORY_CHOICE_AMBIGUOUS');
    const index = matches[0] ?? -1;
    state.pendingSelection = undefined; this.store.put('orchestration:conversation:' + request.conversation_scope, state);
    if (index < 0) return; // A reply containing new work remains a new original query.
    invariant(Date.now() < pending.expiresAt && request.received_at < pending.expiresAt, 'SOURCE_REQUEST_NOT_PENDING');
    const ref = pending.optionRefs[index]!, target = this.target(this.directory(ref, request.conversation_scope), request.conversation_scope);
    const snapshot = this.store.db.prepare('SELECT route_snapshot_json FROM orchestration_requests WHERE request_id=? AND conversation_scope=?')
      .get(pending.sourceRequestId, request.conversation_scope) as { route_snapshot_json: string };
    const versions = JSON.parse(snapshot.route_snapshot_json).directoryVersions as Record<string, string>;
    invariant(versions?.[ref] === target.digest, 'PROFILE_CHANGED');
    this.requests.referencePending(request.request_id, pending.sourceRequestId, request.conversation_scope);
    this.store.db.prepare('UPDATE orchestration_requests SET route_snapshot_json=? WHERE request_id=?').run(JSON.stringify({ forcedDirectoryRef: ref }), request.request_id);
  }
  private target(directory: Directory, scope: string, requestedProfile?: string, useSessionPreference = true): Target {
    const daily = this.c.models![this.c.orchestration!.business.defaultModelProfile]!;
    const profile = this.c.routing!.profiles.find(profile => profile.id === directory.profile);
    const current = this.store.db.prepare(`SELECT b.session_key FROM business_bindings b LEFT JOIN orchestration_requests r ON r.request_id=b.selection_request_id
      WHERE b.conversation_scope=? AND b.directory_identity=? ORDER BY r.ingress_seq DESC,b.updated_at DESC LIMIT 1`).get(scope, directoryIdentity({ directory })) as { session_key: string } | undefined;
    const sessionProfile = current && useSessionPreference ? this.store.value<string>('session-model:' + current.session_key) : undefined;
    const selectedProfile = requestedProfile ?? sessionProfile;
    if (selectedProfile) invariant(Object.hasOwn(this.c.models!, selectedProfile), 'CONFIG_MODEL_PROFILE');
    const resolved = selectModel(daily, { request: requestedProfile ? this.c.models![requestedProfile] : undefined,
      'session-explicit': sessionProfile ? this.c.models![sessionProfile] : undefined, directory: profile?.codex });
    const target = this.authority.catalog(scope).target(directory, resolved.profile);
    return { ...target, modelProfile: selectedProfile, modelSource: resolved.source, modelSources: resolved.sources };
  }
  private directories(scope: string): Array<{ directoryRef: string; name: string; path: string; aliases: string[]; description: string }> {
    return this.authority.catalog(scope).directories.map(directory => { this.directoryCache.set(scope + ':' + directory.id, directory);
      return { directoryRef: directory.id, name: directory.id, path: directory.path, aliases: directory.aliases, description: directory.description }; });
  }
  private directory(ref: string, scope: string): Directory {
    const cached = this.directoryCache.get(scope + ':' + ref);
    return cached ? this.authority.catalog(scope).validate(cached) : this.authority.resolve(scope, ref);
  }
  private async plan(request: OriginalRequest, abort: AbortController): Promise<void> {
    const scope = request.conversation_scope;
    const source = this.source(request), snapshot = this.store.db.prepare('SELECT route_snapshot_json FROM orchestration_requests WHERE request_id=?').get(request.request_id) as { route_snapshot_json: string | null };
    const forcedDirectoryRef = snapshot.route_snapshot_json ? JSON.parse(snapshot.route_snapshot_json).forcedDirectoryRef as string | undefined : undefined;
    const images = this.store.value<ImageRef[]>('request-media:' + request.request_id);
    invariant(images, 'SOURCE_MEDIA_UNAVAILABLE'); await this.media.validate(images);
    this.store.put('request-media:' + request.request_id, images);
    this.requests.transition(request.request_id, scope, ['media_preparing'], 'bridge_planning');
    let delegated: Promise<JobResultEnvelope> | undefined, selectedKey: string | undefined, clarified = false, authorizationQuestion: string | undefined;
    const shared = (directory?: Directory): ToolHandlers => ({
      search_interactions: async args => listInteractions(this.store, scope, { searchQuery: args.query as string,
        directoryIdentity: args.directoryRef ? directoryIdentity(this.target(this.directory(args.directoryRef as string, scope), scope)) : undefined,
        limit: args.limit as number | undefined, beforeSeq: args.beforeSeq as number | undefined }),
      list_interactions: async args => {
      const state = readConversationState(this.store, scope);
      const ref = directory?.id ?? state.activeWorkspace;
      return listInteractions(this.store, scope, { directoryIdentity: args.scope === 'directory' && ref ? directoryIdentity(this.target(this.directory(ref, scope), scope)) : undefined,
        limit: args.limit as number | undefined, beforeSeq: args.beforeSeq as number | undefined });
    } });
    const handlers: ToolHandlers = {
      ...shared(), list_directories: async () => ({ directories: this.directories(scope), ...readConversationState(this.store, scope), forcedDirectoryRef,
        fallbackDirectoryRef: this.c.routing!.fallbackWorkspace }),
      search_directories: async args => {
        const found = await this.authority.search(scope, args.query as string);
        for (const directory of found.scan.matches) this.directoryCache.set(scope + ':' + directory.id, directory);
        return { directories: found.scan.matches.map(d => ({ directoryRef: d.id, name: d.id, aliases: d.aliases, description: d.description })), partial: found.partial };
      },
      remember_alias: async args => {
        invariant(!selectedKey, 'DIRECTORY_ALIAS_AFTER_DELEGATION');
        this.authority.alias(scope, request.request_id, args.alias as string, this.directory(args.directoryRef as string, scope)); return { saved: true };
      },
      propose_directory: async args => {
        invariant(!selectedKey && !clarified, 'AUTHORIZATION_REQUEST_STATE');
        const consent = this.authority.propose(scope, request.request_id, args.path as string); clarified = true;
        authorizationQuestion = `是否授权本次请求访问目录：\n${consent.directory.path}\n权限配置：${consent.directory.profile}（${consent.permissions}）\n请在 15 分钟内回复 /approve。仅授权该目录，不提升 Agent 权限。`;
        return { authorizationRequired: true, question: authorizationQuestion };
      },
      clarify_directory: async args => {
        invariant(!selectedKey && args.option1 !== args.option2 && !forcedDirectoryRef, 'DIRECTORY_CLARIFICATION_INVALID');
        const choices = [this.directory(args.option1 as string, scope), this.directory(args.option2 as string, scope)];
        const state = readConversationState(this.store, scope);
        state.pendingSelection = { sourceRequestId: request.request_id, expiresAt: Date.now() + 15 * 60 * 1000, optionRefs: choices.map(d => d.id) };
        this.store.put('orchestration:conversation:' + scope, state);
        this.store.db.prepare('UPDATE orchestration_requests SET route_snapshot_json=? WHERE request_id=?').run(JSON.stringify({ pendingSelection: true, expiresAt: state.pendingSelection.expiresAt,
          directoryVersions: Object.fromEntries(choices.map(d => [d.id, this.target(d, scope).digest])) }), request.request_id);
        clarified = true; return { question: args.question, options: choices.map((d, i) => ({ index: i + 1, directoryRef: d.id })) };
      },
      route_delegate: async args => {
        invariant(!abort.signal.aborted && !clarified, 'CONTROLLER_CANCELLED');
        invariant(!forcedDirectoryRef || args.directoryRef === forcedDirectoryRef, 'DIRECTORY_CHOICE_MISMATCH');
        const directory = this.directory(args.directoryRef as string, scope);
        const key = JSON.stringify([args.directoryRef, args.intentKind]);
        invariant(!selectedKey || selectedKey === key, 'DUPLICATE_DIRECTORY_DELEGATION'); selectedKey = key;
        if (!delegated) delegated = this.route(request, directory, args.intentKind as string, images, abort, shared);
        return delegated;
      },
    };
    const tools = new RoleTools('bridge', handlers), model = this.c.models![this.c.orchestration!.bridge.modelProfile]!;
    const result = await this.dependencies.controllers.run({ requestId: request.request_id, sourceRequestId: request.source_request_id ?? request.request_id,
      scope, role: 'bridge', directoryIdentity: null, model, instructions: bridgeInstructions, tools: tools.definitions },
      source.raw_query, actor => auditTools(this.store, request.request_id, actor, Math.max(this.c.orchestration!.answers.shortAnswerMaxChars, this.c.orchestration!.answers.recapMaxChars),
        (name, args, id) => tools.call(name, args, id), this.c.orchestration!.limits.maxControllerDecisionsPerRequest), abort.signal, images);
    if (delegated) await delegated;
    else if (authorizationQuestion) await this.systemAnswer(request, authorizationQuestion);
    else await this.controllerAnswer(request, undefined, 'bridge', result.session, result.turn.turnId, result.turn.text, 'control');
  }
  private async route(request: OriginalRequest, directory: Directory, intent: string, images: ImageRef[], abort: AbortController,
    shared: (directory?: Directory) => ToolHandlers): Promise<JobResultEnvelope> {
    const scope = request.conversation_scope, state = readConversationState(this.store, scope); let target = this.target(directory, scope), persistModel = false;
    this.requests.transition(request.request_id, scope, ['bridge_planning'], 'route_planning');
    const previous = this.store.db.prepare('SELECT route_snapshot_json FROM orchestration_requests WHERE request_id=?').get(request.request_id) as { route_snapshot_json: string | null };
    this.store.db.prepare('UPDATE orchestration_requests SET route_snapshot_json=? WHERE request_id=?').run(JSON.stringify({
      ...(previous.route_snapshot_json ? JSON.parse(previous.route_snapshot_json) : {}), selectedDirectory: directory, profileDigest: target.digest, intentKind: intent }), request.request_id);
    if (intent === 'work' || intent === 'switch') state.activeWorkspace = directory.id;
    else state.queryFocus = { ...(state.queryFocus?.directoryRef === directory.id ? state.queryFocus : {}), directoryRef: directory.id, requestId: request.request_id };
    this.store.put('orchestration:conversation:' + scope, state);
    let selected: SelectedBusiness | undefined, business: Promise<JobResultEnvelope> | undefined, binding: EffectBinding, intentConflict = false, selectionRequired = false;
    const history = new HistoryReferences(this.store);
    const handlers: ToolHandlers = {
      ...shared(directory),
      list_business_models: async () => Object.entries(this.c.models!).map(([name, model]) => ({ modelProfile: name, model: model.model, reasoning: model.reasoning })),
      resolve_business_options: async args => {
        invariant(!business, 'BUSINESS_ALREADY_SELECTED');
        invariant(args.persistence !== 'session' || typeof args.modelProfile === 'string', 'MODEL_PROFILE_REQUIRED');
        target = this.target(directory, scope, args.modelProfile as string | undefined, args.intent !== 'new'); persistModel = args.persistence === 'session'; selected = undefined;
        let candidate;
        if (args.sessionRef) {
          try { candidate = await history.get(scope, target, args.sessionRef as string); }
          catch (error) { this.dependencies.sessions.refuseResume(request.request_id, target, args.sessionRef as string, error); }
        }
        const options = await this.dependencies.sessions.resolve(binding, target, args.intent as 'new' | 'automatic' | undefined, candidate);
        selectionRequired = !options.options.some(option => option.isDefault); return { ...options, delegationIntent: intent };
      },
      select_business_session: async args => {
        selected = await this.dependencies.sessions.select(binding, target, args.optionToken as string, abort.signal);
        return { selectionToken: selected.token, reason: selected.option.reason };
      },
      business_execute: async args => {
        if (intent !== 'work') { intentConflict = true; invariant(false, 'ROUTE_INTENT_CONFLICT'); }
        invariant(intent === 'work' && !abort.signal.aborted && selected && selected.token === args.selectionToken, 'BUSINESS_EXECUTION_DENIED');
        if (!business) business = (async () => {
          const choice = selected;
          invariant(choice, 'SESSION_SELECTION_INVALID');
          await this.media.validate(images); invariant(!abort.signal.aborted, 'CONTROLLER_CANCELLED');
          const job = this.store.atomic(() => {
            const job = this.dispatch.enqueue(binding, choice.token, choice.selection, () => { this.authority.catalog(scope).validate(directory); this.dependencies.sessions.validate(binding, target, choice); });
            this.dependencies.sessions.bind(binding, target, choice, job);
            if (persistModel) this.store.put('session-model:' + job.session_key, target.modelProfile);
            return job;
          });
          const result = new Promise<JobResultEnvelope>(resolve => { this.queued.set(job.task_id, { target, selected: choice, request, abort, resolve }); });
          invariant(this.store.prepared(job.task_id, images), 'BUSINESS_PREPARATION_CANCELLED'); this.kick();
          return result;
        })();
        return business;
      },
      list_business_sessions: async args => {
        const page = await history.list(scope, target, args.cursor as string | undefined, args.limit as number | undefined);
        const focus = readConversationState(this.store, scope).queryFocus;
        return { ...page, queryFocus: focus?.directoryRef === directory.id ? focus : undefined };
      },
      read_business_session: async args => {
        const candidate = await history.get(scope, target, args.sessionRef as string);
        const page = await new NativeReader().readWindow(target, candidate, args.cursor as string | undefined, abort.signal, args.order === 'oldest-first' ? 'oldest-first' : 'newest-first');
        const state = readConversationState(this.store, scope), owner = this.store.nativeOwner(candidate.ref);
        state.queryFocus = { directoryRef: directory.id, sessionRef: args.sessionRef as string, sessionKey: owner?.session_key, requestId: request.request_id };
        this.store.put('orchestration:conversation:' + scope, state);
        return { ...page, nativeId: candidate.ref.kind === 'codex' ? candidate.ref.threadId : candidate.ref.sessionId, role: candidate.role };
      },
      read_answer_outline: args => readAnswerOutline(this.dependencies.artifacts, args.answerRef as string, { role: 'route', scope }),
      read_answer_range: args => readAnswerRange(this.dependencies.artifacts, args.answerRef as string, { role: 'route', scope }, args.start as number, args.limit as number | undefined),
    };
    const tools = new RoleTools('route', handlers), model = this.c.models![this.c.orchestration!.bridge.modelProfile]!;
    const result = await this.dependencies.controllers.run({ requestId: request.request_id, sourceRequestId: request.source_request_id ?? request.request_id,
      scope, role: 'route', directoryIdentity: directoryIdentity(target), model,
      instructions: routeInstructions, tools: tools.definitions }, this.source(request).raw_query, actor => {
      binding = { requestId: request.request_id, scope, controllerId: actor.controller_id, generation: actor.generation };
      return auditTools(this.store, request.request_id, actor, Math.max(this.c.orchestration!.answers.shortAnswerMaxChars, this.c.orchestration!.answers.recapMaxChars),
        (name, args, id) => tools.call(name, args, id), this.c.orchestration!.limits.maxControllerDecisionsPerRequest);
    }, abort.signal, images);
    this.dependencies.sessions.assertNoResumeFailure(request.request_id);
    if (business) return business;
    invariant(!intentConflict, 'ROUTE_INTENT_CONFLICT');
    if (intent === 'work') {
      invariant(selectionRequired && !selected, 'BUSINESS_NOT_SUBMITTED');
      await this.systemAnswer(request, '尚未执行业务：当前候选会话没有可自动使用的默认项。请先用 /sessions 查看并用 /resume 明确选择，然后重新发送原工作请求。');
      return this.envelope(request);
    }
    if (intent === 'switch') {
      await this.systemAnswer(request, `已选择目录：${directory.path}\n未恢复或执行业务会话。`);
      return this.envelope(request);
    }
    return this.controllerAnswer(request, directory, 'route', result.session, result.turn.turnId, result.turn.text, intent === 'history_query' ? 'history_query' : 'control');
  }
  private kick(): void {
    if (this.stopped) return;
    if (this.worker) { this.wakeAgain = true; return; }
    this.wakeAgain = false;
    this.worker = (async () => {
      for (;;) {
        if (this.stopped) return;
        const job = this.store.claim(); if (!job) return;
        const queued = this.queued.get(job.task_id); invariant(queued, 'ORPHAN_BUSINESS_JOB');
        await this.execute(job, queued);
      }
    })().catch(error => { this.stopped = true; log('worker.stopped', { code: errorCode(error) }); })
      .finally(() => { this.worker = undefined; if (this.wakeAgain && !this.stopped) this.kick(); });
  }
  private async execute(job: Job, queued: QueuedBusiness): Promise<void> {
    const { request, selected, abort } = queued, scope = request.conversation_scope;
    let release: (() => void) | undefined, submitted = false;
    const timer = setTimeout(() => { this.store.cancel(job.task_id); abort.abort(); }, queued.target.config.agent.taskTimeoutMs);
    try {
      const input = JSON.parse(job.input_json) as NormalizedInput;
      const target = this.target(queued.target.directory, scope, input.routing?.modelProfile); invariant(target.digest === queued.target.digest, 'PROFILE_CHANGED');
      invariant(!input.contextTaskIds?.length && !input.routing?.authorizedRequestTaskId && sha256(input.text) === input.rawQuerySha256 && input.text === this.source(request).raw_query, 'VERBATIM_CONTRACT_CONFLICT');
      await this.media.validate(input.images);
      const proof = this.store.value<PiCompletionProof>('pi-completion:' + job.session_key);
      await this.dependencies.sessions.beforePrompt(target, job, selected, abort.signal, proof);
      invariant(!abort.signal.aborted, 'CONTROLLER_CANCELLED'); release = workspaceLock(target.config.workspace.path, target.config.stateRoot);
      const artifact = this.dependencies.artifacts.stage(request.request_id, 'business', job.task_id, job.session_key);
      const backend = this.dependencies.backend(target.config); this.activeBackend = backend;
      this.dispatch.submitting(job.task_id); submitted = true;
      const session = this.store.session(job.session_key);
      const result = await backend.run(input, session.agent_ref_json ? JSON.parse(session.agent_ref_json) as SessionRef : undefined, {
        contextWindowResolved: value => this.store.put('business-context-window:' + job.task_id, value),
        persistSession: async ref => this.store.atomic(() => {
          new NativeCatalog(this.store, scope).registerBusiness(target, ref);
          this.store.persistSession(job.session_key, ref);
        }), progress: () => {},
        captureFinal: text => this.dependencies.artifacts.capture(artifact.answer_id, text),
        promptSubmitted: audit => {
          invariant(audit.textSha256 === input.rawQuerySha256, 'QUERY_WIRE_HASH_MISMATCH');
          this.dispatch.admitPrompt(job.task_id, audit.textSha256);
          this.store.put('business-wire:' + request.request_id, { requestId: request.request_id, sourceRequestId: input.sourceRequestId, profileDigest: target.digest, ...audit });
          process.stderr.write(JSON.stringify({ event: 'business.prompt_submitted', requestId: request.request_id, sourceRequestId: input.sourceRequestId, profileDigest: target.digest, ...audit }) + '\n');
        },
      }, abort.signal);
      if (result.outcome === 'success' && this.store.get(job.task_id).status !== 'cancel_requested') {
        invariant(result.finishEvidence, 'ANSWER_FINISH_UNVERIFIED');
        invariant(this.dependencies.artifacts.get(artifact.answer_id).sha256 === sha256(result.finalText), 'ANSWER_HASH_MISMATCH');
        this.requests.transition(request.request_id, scope, ['awaiting_business'], 'result_processing');
        await this.dependencies.artifacts.publish(artifact.answer_id, result.finishEvidence, () => { this.store.completeArtifact(job.task_id, artifact.answer_id, result.finalText); });
        this.dispatch.finished(job.task_id, false); submitted = false;
        if (result.sessionRef?.kind === 'pi') this.store.put('pi-completion:' + job.session_key, { nativeId: result.sessionRef.sessionId,
          sourceRevision: historyRevision(result.sessionRef.sessionFile), profileDigest: target.digest, finish: result.finishEvidence });
        queued.resolve(await this.recordAnswer(request, target.directory, 'business', 'work', artifact.answer_id, job.session_key, abort.signal));
      } else {
        const status = result.outcome === 'interrupted' ? 'interrupted' : abort.signal.aborted || result.outcome === 'cancelled' ? 'cancelled' : 'failed';
        this.store.complete(job.task_id, status, result.finalText, result.errorCode);
        this.dispatch.finished(job.task_id, status === 'interrupted'); submitted = false;
        this.requests.transition(request.request_id, scope, ['awaiting_business'], status, result.errorCode);
        await this.recordFailure(request);
        queued.resolve(this.envelope(request));
      }
    } catch (error) {
      if (this.store.get(job.task_id).status === 'succeeded') {
        this.store.db.prepare("UPDATE orchestration_requests SET phase='completed',updated_at=? WHERE request_id=?").run(Date.now(), request.request_id);
      } else {
        const status = error instanceof BackendStateUnknown || submitted ? 'interrupted' : abort.signal.aborted ? 'cancelled' : 'failed';
        this.store.complete(job.task_id, status, `任务未完成（${errorCode(error)}），未自动重跑。`, errorCode(error));
        if (submitted) this.dispatch.finished(job.task_id, true);
        this.store.db.prepare('UPDATE orchestration_requests SET phase=?,failure_code=?,updated_at=? WHERE request_id=?').run(status, errorCode(error), Date.now(), request.request_id);
      }
      await this.recordFailure(request);
      queued.resolve(this.envelope(request));
    } finally {
      clearTimeout(timer); this.activeBackend = undefined; this.queued.delete(job.task_id);
      if (this.store.get(job.task_id).status !== 'interrupted') release?.();
    }
  }
  private async recordAnswer(request: OriginalRequest, directory: Directory | undefined, role: 'bridge' | 'route' | 'business', kind: 'work' | 'history_query' | 'control', answerId: string, sessionKey?: string, signal?: AbortSignal): Promise<JobResultEnvelope> {
    const recap = await this.dependencies.recaps.run(answerId, request.conversation_scope, signal);
    this.store.atomic(() => {
      this.store.db.prepare(`INSERT INTO interaction_records(request_id,conversation_scope,directory_identity,kind,producer_role,answer_id,recap_id,
        referenced_business_session_key,executed_business_session_key,completed_at) VALUES (?,?,?,?,?,?,?,?,?,?)`).run(request.request_id, request.conversation_scope,
        directory ? directoryIdentity({ directory }) : null, kind, role, answerId, recap.recap_id, sessionKey ?? null, role === 'business' ? sessionKey ?? null : null, Date.now());
      this.store.db.prepare("UPDATE orchestration_requests SET phase='completed',updated_at=? WHERE request_id=?").run(Date.now(), request.request_id);
    });
    this.kick();
    return this.envelope(request);
  }
  private controlJob(request: OriginalRequest): Job {
    return this.store.atomic(() => {
      const root = this.requests.get(request.request_id, request.conversation_scope);
      if (root.job_task_id) return this.store.get(root.job_task_id);
      const job = this.store.reserve(this.incoming(root), 'command', undefined, root.request_id).job;
      this.store.db.prepare('UPDATE orchestration_requests SET job_task_id=? WHERE request_id=?').run(job.task_id, root.request_id); return job;
    });
  }
  private async systemAnswer(request: OriginalRequest, text: string, phase: 'completed' | 'failed' | 'cancelled' | 'interrupted' = 'completed', code?: string, resultDelivery = false): Promise<void> {
    invariant(!['completed', 'failed', 'cancelled', 'interrupted'].includes(this.requests.get(request.request_id, request.conversation_scope).phase), 'REQUEST_ALREADY_TERMINAL');
    const job = this.controlJob(request), artifact = this.dependencies.artifacts.stage(request.request_id, 'system', job.task_id, job.session_key);
    this.dependencies.artifacts.capture(artifact.answer_id, text);
    await this.dependencies.artifacts.publish(artifact.answer_id, { backend: 'system', requestId: request.request_id, completed: true, phase,
      outcome: phase === 'completed' ? 'succeeded' : phase === 'interrupted' ? 'failed' : phase, errorCode: code }, () => {
      this.store.completeArtifact(job.task_id, artifact.answer_id, text, phase === 'completed' ? 'succeeded' : phase === 'interrupted' ? 'failed' : phase, code,
        resultDelivery && Buffer.byteLength(text) <= this.c.reply.chunkBytes ? [text] : undefined);
      if (resultDelivery) this.store.db.prepare('UPDATE orchestration_requests SET route_snapshot_json=? WHERE request_id=?').run(JSON.stringify({ controlKind: 'result-delivery' }), request.request_id);
      this.store.db.prepare(`INSERT INTO interaction_records(request_id,conversation_scope,kind,producer_role,answer_id,completed_at)
        VALUES (?,?,?,'system',?,?)`).run(request.request_id, request.conversation_scope, phase === 'completed' ? 'control' : 'failure', artifact.answer_id, Date.now());
      this.store.db.prepare('UPDATE orchestration_requests SET phase=?,failure_code=?,updated_at=? WHERE request_id=?').run(phase, code ?? null, Date.now(), request.request_id);
    });
    if (resultDelivery) { this.kick(); return; } // Never reclassify a page of a long original as a short answer visible to Bridge.
    const pending = (async () => {
      try {
        const recap = await this.dependencies.recaps.run(artifact.answer_id, request.conversation_scope, this.shutdown.signal);
        this.store.db.prepare('UPDATE interaction_records SET recap_id=? WHERE request_id=?').run(recap.recap_id, request.request_id);
      } catch { log('answer.recap_failed', { taskId: request.request_id, code: 'RECAP_FAILED' }); }
    })();
    this.postprocessing.add(pending); void pending.finally(() => this.postprocessing.delete(pending)); this.kick();
  }
  private async controllerAnswer(request: OriginalRequest, directory: Directory | undefined, role: 'bridge' | 'route', actor: ControllerSession, turnId: string, text: string, kind: 'control' | 'history_query'): Promise<JobResultEnvelope> {
    const job = this.controlJob(request), artifact = this.dependencies.artifacts.stage(request.request_id, role, job.task_id, job.session_key);
    this.dependencies.artifacts.capture(artifact.answer_id, text);
    const ref = JSON.parse(actor.native_ref_json!) as { threadId: string };
    await this.dependencies.artifacts.publish(artifact.answer_id, { backend: 'controller', threadId: ref.threadId, turnId, completed: true, callbacksCompleted: true }, () => {
      this.store.completeArtifact(job.task_id, artifact.answer_id, text);
    });
    return this.recordAnswer(request, directory, role, kind, artifact.answer_id);
  }
  private envelope(request: OriginalRequest): JobResultEnvelope {
    const root = this.requests.get(request.request_id, request.conversation_scope);
    const row = this.store.db.prepare(`SELECT i.answer_id,i.executed_business_session_key,a.state,a.short_text FROM interaction_records i
      LEFT JOIN answer_recaps a ON a.recap_id=i.recap_id AND a.answer_id=i.answer_id WHERE i.request_id=? AND i.conversation_scope=?`).get(root.request_id, root.conversation_scope) as Record<string, unknown> | undefined;
    return { requestId: root.request_id, status: root.phase, businessSessionKey: row?.executed_business_session_key as string | undefined,
      answerRef: row?.answer_id as string | undefined, recapState: row?.state as string ?? 'pending', shortText: row?.state === 'ready' ? row.short_text as string : '摘要暂不可用；执行状态见 status。' };
  }
  private async fail(request: OriginalRequest, code: string, cancelled: boolean): Promise<void> {
    const current = this.requests.get(request.request_id, request.conversation_scope);
    if (['completed', 'failed', 'cancelled', 'interrupted'].includes(current.phase)) return;
    if (current.job_task_id && this.store.get(current.job_task_id).status === 'succeeded') {
      this.store.db.prepare("UPDATE orchestration_requests SET phase='completed',updated_at=? WHERE request_id=?").run(Date.now(), request.request_id); return;
    }
    if (current.job_task_id && this.store.get(current.job_task_id).kind === 'agent') {
      const job = this.store.get(current.job_task_id);
      if (['preparing', 'queued', 'cancelled'].includes(job.status)) {
        this.store.complete(job.task_id, cancelled ? 'cancelled' : 'failed', `业务未提交（${code}）。`, code);
        this.store.db.prepare("UPDATE controller_effects SET state='failed',updated_at=? WHERE job_task_id=? AND state='submitted'").run(Date.now(), job.task_id);
        this.store.db.prepare('UPDATE orchestration_requests SET phase=?,failure_code=?,updated_at=? WHERE request_id=?').run(cancelled ? 'cancelled' : 'failed', code, Date.now(), request.request_id);
        await this.recordFailure(request);
        this.queued.get(job.task_id)?.resolve(this.envelope(request)); this.queued.delete(job.task_id); return;
      }
      this.store.cancel(job.task_id); this.aborts.get(request.request_id)?.abort(); return;
    }
    await this.systemAnswer(request, `请求未完成（${code}），未重跑业务。`, cancelled ? 'cancelled' : 'failed', code);
  }
  private async recordFailure(request: OriginalRequest): Promise<void> {
    const current = this.requests.get(request.request_id, request.conversation_scope);
    if (!['failed', 'cancelled', 'interrupted'].includes(current.phase)) return;
    let pending = this.failureNotices.get(current.request_id);
    if (!pending) {
      pending = recordFailureNotice(this.store, this.dependencies.artifacts, this.dependencies.recaps, current)
        .catch(error => { log('answer.failure_notice_unavailable', { taskId: current.request_id, code: errorCode(error) }); })
        .finally(() => { this.failureNotices.delete(current.request_id); });
      this.failureNotices.set(current.request_id, pending);
    }
    await pending;
  }
  private async control(request: OriginalRequest, incoming: Incoming): Promise<void> {
    const [command, ...args] = incoming.text.trim().split(/\s+/); let text: string, rawHistory = false;
    const signal = AbortSignal.any([this.shutdown.signal, ...(this.aborts.get(request.request_id) ? [this.aborts.get(request.request_id)!.signal] : [])]);
    try {
      invariant(incoming.media.length === 0, 'COMMAND_MEDIA_UNSUPPORTED');
      if (command === '/approve' || command === '同意授权') {
        invariant(!args.length, 'COMMAND_ARGUMENTS');
        const maintenance = this.store.value<Maintenance>('maintenance');
        if (maintenance?.phase === 'approval') {
          const job = this.controlJob(request), message = approveMaintenance(this.c, this.store, job);
          this.store.maintenanceAck(job.task_id, message);
          this.store.db.prepare("UPDATE orchestration_requests SET phase='result_processing',updated_at=? WHERE request_id=?").run(Date.now(), request.request_id);
          return;
        }
        this.authority.approve(request.conversation_scope, request.request_id);
        this.schedule(this.requests.get(request.request_id, request.conversation_scope)); return;
      }
      if (command === '/update' || command === '/restart') {
        invariant(!args.length, 'COMMAND_ARGUMENTS'); this.authority.cancelConsent(request.conversation_scope);
        text = proposeMaintenance(this.c, this.store, this.controlJob(request), command === '/update' ? 'update' : 'restart');
      }
      else if (command === '/help') text = '/status /cancel [requestId] /result requestId [part] /debug [requestId] /approve /update /restart\n/route 目录 /alias 简称 /new [目录]\n/sessions [目录] /find 关键词 /read 序号 /resume 序号 /more';
      else if (command === '/new') {
        const state = readConversationState(this.store, request.conversation_scope);
        const directory = this.directory(args.join(' ') || state.activeWorkspace || this.c.workspace.id, request.conversation_scope);
        const target = this.target(directory, request.conversation_scope, undefined, false);
        const job = await this.dependencies.sessions.controlSelect(request, target);
        state.activeWorkspace = directory.id; state.queryFocus = undefined; state.pendingSelection = undefined;
        this.store.put('orchestration:conversation:' + request.conversation_scope, state);
        text = `新会话已准备，下一条工作消息将在该会话执行。\n${directory.path}\n会话：${job.session_key.slice(-12)}`;
      } else if (command === '/sessions' || command === '/find') {
        const state = readConversationState(this.store, request.conversation_scope);
        invariant(command !== '/find' || args.length > 0, 'COMMAND_ARGUMENTS');
        const directory = this.directory(command === '/sessions' && args.length ? args.join(' ') : state.activeWorkspace ?? this.c.workspace.id, request.conversation_scope);
        text = await this.sessionList(request, directory, undefined, command === '/find' ? args.join(' ') : undefined);
      } else if (command === '/read' || command === '/resume') {
        invariant(args.length === 1 && /^[1-9]\d{0,2}$/.test(args[0]!), 'COMMAND_ARGUMENTS');
        const list = this.store.value<SessionListSnapshot>('session-list:' + request.conversation_scope);
        invariant(list && Date.now() < list.expiresAt, 'HISTORY_REFERENCE_EXPIRED');
        const entry = list.entries[Number(args[0]) - 1]; invariant(entry, 'HISTORY_SESSION_UNAVAILABLE');
        const target = this.target(this.authority.catalog(request.conversation_scope).validate(list.directory), request.conversation_scope);
        invariant(target.digest === list.profileDigest, 'PROFILE_CHANGED');
        const candidate = await new HistoryReferences(this.store).get(request.conversation_scope, target, entry.sessionRef);
        const state = readConversationState(this.store, request.conversation_scope);
        if (command === '/resume') {
          const owner = this.store.nativeOwner(candidate.ref), proof = owner ? this.store.value<PiCompletionProof>('pi-completion:' + owner.session_key) : undefined;
          const job = await this.dependencies.sessions.controlSelect(request, target, candidate, signal, proof);
          state.activeWorkspace = target.directory.id; state.queryFocus = undefined;
          text = `已选择历史会话，未提交业务。\n${target.directory.path}\n会话：${job.session_key.slice(-12)}`;
        } else {
          const page = await new NativeReader().readWindow(target, candidate, undefined, signal);
          state.queryFocus = { directoryRef: target.directory.id, sessionRef: entry.sessionRef, requestId: request.request_id };
          this.store.put('history-page:' + request.conversation_scope, { directory: target.directory, profileDigest: target.digest, sessionRef: entry.sessionRef, cursor: page.nextCursor, expiresAt: list.expiresAt });
          text = JSON.stringify(page, null, 2); rawHistory = true;
        }
        this.store.put('orchestration:conversation:' + request.conversation_scope, state);
      } else if (command === '/more') {
        invariant(!args.length, 'COMMAND_ARGUMENTS');
        const page = this.store.value<{ directory: Directory; profileDigest: string; sessionRef: string; cursor?: string; expiresAt: number }>('history-page:' + request.conversation_scope);
        if (page?.cursor) {
          invariant(Date.now() < page.expiresAt, 'HISTORY_REFERENCE_EXPIRED');
          const target = this.target(this.authority.catalog(request.conversation_scope).validate(page.directory), request.conversation_scope);
          invariant(target.digest === page.profileDigest, 'PROFILE_CHANGED');
          const candidate = await new HistoryReferences(this.store).get(request.conversation_scope, target, page.sessionRef);
          const result = await new NativeReader().readWindow(target, candidate, page.cursor, signal);
          this.store.put('history-page:' + request.conversation_scope, { ...page, cursor: result.nextCursor }); text = JSON.stringify(result, null, 2); rawHistory = true;
        } else {
          const list = this.store.value<SessionListSnapshot>('session-list:' + request.conversation_scope);
          invariant(list?.nextCursor && Date.now() < list.expiresAt, 'HISTORY_NO_MORE');
          text = await this.sessionList(request, list.directory, list.nextCursor, list.query);
        }
      }
      else if (command === '/route') {
        invariant(args.length > 0, 'COMMAND_ARGUMENTS');
        const directory = this.directory(args.join(' '), request.conversation_scope), state = readConversationState(this.store, request.conversation_scope);
        state.activeWorkspace = directory.id; this.store.put('orchestration:conversation:' + request.conversation_scope, state);
        text = `已选择目录：${directory.path}`;
      } else if (command === '/alias') {
        invariant(args.length > 0, 'COMMAND_ARGUMENTS');
        const state = readConversationState(this.store, request.conversation_scope); invariant(state.activeWorkspace, 'DIRECTORY_NOT_SELECTED');
        this.authority.alias(request.conversation_scope, request.request_id, args.join(' '), this.directory(state.activeWorkspace, request.conversation_scope)); text = '目录别名已保存。';
      }
      else if (command === '/debug') {
        invariant(args.length <= 1, 'COMMAND_ARGUMENTS');
        text = JSON.stringify(orchestrationDebug(this.store, request.conversation_scope, request.request_id, args[0]), null, 2);
      } else if (command === '/status') {
        invariant(!args.length, 'COMMAND_ARGUMENTS');
        text = JSON.stringify({ blocked: this.store.blocked(), requests: this.store.db.prepare('SELECT request_id,phase,failure_code FROM orchestration_requests WHERE conversation_scope=? ORDER BY ingress_seq DESC LIMIT 10').all(request.conversation_scope) });
      } else if (command === '/cancel') {
        invariant(args.length <= 1 && (!args[0] || /^[0-9a-f-]{8,36}$/.test(args[0])), 'COMMAND_ARGUMENTS');
        const matches = this.store.db.prepare(`SELECT request_id,job_task_id FROM orchestration_requests WHERE conversation_scope=? AND request_id<>?
          AND phase NOT IN ('completed','failed','cancelled','interrupted') ${args[0] ? 'AND request_id LIKE ?' : ''} ORDER BY ingress_seq DESC LIMIT 2`)
          .all(request.conversation_scope, request.request_id, ...(args[0] ? [args[0] + '%'] : [])) as { request_id: string; job_task_id: string | null }[];
        invariant(matches.length > 0 && (!args[0] || matches.length === 1), 'TASK_NOT_FOUND');
        const target = matches[0]!, job = target.job_task_id ? this.store.get(target.job_task_id) : undefined;
        if (job && ['succeeded', 'failed', 'cancelled', 'interrupted', 'timed_out'].includes(job.status)) text = `#${target.request_id.slice(0, 8)} 执行已结束（${job.status}），取消不会撤销已发生的修改。`;
        else {
          this.aborts.get(target.request_id)?.abort();
          const status = target.job_task_id ? this.store.cancel(target.job_task_id) : 'cancelled';
          if (status === 'cancelled') {
            this.store.db.prepare("UPDATE orchestration_requests SET phase='cancelled',updated_at=? WHERE request_id=?").run(Date.now(), target.request_id);
            this.store.db.prepare("UPDATE controller_effects SET state='failed',updated_at=? WHERE job_task_id=? AND state='submitted'").run(Date.now(), target.job_task_id);
            await this.recordFailure(this.requests.get(target.request_id, request.conversation_scope));
            const queued = this.queued.get(target.request_id); if (queued) { queued.resolve(this.envelope(queued.request)); this.queued.delete(target.request_id); }
          }
          text = `#${target.request_id.slice(0, 8)} ${status === 'cancelled' ? '已取消' : '等待执行停止确认'}；已发生的修改不会自动撤销。`;
        }
      } else if (command === '/result') {
        invariant(args.length >= 1 && args.length <= 2 && /^[0-9a-f-]{8,36}$/.test(args[0]!) && (!args[1] || /^[1-9]\d{0,5}$/.test(args[1])), 'COMMAND_ARGUMENTS');
        const rows = this.store.db.prepare(`SELECT a.answer_id,a.request_id FROM answer_artifacts a JOIN orchestration_requests r ON r.request_id=a.request_id
          WHERE r.conversation_scope=? AND r.request_id LIKE ? AND a.kind='final' AND a.state='ready' LIMIT 2`).all(request.conversation_scope, args[0] + '%') as { answer_id: string; request_id: string }[];
        invariant(rows.length === 1, 'RESULT_NOT_READY');
        const raw = await this.dependencies.artifacts.read(rows[0]!.answer_id, { role: 'delivery', scope: request.conversation_scope });
        const part = resultParts(rows[0]!.request_id, raw.toString('utf8'), this.c.reply.chunkBytes)[Number(args[1] ?? 1) - 1]; invariant(part, 'RESULT_PART_INVALID'); text = part;
      } else invariant(false, 'UNSUPPORTED_COMMAND');
      await this.systemAnswer(request, text, 'completed', undefined, command === '/result' || rawHistory);
    } catch (error) {
      this.authority.cancelConsent(request.conversation_scope);
      const maintenance = this.store.value<Maintenance>('maintenance');
      if ((command === '/approve' || command === '同意授权') && maintenance?.phase === 'approval' && maintenance.route === request.route_json)
        this.store.put('maintenance', { ...maintenance, phase: 'failed', code: errorCode(error) });
      await this.fail(request, errorCode(error), false);
    }
  }
  private async sessionList(request: OriginalRequest, directory: Directory, cursor?: string, query?: string): Promise<string> {
    const target = this.target(this.authority.catalog(request.conversation_scope).validate(directory), request.conversation_scope);
    const page = await new HistoryReferences(this.store).list(request.conversation_scope, target, cursor);
    const entries = query ? page.entries.filter(entry => (entry.title + ' ' + entry.nativeId).toLowerCase().includes(query.toLowerCase())) : page.entries;
    this.store.put('session-list:' + request.conversation_scope, { directory, profileDigest: target.digest, entries, expiresAt: Date.now() + 900000, nextCursor: page.nextCursor, query } satisfies SessionListSnapshot);
    this.store.put('history-page:' + request.conversation_scope, null);
    const state = readConversationState(this.store, request.conversation_scope); state.queryFocus = { directoryRef: directory.id, requestId: request.request_id };
    this.store.put('orchestration:conversation:' + request.conversation_scope, state);
    return `${directory.path}\n${entries.map((entry, i) => `${i + 1}. ${entry.title || '(无标题)'} [${entry.nativeId.slice(0, 8)}]`).join('\n') || '本页没有匹配记录。'}\n覆盖：${page.discoveryCoverage}；排序：${page.orderBasis}。${page.nextCursor ? '\n/more 继续发现。' : ''}\n/read 序号 只读；/resume 序号 选择会话。`;
  }
  async idle(): Promise<void> { await this.planning; await Promise.all(this.controls); await Promise.allSettled(this.preparations.values()); while (this.worker) await this.worker; await Promise.allSettled(this.postprocessing); await Promise.allSettled(this.failureNotices.values()); }
  async stop(): Promise<void> {
    this.stopped = true;
    this.shutdown.abort();
    for (const abort of this.aborts.values()) abort.abort();
    for (const [id, queued] of this.queued) {
      const status = this.store.cancel(id);
      if (status === 'cancelled') {
        this.store.db.prepare("UPDATE orchestration_requests SET phase='cancelled',updated_at=? WHERE request_id=?").run(Date.now(), id);
        await this.recordFailure(queued.request);
        queued.resolve(this.envelope(queued.request)); this.queued.delete(id);
      }
    }
    await this.dependencies.controllers.close(); await this.activeBackend?.stop();
    await deadline(this.idle(), this.c.agent.cancelGraceMs + this.c.agent.killGraceMs * 3 + 1000, 'SHUTDOWN_TIMEOUT');
  }
}
