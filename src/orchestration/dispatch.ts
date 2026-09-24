import { randomUUID } from 'node:crypto';
import type { Selection, Store } from '../store.ts';
import type { Job } from '../types.ts';
import { invariant } from '../errors.ts';
import { ControllerRegistry } from './registry.ts';
import { RequestStore, sha256 } from './requests.ts';

export interface EffectBinding { requestId: string; scope: string; controllerId: string; generation: number }
export interface ControllerEffect {
  effect_id: string; request_id: string; controller_id: string; stage: 'bridge' | 'route'; effect_key: string;
  arguments_sha256: string; state: 'planned' | 'submitting' | 'submitted' | 'completed' | 'uncertain' | 'failed';
  job_task_id: string | null; result_json: string | null;
}
export interface PromptAdmission { ordinal: number; at: number; admitted: boolean; textSha256: string }
/** A durable local enqueue is atomic; this is not a claim of remote exactly-once execution. */
export class BusinessDispatch {
  constructor(private store: Store, private registry: ControllerRegistry) {}
  enqueue(binding: EffectBinding, selectionToken: string, selection: Selection, validate: () => void): Job {
    return this.store.atomic(() => {
      const actor = this.registry.fence(binding.controllerId, binding.generation);
      invariant(actor.role === 'route' && actor.conversation_scope === binding.scope &&
        actor.directory_identity === sha256(JSON.stringify([selection.directory.path, selection.directory.identity])), 'DISPATCH_OWNER_MISMATCH');
      const request = new RequestStore(this.store).get(binding.requestId, binding.scope);
      const digest = sha256(selectionToken);
      const existing = this.store.db.prepare("SELECT * FROM controller_effects WHERE request_id=? AND stage='route' AND effect_key='business-submit'").get(binding.requestId) as ControllerEffect | undefined;
      if (existing) {
        invariant(existing.arguments_sha256 === digest, 'EFFECT_ARGUMENT_CONFLICT');
        invariant(existing.state !== 'uncertain' && existing.state !== 'submitting', 'BUSINESS_EXECUTION_UNCERTAIN');
        invariant(existing.job_task_id, 'EFFECT_NOT_SUBMITTED'); return this.store.get(existing.job_task_id);
      }
      invariant(!request.job_task_id && request.phase === 'route_planning', 'DUPLICATE_BUSINESS_SUBMIT');
      validate(); // Recheck token TTL, current identity, grant, profile and native eligibility.
      const effectId = randomUUID(), now = Date.now();
      this.store.db.prepare(`INSERT INTO controller_effects(effect_id,request_id,controller_id,stage,effect_key,arguments_sha256,state,created_at,updated_at)
        VALUES (?,?,?,'route','business-submit',?,'planned',?,?)`).run(effectId, binding.requestId, binding.controllerId, digest, now, now);
      const job = this.store.reserveWithRequest(binding.requestId, binding.scope, selection);
      this.store.db.prepare("UPDATE controller_effects SET state='submitted',job_task_id=?,updated_at=? WHERE effect_id=?").run(job.task_id, Date.now(), effectId);
      return job;
    });
  }
  /** Persist before crossing the backend prompt boundary. Failure after this point forbids resubmission. */
  submitting(jobTaskId: string): void {
    invariant(this.store.db.prepare("UPDATE controller_effects SET state='submitting',updated_at=? WHERE job_task_id=? AND state='submitted'")
      .run(Date.now(), jobTaskId).changes === 1, 'BUSINESS_EXECUTION_UNCERTAIN');
  }
  admitPrompt(jobTaskId: string, textSha256: string): void {
    const effect = this.store.db.prepare("SELECT request_id,state FROM controller_effects WHERE job_task_id=? AND effect_key='business-submit'").get(jobTaskId) as { request_id: string; state: string } | undefined;
    invariant(effect?.request_id === jobTaskId && effect.state === 'submitting' && this.store.get(jobTaskId).status === 'running', 'BUSINESS_PROMPT_NOT_READY');
    const key = 'business-prompt-admissions:' + jobTaskId, previous = this.store.value<PromptAdmission[]>(key) ?? [];
    invariant(previous.length < 16, 'BUSINESS_PROMPT_AUDIT_LIMIT');
    const admitted = previous.length === 0 && !this.store.value('business-wire:' + jobTaskId);
    // Keep denied attempts too. Throwing after this write must not erase evidence.
    this.store.put(key, [...previous, { ordinal: previous.length + 1, at: Date.now(), admitted, textSha256 }]);
    invariant(admitted, 'BUSINESS_PROMPT_ALREADY_SUBMITTED');
  }
  finished(jobTaskId: string, uncertain: boolean): void {
    invariant(this.store.db.prepare("UPDATE controller_effects SET state=?,updated_at=? WHERE job_task_id=? AND state='submitting'")
      .run(uncertain ? 'uncertain' : 'completed', Date.now(), jobTaskId).changes === 1, 'EFFECT_STATE_CONFLICT');
  }
  recover(): void {
    // Never turn a possibly submitted prompt into a fresh queue entry.
    this.store.db.prepare("UPDATE controller_effects SET state='uncertain',updated_at=? WHERE state='submitting'").run(Date.now());
  }
}
