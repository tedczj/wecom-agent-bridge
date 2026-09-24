import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { setup, fixture } from '../helpers.ts';
import { parseConfig } from '../../src/config.ts';
import { normalize } from '../../src/local.ts';
import { migrateV4 } from '../../src/migrations/v4.ts';
import { RequestStore } from '../../src/orchestration/requests.ts';
import { ArtifactStore } from '../../src/answers/artifact-store.ts';
import { listInteractions } from '../../src/answers/projection.ts';
import { finishHierarchicalMaintenance } from '../../src/orchestration/maintenance-result.ts';
import type { Maintenance } from '../../src/maintenance.ts';

function prepared(t: Parameters<typeof setup>[0]) {
  const f = setup(t), e = JSON.parse(readFileSync('docs/plans/three-layer-agent-bridge/config.hierarchical.example.json', 'utf8'));
  e.orchestration.answers.root = path.join(f.c.stateRoot, 'artifacts');
  e.orchestration.controllerRuntime.workRoot = path.join(f.c.stateRoot, 'controllers');
  const c = parseConfig({ ...f.c, models: e.models, orchestration: e.orchestration });
  const store = f.store(); migrateV4(store);
  const incoming = normalize(fixture('/approve'), c, 'local:codex'), requests = new RequestStore(store), request = requests.accept(incoming).request;
  const job = store.reserve(incoming, 'command', undefined, request.request_id).job;
  store.db.prepare("UPDATE orchestration_requests SET job_task_id=?,phase='result_processing' WHERE request_id=?").run(job.task_id, request.request_id);
  const m: Maintenance = { action: 'restart', phase: 'starting', taskId: job.task_id, requestTaskId: job.task_id,
    route: job.route_json, at: Date.now(), supervisorToken: 'offline-supervisor' };
  store.put('maintenance', m);
  return { ...f, c, store, request, job, m, artifacts: new ArtifactStore(store, c.orchestration!.answers.root) };
}

for (const code of [undefined, 'MAINTENANCE_START_FAILED']) test(`OFFLINE maintenance result: ${code ?? 'success'} archives once with original outcome and no model`, async t => {
  const h = prepared(t), before = h.store.session(h.job.session_key);
  await finishHierarchicalMaintenance(h.c, h.store, h.m, code);
  const job = h.store.get(h.job.task_id), interaction = listInteractions(h.store, h.request.conversation_scope)[0]!;
  assert.equal(job.status, code ? 'failed' : 'succeeded'); assert.equal(interaction.status, code ? 'failed' : 'completed');
  assert.equal(interaction.recapState, 'ready'); assert.ok(interaction.shortText.includes(code ?? '重启完成'));
  const artifact = h.artifacts.get(interaction.answerRef!);
  assert.equal(artifact.producer_role, 'system'); assert.equal(artifact.job_task_id, h.job.task_id);
  assert.equal((await h.artifacts.read(artifact.answer_id, { role: 'delivery', scope: h.request.conversation_scope })).toString(), job.result_text);
  const outbox = h.store.db.prepare('SELECT * FROM outbox WHERE task_id=?').all(h.job.task_id);
  assert.equal(outbox.length, 1); assert.equal(outbox[0]!.purpose, 'maintenance-final');
  await finishHierarchicalMaintenance(h.c, h.store, h.m, code ? undefined : 'LATE_FAILURE');
  assert.deepEqual(h.store.get(h.job.task_id), job); assert.deepEqual(h.store.session(h.job.session_key), before);
  assert.deepEqual(h.store.db.prepare('SELECT * FROM outbox WHERE task_id=?').all(h.job.task_id), outbox);
  assert.equal(h.store.db.prepare('SELECT count(*) n FROM native_session_catalog').get()!.n, 0);
});

test('OFFLINE maintenance result: durable finish evidence repairs rename/SQL gap with original timestamp', async t => {
  const h = prepared(t), artifact = h.artifacts.stage(h.request.request_id, 'system', h.job.task_id, h.job.session_key);
  h.artifacts.capture(artifact.answer_id, '原始维护失败结果');
  await assert.rejects(h.artifacts.publish(artifact.answer_id, { backend: 'system', requestId: h.request.request_id, completed: true,
    phase: 'failed', outcome: 'failed', errorCode: 'ORIGINAL_FAILURE' }, () => { throw Error('SQL gap'); }), /SQL gap/);
  const finishedAt = JSON.parse(h.artifacts.get(artifact.answer_id).finish_evidence_json!).completedAt;
  await finishHierarchicalMaintenance(h.c, h.store, h.m);
  const job = h.store.get(h.job.task_id);
  assert.equal(job.status, 'failed'); assert.equal(job.error_code, 'ORIGINAL_FAILURE'); assert.equal(job.finished_at, finishedAt);
  assert.equal(job.result_text, '原始维护失败结果');
  assert.equal(listInteractions(h.store, h.request.conversation_scope)[0]!.answerRef, artifact.answer_id);
  assert.equal(h.store.db.prepare("SELECT count(*) n FROM outbox WHERE purpose='maintenance-final'").get()!.n, 1);
});

test('OFFLINE maintenance result: oversized recap and stale ownership cannot change maintenance success', async t => {
  const h = prepared(t); h.c.orchestration!.answers.shortAnswerMaxChars = 1;
  await assert.rejects(finishHierarchicalMaintenance(h.c, h.store, { ...h.m, supervisorToken: 'foreign' }), /MAINTENANCE_RESULT_OWNER/);
  assert.equal(h.store.db.prepare('SELECT count(*) n FROM answer_artifacts').get()!.n, 0);
  await finishHierarchicalMaintenance(h.c, h.store, h.m);
  assert.equal(h.store.get(h.job.task_id).status, 'succeeded');
  const interaction = listInteractions(h.store, h.request.conversation_scope)[0]!;
  assert.equal(interaction.recapState, 'failed'); assert.equal(interaction.shortText.includes('重启完成'), false);
  assert.equal(h.store.db.prepare('SELECT failure_code FROM answer_recaps').get()!.failure_code, 'RECAP_MODEL_UNAVAILABLE');
  assert.equal(h.artifacts.get(interaction.answerRef!).state, 'ready');
});
