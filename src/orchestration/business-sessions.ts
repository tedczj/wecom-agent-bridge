import { randomUUID } from 'node:crypto';
import type { Selection, Store } from '../store.ts';
import type { Job, SessionRef } from '../types.ts';
import type { Target } from '../routing/catalog.ts';
import { baseKey } from '../local.ts';
import { invariant, errorCode, BridgeError } from '../errors.ts';
import { NativeCatalog, backendHomeKey, directoryIdentity, type CandidateMetadata } from '../history/catalog.ts';
import { ResumeVerifier, type ResumeCheck, type PiCompletionProof } from '../history/verifier.ts';
import { ControllerRegistry } from './registry.ts';
import { RequestStore, sha256, type OriginalRequest } from './requests.ts';
import type { EffectBinding } from './dispatch.ts';

interface Binding { session_key: string; version: number; profile_digest: string; selection_request_id: string | null }
interface Option {
  token: string; kind: 'new' | 'resume'; reason: string; isDefault: boolean;
  sessionKey?: string; ref?: SessionRef; lastResponseAt?: number | null; candidate?: CandidateMetadata;
}
interface Snapshot {
  scope: string; requestId: string; controllerId: string; generation: number; directoryIdentity: string; profileDigest: string;
  homeKey: string; expiresAt: number; bindingVersion: number | null; options: Option[];
}
export interface SessionOptions {
  options: Array<{ optionToken: string; kind: 'new' | 'resume'; reason: string; isDefault: boolean; nativeId?: string; lastResponseAt?: number | null }>;
  needsClarification: boolean; discoveryCoverage?: string; orderBasis?: string; nextCursor?: string;
}
export interface SelectedBusiness {
  token: string; snapshot: Snapshot; option: Option; selection: Selection; check?: ResumeCheck;
}

export class BusinessSessions {
  constructor(private store: Store, private registry: ControllerRegistry, private verifier: ResumeVerifier, private now = Date.now) {}
  private fence(binding: EffectBinding, target: Target): void {
    const actor = this.registry.fence(binding.controllerId, binding.generation);
    invariant(actor.role === 'route' && actor.conversation_scope === binding.scope && actor.directory_identity === directoryIdentity(target), 'SESSION_OPTION_OWNER');
    new RequestStore(this.store).get(binding.requestId, binding.scope);
    invariant(!this.store.blocked(), 'WORKSPACE_BLOCKED');
  }
  private bound(scope: string, target: Target): Binding | undefined {
    return this.store.db.prepare('SELECT session_key,version,profile_digest,selection_request_id FROM business_bindings WHERE conversation_scope=? AND directory_identity=? AND backend_home_key=? AND profile_digest=?')
      .get(scope, directoryIdentity(target), backendHomeKey(target), target.digest) as Binding | undefined;
  }
  async resolve(binding: EffectBinding, target: Target, intent: 'automatic' | 'new' = 'automatic', explicitCandidate?: CandidateMetadata): Promise<SessionOptions> {
    this.fence(binding, target);
    this.assertNoResumeFailure(binding.requestId);
    invariant(!this.store.value('discovery-unverified:' + binding.requestId), 'HISTORY_DISCOVERY_UNVERIFIED');
    invariant(this.requestsOpen(binding), 'BUSINESS_ALREADY_SELECTED');
    const bound = this.bound(binding.scope, target), now = this.now(), options: Option[] = [{ token: randomUUID(), kind: 'new', reason: 'explicit-new', isDefault: false }];
    let discoveryCoverage: string | undefined, orderBasis: string | undefined, nextCursor: string | undefined;
    if (bound) invariant(this.store.session(bound.session_key).state !== 'tainted', 'SESSION_TAINTED');
    if (explicitCandidate) {
      invariant(intent !== 'new', 'SESSION_INTENT_CONFLICT');
      const owner = this.store.nativeOwner(explicitCandidate.ref);
      options.push({ token: randomUUID(), kind: 'resume', reason: 'explicit-resume', isDefault: true, ref: explicitCandidate.ref,
        sessionKey: owner?.session_key, candidate: explicitCandidate, lastResponseAt: explicitCandidate.lastCompletedAt });
    } else if (intent === 'new') options[0]!.isDefault = true;
    else if (bound) {
      const session = this.store.session(bound.session_key);
      invariant(session.state !== 'tainted', 'SESSION_TAINTED');
      const busy = this.store.busy(session.session_key) || session.state === 'new';
      const ref = session.agent_ref_json ? JSON.parse(session.agent_ref_json) as SessionRef : undefined;
      const age = session.last_response_at === null ? null : now - session.last_response_at;
      if (busy || age !== null && age >= 0 && age <= 24 * 60 * 60 * 1000) {
        options.push({ token: randomUUID(), kind: 'resume', reason: busy ? 'binding-pending' : 'binding', isDefault: true, sessionKey: session.session_key, ref, lastResponseAt: session.last_response_at });
      } else {
        if (age !== null && age > 24 * 60 * 60 * 1000) options.push({ token: randomUUID(), kind: 'new', reason: 'binding-expired', isDefault: true });
        if (ref) options.push({ token: randomUUID(), kind: 'resume', reason: 'explicit-resume', isDefault: false, sessionKey: session.session_key, ref, lastResponseAt: session.last_response_at });
      }
    } else {
      const changed = this.store.db.prepare('SELECT 1 FROM business_bindings WHERE conversation_scope=? AND directory_identity=? LIMIT 1').get(binding.scope, directoryIdentity(target));
      if (changed) options.push({ token: randomUUID(), kind: 'new', reason: 'profile-changed', isDefault: true });
      else {
        const page = await new NativeCatalog(this.store, binding.scope).listMetadata(target);
        discoveryCoverage = page.discoveryCoverage; orderBasis = page.orderBasis; nextCursor = page.nextCursor;
        // A complete singleton has no competing candidate order to establish.
        // Verify that exact target only; never scan unrelated transcript bodies.
        if (page.discoveryCoverage === 'complete' && page.entries.length === 1 && page.entries[0]!.lastCompletedAt === null) {
          const candidate = page.entries[0]!;
          try {
            const check = await this.verifier.verify(target, candidate, target.digest);
            new NativeCatalog(this.store, binding.scope).recordVerified(target, candidate, check);
            candidate.lastCompletedAt = check.lastCompletedAt; orderBasis = check.lastCompletedAt === null ? page.orderBasis : 'last-completed-response';
          } catch (error) { this.refuseResume(binding.requestId, target, candidate.ref, error); }
        }
        if (!page.entries.length && page.discoveryCoverage === 'complete') options.push({ token: randomUUID(), kind: 'new', reason: 'no-history', isDefault: true });
        const orderKnown = page.discoveryCoverage === 'complete' && page.entries.length > 0 && page.entries.every(entry => entry.lastCompletedAt !== null && entry.lastCompletedAt <= now);
        if (page.discoveryCoverage !== 'complete' || page.entries.length > 0 && !orderKnown)
          this.store.put('discovery-unverified:' + binding.requestId, { coverage: page.discoveryCoverage, orderBasis, nextCursor });
        const entries = [...page.entries].sort((a, b) => (b.lastCompletedAt ?? 0) - (a.lastCompletedAt ?? 0));
        for (const [index, candidate] of entries.entries()) options.push({ token: randomUUID(), kind: 'resume', reason: 'native-explicit',
          isDefault: orderKnown && index === 0 && now - candidate.lastCompletedAt! <= 24 * 60 * 60 * 1000,
          ref: candidate.ref, lastResponseAt: candidate.lastCompletedAt, candidate });
        if (orderKnown && now - entries[0]!.lastCompletedAt! > 24 * 60 * 60 * 1000) options.push({ token: randomUUID(), kind: 'new', reason: 'native-expired', isDefault: true });
      }
    }
    this.fence(binding, target);
    const snapshot: Snapshot = { scope: binding.scope, requestId: binding.requestId, controllerId: binding.controllerId, generation: binding.generation,
      directoryIdentity: directoryIdentity(target), profileDigest: target.digest, homeKey: backendHomeKey(target), expiresAt: now + 15 * 60 * 1000, bindingVersion: bound?.version ?? null, options };
    this.store.put('business-options:' + binding.requestId, snapshot);
    return { options: options.map(option => ({ optionToken: option.token, kind: option.kind, reason: option.reason, isDefault: option.isDefault,
      nativeId: option.ref?.kind === 'codex' ? option.ref.threadId : option.ref?.sessionId, lastResponseAt: option.lastResponseAt })),
      needsClarification: !options.some(option => option.isDefault), discoveryCoverage, orderBasis, nextCursor };
  }
  private snapshot(binding: EffectBinding, target: Target): Snapshot {
    this.fence(binding, target);
    this.assertNoResumeFailure(binding.requestId);
    invariant(!this.store.value('discovery-unverified:' + binding.requestId), 'HISTORY_DISCOVERY_UNVERIFIED');
    const snapshot = this.store.value<Snapshot>('business-options:' + binding.requestId);
    invariant(snapshot && snapshot.scope === binding.scope && snapshot.controllerId === binding.controllerId && snapshot.generation === binding.generation &&
      snapshot.directoryIdentity === directoryIdentity(target) && snapshot.profileDigest === target.digest && snapshot.homeKey === backendHomeKey(target) && this.now() < snapshot.expiresAt, 'SESSION_OPTION_EXPIRED');
    invariant((this.bound(binding.scope, target)?.version ?? null) === snapshot.bindingVersion, 'SESSION_BINDING_CHANGED');
    return snapshot;
  }
  async select(binding: EffectBinding, target: Target, optionToken: string, signal?: AbortSignal, piProof?: PiCompletionProof): Promise<SelectedBusiness> {
    invariant(this.requestsOpen(binding), 'BUSINESS_ALREADY_SELECTED');
    const snapshot = this.snapshot(binding, target); let option = snapshot.options.find(option => option.token === optionToken);
    invariant(option, 'SESSION_OPTION_INVALID');
    invariant(option.isDefault, 'SESSION_EXPLICIT_CHOICE_REQUIRED');
    let candidate = option.candidate, check: ResumeCheck | undefined;
    if (option.ref && option.reason !== 'binding-pending') {
      try {
        const fresh = await new NativeCatalog(this.store, binding.scope).locateExact(target, option.ref);
        invariant(!candidate || fresh.sourceRevision === candidate.sourceRevision, 'SESSION_OPTION_EXPIRED');
        candidate = fresh; check = await this.verifier.verify(target, candidate, target.digest, signal, piProof);
        new NativeCatalog(this.store, binding.scope).recordVerified(target, candidate, check);
      } catch (error) {
        if (option.reason !== 'binding' || errorCode(error) !== 'HISTORY_EXACT_NOT_FOUND') {
          this.refuseResume(binding.requestId, target, option.ref, error);
        }
        option = { token: option.token, kind: 'new', reason: 'missing-before-prompt', isDefault: true };
        candidate = undefined;
      }
    }
    this.snapshot(binding, target);
    invariant(this.requestsOpen(binding), 'BUSINESS_ALREADY_SELECTED');
    const selection: Selection = { config: target.config, digest: target.digest, directory: target.directory, reason: option.reason,
      modelSource: target.modelSource, modelSources: target.modelSources, modelProfile: target.modelProfile,
      execution: target.execution, bind: false, fresh: option.kind === 'new', sessionKey: option.sessionKey,
      ref: option.sessionKey ? undefined : option.ref, lastResponseAt: check?.lastCompletedAt ?? option.lastResponseAt };
    const selected: SelectedBusiness = { token: randomUUID(), snapshot, option: { ...option, candidate }, selection, check };
    // Only serializable authority is persisted; target config may contain private credentials and stays in memory.
    this.store.put('business-selection:' + binding.requestId, { token: selected.token, snapshot, option: selected.option, check });
    return selected;
  }
  private requestsOpen(binding: EffectBinding): boolean {
    const request = new RequestStore(this.store).get(binding.requestId, binding.scope);
    return request.phase === 'route_planning' && request.job_task_id === null;
  }
  /** A model cannot turn a failed resume into fresh execution in the same request. */
  assertNoResumeFailure(requestId: string): void {
    const refusal = this.store.value<{ code: string }>('resume-refusal:' + requestId);
    if (refusal) throw new BridgeError(refusal.code);
  }
  refuseResume(requestId: string, target: Target, reference: SessionRef | string, error: unknown): never {
    this.store.put('resume-refusal:' + requestId, { code: errorCode(error, 'HISTORY_UNVERIFIED'),
      ...(typeof reference === 'string' ? { historyReferenceSha256: sha256(reference) } : { nativeRefSha256: sha256(JSON.stringify(reference)) }),
      directoryIdentity: directoryIdentity(target) });
    throw error;
  }
  async controlSelect(request: OriginalRequest, target: Target, candidate?: CandidateMetadata, signal?: AbortSignal, piProof?: PiCompletionProof): Promise<Job> {
    invariant(request.phase === 'accepted' && !request.job_task_id && !this.store.blocked(), 'SESSION_CONTROL_STATE');
    const prior = this.bound(request.conversation_scope, target);
    if (prior) invariant(this.store.session(prior.session_key).state !== 'tainted', 'SESSION_TAINTED');
    const owner = candidate ? this.store.nativeOwner(candidate.ref) : undefined;
    if (owner) invariant(owner.state !== 'tainted', 'SESSION_TAINTED');
    const check = candidate ? await this.verifier.verify(target, candidate, target.digest, signal, piProof) : undefined;
    if (candidate && check) new NativeCatalog(this.store, request.conversation_scope).recordVerified(target, candidate, check);
    return this.store.atomic(() => {
      const current = new RequestStore(this.store).get(request.request_id, request.conversation_scope);
      invariant(current.phase === 'accepted' && !current.job_task_id && !this.store.blocked(), 'SESSION_CONTROL_STATE');
      invariant((this.bound(request.conversation_scope, target)?.version ?? null) === (prior?.version ?? null), 'SESSION_BINDING_CHANGED');
      const message = this.store.db.prepare('SELECT message_id FROM orchestration_requests WHERE request_id=?').get(request.request_id) as { message_id: string };
      const selection: Selection = { ...target, reason: candidate ? 'explicit-resume' : 'explicit-new', bind: false,
        fresh: !owner, sessionKey: owner?.session_key, ref: owner ? undefined : candidate?.ref, lastResponseAt: check?.lastCompletedAt };
      const job = this.store.reserve({ messageId: message.message_id, reqId: request.request_id, route: JSON.parse(request.route_json),
        text: request.raw_query, media: [], receivedAt: request.received_at }, 'command', selection, request.request_id).job;
      this.store.db.prepare('UPDATE orchestration_requests SET job_task_id=? WHERE request_id=?').run(job.task_id, request.request_id);
      this.store.db.prepare(`INSERT INTO business_bindings(conversation_scope,directory_identity,backend_home_key,profile_digest,session_key,selection_source,selection_request_id,version,updated_at)
        VALUES (?,?,?,?,?,?,?,1,?) ON CONFLICT(conversation_scope,directory_identity,backend_home_key,profile_digest)
        DO UPDATE SET session_key=excluded.session_key,selection_source=excluded.selection_source,selection_request_id=excluded.selection_request_id,version=business_bindings.version+1,updated_at=excluded.updated_at`)
        .run(request.conversation_scope, directoryIdentity(target), backendHomeKey(target), target.digest, job.session_key, selection.reason, request.request_id, this.now());
      return job;
    });
  }
  validate(binding: EffectBinding, target: Target, selected: SelectedBusiness): void {
    const snapshot = this.snapshot(binding, target), saved = this.store.value<{ token: string }>('business-selection:' + binding.requestId);
    invariant(saved?.token === selected.token && snapshot.options.some(option => option.token === selected.option.token), 'SESSION_SELECTION_INVALID');
  }
  bind(binding: EffectBinding, target: Target, selected: SelectedBusiness, job: Job): void {
    this.store.atomic(() => {
      this.fence(binding, target);
      const existing = this.bound(binding.scope, target);
      if (existing?.selection_request_id === binding.requestId && existing.session_key === job.session_key &&
        this.store.value<{ token: string }>('business-selection:' + binding.requestId)?.token === selected.token) return;
      this.validate(binding, target, selected);
      const request = new RequestStore(this.store).get(binding.requestId, binding.scope), session = this.store.session(job.session_key);
      invariant(request.job_task_id === job.task_id && session.base_key === baseKey(JSON.parse(request.route_json), target.directory.id, target.digest), 'SESSION_OWNER_MISMATCH');
      const values = [binding.scope, directoryIdentity(target), backendHomeKey(target), target.digest];
      if (selected.snapshot.bindingVersion === null) this.store.db.prepare(`INSERT INTO business_bindings(conversation_scope,directory_identity,backend_home_key,profile_digest,
        session_key,selection_source,selection_request_id,version,updated_at) VALUES (?,?,?,?,?,?,?,1,?)`).run(...values, session.session_key, selected.option.reason, binding.requestId, this.now());
      else invariant(this.store.db.prepare(`UPDATE business_bindings SET session_key=?,selection_source=?,selection_request_id=?,version=version+1,updated_at=?
        WHERE conversation_scope=? AND directory_identity=? AND backend_home_key=? AND profile_digest=? AND version=?`)
        .run(session.session_key, selected.option.reason, binding.requestId, this.now(), ...values, selected.snapshot.bindingVersion).changes === 1, 'SESSION_BINDING_CHANGED');
    });
  }
  async beforePrompt(target: Target, job: Job, selected: SelectedBusiness, signal?: AbortSignal, piProof?: PiCompletionProof): Promise<void> {
    invariant(target.digest === selected.snapshot.profileDigest && directoryIdentity(target) === selected.snapshot.directoryIdentity && backendHomeKey(target) === selected.snapshot.homeKey, 'PROFILE_CHANGED');
    const session = this.store.session(job.session_key); invariant(session.state !== 'tainted' && !this.store.blocked(), 'SESSION_TAINTED');
    if (!session.agent_ref_json) { invariant(session.state === 'new', 'SESSION_REF_MISSING'); return; }
    const ref = JSON.parse(session.agent_ref_json) as SessionRef;
    if (selected.option.ref) invariant(JSON.stringify(ref) === JSON.stringify(selected.option.ref), 'SESSION_RESTORE_MISMATCH');
    const candidate = await new NativeCatalog(this.store, selected.snapshot.scope).locateExact(target, ref);
    if (selected.check) await this.verifier.revalidate(target, candidate, selected.check, signal);
    else {
      const check = await this.verifier.verify(target, candidate, target.digest, signal, piProof);
      new NativeCatalog(this.store, selected.snapshot.scope).recordVerified(target, candidate, check);
    }
  }
}
