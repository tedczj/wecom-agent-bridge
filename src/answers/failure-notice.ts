import type { Store } from '../store.ts';
import type { NormalizedInput } from '../types.ts';
import type { OriginalRequest } from '../orchestration/requests.ts';
import { directoryIdentity } from '../history/catalog.ts';
import { invariant } from '../errors.ts';
import { ArtifactStore } from './artifact-store.ts';
import { RecapService } from './recap.ts';

/** A host outcome notice is distinct from an unverified business draft; it never changes the job or sends again. */
export async function recordFailureNotice(store: Store, artifacts: ArtifactStore, recaps: RecapService, request: OriginalRequest): Promise<void> {
  invariant(['failed', 'cancelled', 'interrupted'].includes(request.phase), 'FAILURE_NOTICE_PHASE');
  if (store.db.prepare('SELECT 1 FROM interaction_records WHERE request_id=?').get(request.request_id)) return;
  const job = request.job_task_id ? store.get(request.job_task_id) : undefined;
  invariant(!job || ['failed', 'cancelled', 'timed_out', 'interrupted'].includes(job.status), 'FAILURE_NOTICE_JOB');
  const input = job ? JSON.parse(job.input_json) as NormalizedInput : undefined;
  const state = store.db.prepare('SELECT failure_code,updated_at FROM orchestration_requests WHERE request_id=?').get(request.request_id) as { failure_code: string | null; updated_at: number };
  const code = state.failure_code ?? job?.error_code;
  const text = `请求未完成。状态：${request.phase}${code ? `（${code}）` : ''}。\n未自动重跑；已发生的修改不会自动撤销。${request.phase === 'interrupted' ? '停止或执行结果不确定，需检查后恢复。' : ''}`;
  let artifact = store.db.prepare("SELECT answer_id FROM answer_artifacts WHERE request_id=? AND producer_role='system' AND kind='final' AND state='ready'").get(request.request_id) as { answer_id: string } | undefined;
  if (!artifact) {
    const staging = store.db.prepare("SELECT answer_id FROM answer_artifacts WHERE request_id=? AND producer_role='system' AND job_task_id IS NULL AND state='staging' AND finish_evidence_json IS NOT NULL ORDER BY created_at LIMIT 1").get(request.request_id) as { answer_id: string } | undefined;
    if (staging) artifact = await artifacts.recover(staging.answer_id, () => {});
    else {
      artifact = artifacts.stage(request.request_id, 'system', undefined, job?.kind === 'agent' ? job.session_key : undefined);
      artifacts.capture(artifact.answer_id, text);
      await artifacts.publish(artifact.answer_id, { backend: 'system', requestId: request.request_id, completed: true,
        phase: request.phase as 'failed' | 'cancelled' | 'interrupted', outcome: request.phase === 'cancelled' ? 'cancelled' : 'failed', errorCode: code ?? undefined }, () => {});
    }
  }
  const recap = await recaps.run(artifact.answer_id, request.conversation_scope);
  store.atomic(() => {
    store.db.prepare(`INSERT OR IGNORE INTO interaction_records(request_id,conversation_scope,directory_identity,kind,producer_role,answer_id,recap_id,
      referenced_business_session_key,executed_business_session_key,completed_at) VALUES (?,?,?,'failure','system',?,?,?,?,?)`).run(request.request_id, request.conversation_scope,
      input?.routing ? directoryIdentity({ directory: input.routing.directory }) : null, artifact.answer_id, recap.recap_id,
      job?.kind === 'agent' ? job.session_key : null, job?.kind === 'agent' && job.started_at ? job.session_key : null, job?.finished_at ?? state.updated_at);
    store.db.prepare("UPDATE answer_artifacts SET state='failed',kind='partial',completeness='unknown' WHERE request_id=? AND producer_role='business' AND state='staging' AND finish_evidence_json IS NULL").run(request.request_id);
  });
}
