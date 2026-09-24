import type { Config } from '../config.ts';
import type { Store } from '../store.ts';
import type { Maintenance } from '../maintenance.ts';
import { invariant } from '../errors.ts';
import { ArtifactStore, type ArtifactFinishEvidence } from '../answers/artifact-store.ts';
import { RecapService } from '../answers/recap.ts';
import { modelDigest } from './config.ts';

/** The supervisor commits the original and outbox once; recovery never repeats the maintenance operation. */
export async function finishHierarchicalMaintenance(c: Config, store: Store, m: Maintenance, code?: string): Promise<void> {
  invariant(c.orchestration && c.models, 'HIERARCHICAL_CONFIG_REQUIRED');
  const request = store.db.prepare('SELECT conversation_scope,route_json,job_task_id FROM orchestration_requests WHERE request_id=?').get(m.taskId) as
    { conversation_scope: string; route_json: string; job_task_id: string } | undefined;
  const current = store.value<Maintenance>('maintenance');
  invariant(request?.job_task_id === m.taskId && request.route_json === m.route && current?.taskId === m.taskId &&
    current.action === m.action && current.supervisorToken === m.supervisorToken, 'MAINTENANCE_RESULT_OWNER');
  const job = store.get(m.taskId); invariant(job.kind === 'command', 'MAINTENANCE_RESULT_OWNER');
  const artifacts = new ArtifactStore(store, c.orchestration.answers.root, c.orchestration.answers.maxOriginalBytes);
  let artifact = store.db.prepare("SELECT answer_id FROM answer_artifacts WHERE request_id=? AND producer_role='system' AND job_task_id=? AND kind='final' AND state='ready'")
    .get(m.taskId, m.taskId) as { answer_id: string } | undefined;
  const commit = (id: string, text: string) => {
    const evidence = JSON.parse(artifacts.get(id).finish_evidence_json!) as ArtifactFinishEvidence;
    invariant(evidence.backend === 'system' && evidence.requestId === m.taskId && ['succeeded', 'failed'].includes(evidence.outcome), 'MAINTENANCE_RESULT_EVIDENCE');
    invariant(store.completeArtifact(m.taskId, id, text, evidence.outcome, evidence.errorCode, undefined, 'maintenance-final'), 'MAINTENANCE_RESULT_CONFLICT');
    store.put('maintenance', { ...m, phase: evidence.outcome, code: evidence.errorCode });
    store.db.prepare('UPDATE orchestration_requests SET phase=?,failure_code=?,updated_at=? WHERE request_id=?')
      .run(evidence.phase, evidence.errorCode ?? null, store.get(m.taskId).finished_at, m.taskId);
  };
  if (!artifact) {
    invariant(job.status === 'queued', 'MAINTENANCE_RESULT_CONFLICT');
    const staging = store.db.prepare("SELECT answer_id FROM answer_artifacts WHERE request_id=? AND producer_role='system' AND job_task_id=? AND state='staging' AND finish_evidence_json IS NOT NULL ORDER BY created_at LIMIT 1")
      .get(m.taskId, m.taskId) as { answer_id: string } | undefined;
    if (staging) artifact = await artifacts.recover(staging.answer_id, text => commit(staging.answer_id, text));
    else {
      const message = code ? `服务管理未完成（${code}），未自动重试。${m.action === 'update' ? '源码可能已拉取；原运行产物已保留，未重放工作任务。' : ''}` :
        `${m.action === 'update' ? '更新检查通过，' : '重启完成，'}桥接服务已恢复。${m.newHead ? '\n运行版本：' + m.newHead.slice(0, 12) : ''}`;
      artifact = artifacts.stage(m.taskId, 'system', m.taskId, job.session_key); artifacts.capture(artifact.answer_id, message);
      const id = artifact.answer_id;
      await artifacts.publish(id, { backend: 'system', requestId: m.taskId, completed: true, phase: code ? 'failed' : 'completed',
        outcome: code ? 'failed' : 'succeeded', errorCode: code }, () => commit(id, message));
    }
  }
  // The stable supervisor performs no model calls. Over-budget notices keep their original and a failed recap.
  const profile = c.models[c.orchestration.answers.recapModelProfile]!;
  const recaps = new RecapService(store, artifacts, undefined, modelDigest(profile), c.orchestration.answers.shortAnswerMaxChars, c.orchestration.answers.recapMaxChars);
  const recap = await recaps.run(artifact.answer_id, request.conversation_scope), terminal = store.get(m.taskId);
  store.db.prepare(`INSERT INTO interaction_records(request_id,conversation_scope,kind,producer_role,answer_id,recap_id,completed_at)
    VALUES (?,?,?,'system',?,?,?) ON CONFLICT(request_id) DO UPDATE SET recap_id=excluded.recap_id`)
    .run(m.taskId, request.conversation_scope, terminal.status === 'succeeded' ? 'control' : 'failure', artifact.answer_id, recap.recap_id, terminal.finished_at);
}
