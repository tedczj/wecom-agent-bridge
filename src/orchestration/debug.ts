import type { Store } from '../store.ts';
import type { NormalizedInput } from '../types.ts';
import { invariant } from '../errors.ts';
import type { ToolAuditRecord } from './audit.ts';

/** Scope-bound diagnostics use persisted metadata only; no model call or native history scan. */
export function orchestrationDebug(store: Store, scope: string, currentRequestId: string, prefix?: string): unknown {
  invariant(prefix === undefined || /^[0-9a-f-]{8,36}$/.test(prefix), 'COMMAND_ARGUMENTS');
  const rows = store.db.prepare(`SELECT r.request_id,r.phase,r.failure_code,r.received_at,r.updated_at,r.source_request_id,
    j.kind,j.status,j.error_code,j.started_at,j.finished_at,j.input_json FROM orchestration_requests r LEFT JOIN jobs j ON j.task_id=r.job_task_id
    WHERE r.conversation_scope=? AND r.request_id<>? ${prefix ? 'AND r.request_id LIKE ?' : ''} ORDER BY r.ingress_seq DESC LIMIT ?`)
    .all(scope, currentRequestId, ...(prefix ? [prefix + '%'] : []), prefix ? 2 : 6) as Array<Record<string, unknown>>;
  if (prefix) invariant(rows.length === 1, rows.length ? 'TASK_ID_AMBIGUOUS' : 'TASK_NOT_FOUND');
  return { blocked: store.blocked(), requests: rows.map(row => {
    const id = row.request_id as string, input = row.input_json ? JSON.parse(row.input_json as string) as NormalizedInput : undefined;
    const audit = store.value<ToolAuditRecord[]>('tool-audit:' + id) ?? [];
    return { requestId: id, sourceRequestId: row.source_request_id, phase: row.phase, failureCode: row.failure_code,
      receivedAt: row.received_at, updatedAt: row.updated_at,
      job: row.kind ? { kind: row.kind, status: row.status, code: row.error_code, startedAt: row.started_at, finishedAt: row.finished_at } : null,
      execution: input?.routing ? { workspace: input.workspaceId, profileDigest: input.routing.digest, model: input.routing.execution,
        modelSources: input.routing.modelSources, selection: input.routing.reason } : null,
      effects: store.db.prepare('SELECT stage,effect_key,state,updated_at FROM controller_effects WHERE request_id=? ORDER BY stage,effect_key').all(id),
      answers: store.db.prepare(`SELECT a.answer_id,a.producer_role,a.kind,a.state,a.completeness,a.sha256,a.bytes,
        r.state recap_state,r.source recap_source,r.failure_code recap_failure FROM answer_artifacts a LEFT JOIN answer_recaps r ON r.answer_id=a.answer_id
        WHERE a.request_id=? ORDER BY a.created_at`).all(id),
      deliveries: store.db.prepare('SELECT state,count(*) count FROM outbox WHERE task_id=? GROUP BY state').all(id),
      tools: audit.map(entry => ({ seq: entry.seq, role: entry.role, tool: entry.tool, status: entry.status, code: entry.code })) };
  }) };
}
