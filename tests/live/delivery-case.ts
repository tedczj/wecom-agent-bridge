import { randomUUID } from 'node:crypto';
import type { Config } from '../../src/config.ts';
import { invariant, errorCode } from '../../src/errors.ts';
import { CodexBackend } from '../../src/codex.ts';
import { CodexAppServer } from '../../src/controllers/codex-app-server.ts';
import { ArtifactStore } from '../../src/answers/artifact-store.ts';
import { sha256 } from '../../src/orchestration/requests.ts';
import { liveFixture } from './fixture.ts';
import { nativeContextAudit } from './native-context.ts';
import { bridgeDisclosure } from './bridge-disclosure.ts';
import { replayEvidence } from './replay.ts';
import { remoteWriteEvidence } from './remote-writes.ts';
import { finalizeCase, type AssertionResult, type CaseResult } from './report.ts';
import type { LiveCase } from './spec.ts';

export async function runDeliveryCase(base: Config, test: LiveCase, attempt: number, globals: string[], output: string): Promise<CaseResult> {
  invariant(test.id === 'LIVE-19', 'LIVE_SCENARIO_UNSUPPORTED');
  let injected = false, taskId: string | undefined, received: { frameSha256: string; bytes: number; at: number } | undefined;
  const fixture = await liveFixture(base, output, 'read-only', { ackFault: frame => {
    if (!injected && frame.type === 'result' && frame.taskId === taskId) {
      injected = true; const bytes = Buffer.from(JSON.stringify(frame) + '\n');
      received = { frameSha256: sha256(bytes), bytes: bytes.length, at: Date.now() }; return Error('SYNTHETIC_ACK_LOSS_AFTER_RECEIVE');
    }
  } });
  let service = fixture.service;
  const businessRun = CodexBackend.prototype.run, controllerRun = CodexAppServer.prototype.run;
  let businessCalls = 0, controllerTurns = 0, failure: string | undefined, cleanupConfirmed = false;
  const countedBusiness: typeof businessRun = function (this: CodexBackend, ...args) { businessCalls++; return businessRun.apply(this, args); };
  const countedController: typeof controllerRun = function (this: CodexAppServer, ...args) { controllerTurns++; return controllerRun.apply(this, args); };
  CodexBackend.prototype.run = countedBusiness; CodexAppServer.prototype.run = countedController;
  const observations: Record<string, { pass: boolean; actual: unknown }> = {};
  const observe = (predicate: string, pass: boolean, actual: unknown) => { observations[predicate] = { pass, actual }; };
  try {
    const before = fixture.gitState(), accepted = await service.accept({ id: randomUUID(), session: 'fixture', text: test.steps[0]!.detail, images: [] });
    invariant(accepted.taskId && !accepted.rejected, 'LIVE_REQUEST_REJECTED'); taskId = accepted.taskId; await service.settle();
    const job = service.store.get(taskId); invariant(job.kind === 'agent' && job.status === 'succeeded', 'LIVE_BUSINESS_NOT_COMPLETED');
    const row = service.store.db.prepare("SELECT answer_id FROM answer_artifacts WHERE job_task_id=? AND kind='final' AND state='ready'").get(taskId)!;
    const scope = service.store.db.prepare('SELECT conversation_scope FROM orchestration_requests WHERE request_id=?').get(taskId)!.conversation_scope as string;
    const raw = await new ArtifactStore(service.store, fixture.c.orchestration!.answers.root).read(row.answer_id as string, { role: 'delivery', scope });
    const initial = service.store.db.prepare('SELECT delivery_id,state,attempts,last_error_code FROM outbox WHERE task_id=? ORDER BY part_no').all(taskId);
    const originalFrame = fixture.frames.find(frame => frame.type === 'result' && frame.taskId === taskId);
    observe('deliveryUnknown', injected && !!received && !!originalFrame && initial.length === 1 && initial[0]!.state === 'unknown' && initial[0]!.attempts === 1 && !service.channel.ready,
      { transport: 'LocalChannel Writable fault injection; not Weixin', received, outbox: initial, channelReady: service.channel.ready });
    invariant(injected && initial.length === 1 && initial[0]!.state === 'unknown', 'LIVE_FAULT_NOT_EFFECTIVE');
    const disclosure = bridgeDisclosure(service.store, [taskId]), replay = replayEvidence(service.store, [taskId]);
    const native = await nativeContextAudit(service.store, fixture.c, job, 'unused-delivery-audit-marker');
    const remote = remoteWriteEvidence(service.store, [taskId], [native], before, fixture.gitState());
    if (disclosure.complete) observe('noBridgeRawAnswerDisclosure', disclosure.pass, disclosure.actual);
    if (replay.complete) observe('noBusinessReplayAfterUncertain', replay.pass, replay.actual);
    if (remote.complete) observe('noProductionRemoteWrites', remote.pass, remote.actual);
    const source = service.store.db.prepare('SELECT raw_query_sha256 FROM orchestration_requests WHERE request_id=?').get(taskId)!.raw_query_sha256;
    const wires = ['business-wire:', 'controller-wire:bridge:', 'controller-wire:route:'].map(prefix => service.store.value<{ textSha256: string }>(prefix + taskId));
    observe('rawQueryMatchesSourceRequest', wires.every(w => w?.textSha256 === source), { source, wires });
    observe('permissionScopeValid', JSON.parse(job.input_json).workspaceId === 'term4u' && fixture.c.codex.sandbox === 'read-only' && !fixture.c.codex.networkAccess,
      { sandbox: fixture.c.codex.sandbox, networkAccess: fixture.c.codex.networkAccess, basis: 'host fixture authorization; not OS isolation' });
    const countsBefore = { businessCalls, controllerTurns };
    service = await fixture.restart(); await service.settle();
    const restarted = service.store.db.prepare('SELECT delivery_id,state,attempts,last_error_code FROM outbox WHERE task_id=? ORDER BY part_no').all(taskId);
    const noRestartCalls = JSON.stringify(countsBefore) === JSON.stringify({ businessCalls, controllerTurns });
    observe('noAutomaticResend', JSON.stringify(initial) === JSON.stringify(restarted) && noRestartCalls && fixture.frames.filter(f => f.type === 'result' && f.taskId === taskId).length === 1,
      { initial, restarted, originalFrames: fixture.frames.filter(f => f.type === 'result' && f.taskId === taskId).length, countsBefore, countsAfterRestart: { businessCalls, controllerTurns } });
    const retrieval = await service.accept({ id: randomUUID(), session: 'fixture', text: '/result ' + taskId + ' 1', images: [] });
    invariant(retrieval.taskId && !retrieval.rejected, 'LIVE_RESULT_REJECTED'); await service.settle();
    const after = await new ArtifactStore(service.store, fixture.c.orchestration!.answers.root).read(row.answer_id as string, { role: 'delivery', scope });
    const resultFrames = fixture.frames.filter(f => f.type === 'result' && f.taskId === retrieval.taskId);
    observe('resultRecoverable', sha256(after) === sha256(raw) && resultFrames.length === 1 && resultFrames[0]!.text === originalFrame!.text &&
      JSON.stringify(countsBefore) === JSON.stringify({ businessCalls, controllerTurns }) && service.store.get(retrieval.taskId).status === 'succeeded',
      { artifactSha256: sha256(raw), recoveredSha256: sha256(after), controlTaskId: retrieval.taskId, deliveredParts: resultFrames.length, countsBefore, countsAfter: { businessCalls, controllerTurns } });
    observe('businessSubmitCount', businessCalls === 1 && service.store.db.prepare("SELECT count(*) n FROM jobs WHERE kind='agent'").get()!.n === 1, { businessCalls, controllerTurns });
    fixture.save('transport-fault.json', observations.deliveryUnknown); fixture.save('outbox-state.json', { initial, restarted,
      afterResult: service.store.db.prepare('SELECT delivery_id,state,attempts FROM outbox WHERE task_id=?').all(taskId) });
    fixture.save('send-attempts.json', { received, resultFrames: fixture.frames.filter(f => f.type === 'result').map(f => ({ taskId: f.taskId, textSha256: sha256(String(f.text)) })) });
    fixture.save('job-count.json', { countsBefore, after: { businessCalls, controllerTurns }, agentJobs: service.store.db.prepare("SELECT task_id,status FROM jobs WHERE kind='agent'").all() });
  } catch (error) { failure = errorCode(error, 'LIVE_CASE_FAILED'); }
  finally {
    try { await fixture.close(); cleanupConfirmed = true; } catch (error) { failure = errorCode(error, 'LIVE_CLEANUP_FAILED'); }
    finally {
      if (CodexBackend.prototype.run === countedBusiness && CodexAppServer.prototype.run === countedController) {
        CodexBackend.prototype.run = businessRun; CodexAppServer.prototype.run = controllerRun;
      } else { cleanupConfirmed = false; failure = 'LIVE_METER_RESTORE_CONFLICT'; }
    }
    fixture.save('observations.json', observations);
  }
  const assertions: AssertionResult[] = [...test.assertions, ...globals.map(predicate => ({ id: test.id + '-GLOBAL-' + predicate, predicate, expected: 'true' }))].map(a => {
    const observed = observations[a.predicate]; return observed ? { ...a, status: observed.pass ? 'PASS' : 'FAIL', actual: observed.actual, evidence: ['observations.json'] }
      : { ...a, status: failure ? 'FAIL' : 'BLOCKED', reason: failure ?? 'PREDICATE_ORACLE_NOT_IMPLEMENTED' };
  });
  const result = finalizeCase(test, attempt, globals, assertions);
  return failure ? { ...result, status: 'FAIL', failureCode: failure, cleanupConfirmed } : { ...result, cleanupConfirmed };
}
