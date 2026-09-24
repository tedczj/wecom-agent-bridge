import type { Store } from '../../src/store.ts';
import type { PromptAdmission } from '../../src/orchestration/dispatch.ts';

/** Host submission evidence only; no claim of provider-side exactly-once execution. */
export function replayEvidence(store: Store, requestIds: string[]): { complete: boolean; pass: boolean; actual: unknown } {
  const rows = requestIds.map(id => {
    const root = store.db.prepare('SELECT job_task_id,phase FROM orchestration_requests WHERE request_id=?').get(id);
    const effects = store.db.prepare("SELECT state,job_task_id FROM controller_effects WHERE request_id=? AND effect_key='business-submit'").all(id);
    const admissions = store.value<PromptAdmission[]>('business-prompt-admissions:' + id);
    const wire = store.value<{ textSha256: string }>('business-wire:' + id);
    const accepted = admissions?.filter(row => row.admitted) ?? [];
    const complete = !!root && !!admissions && !!admissions.length;
    const uncertain = effects.some(row => row.state === 'uncertain');
    const pass = complete && effects.length === 1 && root!.job_task_id === id && effects[0]!.job_task_id === id &&
      accepted.length <= 1 && (!wire || accepted.length === 1 && accepted[0]!.textSha256 === wire.textSha256) &&
      (!uncertain || root!.phase === 'interrupted' && store.blocked());
    return { requestId: id, complete, pass, uncertain, phase: root?.phase, effects, admissions, wireObserved: !!wire };
  });
  return { complete: rows.length > 0 && rows.every(row => row.complete), pass: rows.length > 0 && rows.every(row => row.pass),
    actual: { basis: 'host prompt admissions and durable effects; no remote exactly-once claim', uncertaintyExercised: rows.some(row => row.uncertain), requests: rows } };
}
