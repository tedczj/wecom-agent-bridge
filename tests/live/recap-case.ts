import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import type { Config } from '../../src/config.ts';
import { invariant, errorCode } from '../../src/errors.ts';
import { ArtifactStore } from '../../src/answers/artifact-store.ts';
import { listInteractions } from '../../src/answers/projection.ts';
import { resultParts } from '../../src/reply.ts';
import { sha256 } from '../../src/orchestration/requests.ts';
import { liveFixture, liveStopSignal } from './fixture.ts';
import { recapFaultMeter } from './recap-fault-meter.ts';
import { bridgeDisclosure } from './bridge-disclosure.ts';
import { replayEvidence } from './replay.ts';
import { finalizeCase, type AssertionResult, type CaseResult } from './report.ts';
import type { LiveCase } from './spec.ts';

export async function runRecapCase(base: Config, test: LiveCase, attempt: number, globals: string[], output: string): Promise<CaseResult> {
  invariant(test.id === 'LIVE-18', 'LIVE_SCENARIO_UNSUPPORTED');
  const fixture = await liveFixture(base, output), { service, c } = fixture, meter = recapFaultMeter(service.store);
  const observations: Record<string, { pass: boolean; actual: unknown }> = {};
  let failure: string | undefined, cleanupConfirmed = false;
  const observe = (predicate: string, pass: boolean, actual: unknown) => { observations[predicate] = { pass, actual }; };
  try {
    const accepted = await service.accept({ id: randomUUID(), session: 'fixture', text: test.steps[0]!.detail, images: [] });
    invariant(accepted.taskId && !accepted.rejected, 'LIVE_REQUEST_REJECTED'); const id = accepted.taskId; await service.settle();
    const job = service.store.get(id); invariant(job.kind === 'agent' && job.status === 'succeeded', 'LIVE_BUSINESS_NOT_COMPLETED');
    const scope = service.store.db.prepare('SELECT conversation_scope FROM orchestration_requests WHERE request_id=?').get(id)!.conversation_scope as string;
    const artifact = service.store.db.prepare("SELECT answer_id,sha256,state,bytes FROM answer_artifacts WHERE job_task_id=? AND kind='final' AND state='ready'").get(id)!;
    const artifacts = new ArtifactStore(service.store, c.orchestration!.answers.root), raw = await artifacts.read(artifact.answer_id as string, { role: 'delivery', scope });
    invariant(Array.from(raw.toString('utf8')).length > 2000, 'LIVE_LONG_ANSWER_REQUIRED');
    const failed = service.store.db.prepare('SELECT recap_id,state,failure_code,source_sha256 FROM answer_recaps WHERE answer_id=?').get(artifact.answer_id as string)!;
    const before = meter.snapshot(), projection = listInteractions(service.store, scope).find(row => row.requestId === id)!;
    invariant(before.injected && failed.state === 'failed' && failed.failure_code === 'LIVE_RECAP_SERVICE_FAULT', 'LIVE_FAULT_NOT_EFFECTIVE');
    const disclosure = bridgeDisclosure(service.store, [id]);
    observe('bridgeNoRawFallback', disclosure.complete && disclosure.pass && projection.recapState === 'failed' &&
      projection.shortText === '摘要暂不可用；业务状态见 status。', { disclosure: disclosure.actual, recapState: projection.recapState, placeholderSha256: sha256(projection.shortText) });
    const end = Date.now() + 10000;
    while (!service.store.db.prepare("SELECT 1 FROM outbox WHERE task_id=? AND state='sent'").get(id)) { invariant(Date.now() < end, 'LIVE_DELIVERY_TIMEOUT'); await sleep(50); }
    const firstPart = resultParts(id, raw.toString('utf8'), c.reply.chunkBytes)[0];
    observe('deliveryIndependent', failed.state === 'failed' && fixture.frames.some(frame => frame.type === 'result' && frame.taskId === id && frame.text === firstPart),
      { recapAtDelivery: failed.state, originalFirstPartSha256: sha256(firstPart!), deliveredFrames: fixture.frames.filter(f => f.type === 'result' && f.taskId === id).length });
    const nativeRef = service.store.session(job.session_key).agent_ref_json, admissions = JSON.stringify(service.store.value('business-prompt-admissions:' + id));
    const repaired = await meter.retry(liveStopSignal), after = meter.snapshot();
    const bytesAfter = await artifacts.read(artifact.answer_id as string, { role: 'delivery', scope });
    observe('artifactImmutable', artifacts.get(artifact.answer_id as string).state === 'ready' && sha256(raw) === sha256(bytesAfter) && sha256(raw) === artifact.sha256,
      { answerId: artifact.answer_id, beforeSha256: sha256(raw), afterSha256: sha256(bytesAfter), bytes: raw.length });
    observe('recapRetryOnly', repaired.state === 'ready' && repaired.recap_id === failed.recap_id && repaired.source_sha256 === artifact.sha256 &&
      after.realRecapCalls > 0 && after.recapAttempts > before.recapAttempts && after.businessCalls === before.businessCalls &&
      service.store.session(job.session_key).agent_ref_json === nativeRef && JSON.stringify(service.store.value('business-prompt-admissions:' + id)) === admissions,
      { before, after, repaired: { id: repaired.recap_id, state: repaired.state, sourceSha256: repaired.source_sha256 }, nativeRefSha256: sha256(nativeRef!),
        attempts: service.store.value('recap-attempts:' + repaired.recap_id) });
    observe('businessSubmitCount', after.businessCalls === 1 && service.store.db.prepare("SELECT count(*) n FROM jobs WHERE kind='agent'").get()!.n === 1, after);
    if (disclosure.complete) observe('noBridgeRawAnswerDisclosure', disclosure.pass, disclosure.actual);
    const replay = replayEvidence(service.store, [id]); if (replay.complete) observe('noBusinessReplayAfterUncertain', replay.pass, replay.actual);
    const source = service.store.db.prepare('SELECT raw_query_sha256 FROM orchestration_requests WHERE request_id=?').get(id)!.raw_query_sha256;
    const wires = ['business-wire:', 'controller-wire:bridge:', 'controller-wire:route:'].map(prefix => service.store.value<{ textSha256: string }>(prefix + id));
    observe('rawQueryMatchesSourceRequest', wires.every(w => w?.textSha256 === source), { source, wires });
    observe('permissionScopeValid', JSON.parse(job.input_json).workspaceId === 'term4u' && c.codex.sandbox === 'read-only' && !c.codex.networkAccess,
      { sandbox: c.codex.sandbox, networkAccess: c.codex.networkAccess, basis: 'configured fixture authorization, not OS isolation' });
    fixture.save('recap-fault.json', { injectedAt: 'RecapModel service boundary before first model invocation', failed, repairedState: repaired.state });
    fixture.save('raw-manifest.json', observations.artifactImmutable); fixture.save('call-counts.json', { before, after }); fixture.save('bridge-input-audit.json', disclosure);
  } catch (error) { failure = errorCode(error, 'LIVE_CASE_FAILED'); }
  finally {
    try { await fixture.close(); cleanupConfirmed = true; } catch (error) { failure = errorCode(error, 'LIVE_CLEANUP_FAILED'); }
    finally { try { meter.stop(); } catch (error) { cleanupConfirmed = false; failure = errorCode(error); } }
    fixture.save('observations.json', observations);
  }
  const assertions: AssertionResult[] = [...test.assertions, ...globals.map(predicate => ({ id: test.id + '-GLOBAL-' + predicate, predicate, expected: 'true' }))].map(a => {
    const observed = observations[a.predicate]; return observed ? { ...a, status: observed.pass ? 'PASS' : 'FAIL', actual: observed.actual, evidence: ['observations.json'] }
      : { ...a, status: failure ? 'FAIL' : 'BLOCKED', reason: failure ?? 'PREDICATE_ORACLE_NOT_IMPLEMENTED' };
  });
  const result = finalizeCase(test, attempt, globals, assertions);
  return failure ? { ...result, status: 'FAIL', failureCode: failure, cleanupConfirmed } : { ...result, cleanupConfirmed };
}
