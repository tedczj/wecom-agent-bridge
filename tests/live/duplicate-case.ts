import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { Config } from '../../src/config.ts';
import { readControlled } from '../../src/fsutil.ts';
import { invariant, errorCode } from '../../src/errors.ts';
import { sha256 } from '../../src/orchestration/requests.ts';
import type { NormalizedInput } from '../../src/types.ts';
import { liveFixture } from './fixture.ts';
import { duplicateMeter } from './duplicate-meter.ts';
import type { LiveCase } from './spec.ts';
import { finalizeCase, type AssertionResult, type CaseResult } from './report.ts';
import { bridgeDisclosure } from './bridge-disclosure.ts';
import { replayEvidence } from './replay.ts';
import { nativeContextAudit } from './native-context.ts';
import { remoteWriteEvidence } from './remote-writes.ts';

export async function runDuplicateCase(base: Config, test: LiveCase, attempt: number, globals: string[], output: string): Promise<CaseResult> {
  invariant(test.id === 'LIVE-11' && test.steps.length === 3 && test.steps[0]?.action === 'user', 'LIVE_SCENARIO_UNSUPPORTED');
  const fixture = await liveFixture(base, output, 'workspace-write'), { service, c } = fixture;
  const meter = duplicateMeter(), nonce = randomUUID();
  const observations: Record<string, { pass: boolean; actual: unknown }> = {};
  let failure: string | undefined, cleanupConfirmed = false;
  try {
    const before = fixture.gitState();
    const frame = { id: randomUUID(), session: 'fixture', text: test.steps[0].detail.replaceAll('${nonce}', nonce), images: [] };
    const first = await service.accept(frame); invariant(first.taskId && !first.rejected, 'LIVE_REQUEST_REJECTED');
    const concurrent = await service.accept(frame); await service.settle();
    const job = service.store.get(first.taskId); invariant(job.kind === 'agent' && job.status === 'succeeded', 'LIVE_BUSINESS_NOT_COMPLETED');
    const native = service.store.session(job.session_key).agent_ref_json; invariant(native, 'LIVE_NATIVE_REF_MISSING');
    const completed = meter.snapshot();
    const repeated = await service.accept(frame); await service.settle();
    const duplicateCalls = meter.snapshot();
    const conflict = await service.accept({ ...frame, text: frame.text + '\n另一个请求。' }); await service.settle();
    const afterCalls = meter.snapshot(), after = fixture.gitState();
    const input = JSON.parse(job.input_json) as NormalizedInput;
    const file = await readControlled(path.join(fixture.projectRoot, 'term4u'), path.join(fixture.projectRoot, 'term4u', 'once.txt'), 128);
    invariant(file.toString() === nonce || file.toString() === nonce + '\n', 'LIVE_FIXTURE_CONTENT_MISMATCH');
    const jobs = service.store.db.prepare("SELECT task_id,status FROM jobs WHERE kind='agent'").all();
    const roots = service.store.db.prepare('SELECT request_id,phase,raw_query_sha256 FROM orchestration_requests').all();
    const effects = service.store.db.prepare('SELECT effect_id,request_id,stage,effect_key,state,job_task_id FROM controller_effects').all();
    const observe = (predicate: string, pass: boolean, actual: unknown) => { observations[predicate] = { pass, actual }; };
    observe('businessSubmitCount', afterCalls.businessSubmits === 1 && jobs.length === 1, { backendCalls: afterCalls.businessSubmits, jobs, fileSha256: sha256(file) });
    observe('dedupBeforeLLM', concurrent.duplicate === true && repeated.duplicate === true && concurrent.taskId === first.taskId && repeated.taskId === first.taskId &&
      completed.calls.length === 2 && JSON.stringify(completed) === JSON.stringify(duplicateCalls), { concurrent, repeated, completed, duplicateCalls });
    observe('effectIdempotent', afterCalls.replay.length === 2 && afterCalls.replay.every(result => result.requestId === first.taskId && result.businessSessionKey === job.session_key) &&
      afterCalls.replay[0]!.resultSha256 === afterCalls.replay[1]!.resultSha256 && effects.length === 1 && effects[0]!.state === 'completed',
      { effects, replay: afterCalls.replay, nativeRefHash: sha256(native) });
    observe('requestConflict', conflict.rejected === 'REQUEST_ID_CONFLICT' && !conflict.taskId && roots.length === 1 && JSON.stringify(afterCalls) === JSON.stringify(duplicateCalls), { conflict, roots });
    const wire = service.store.value<{ textSha256: string }>('business-wire:' + first.taskId);
    observe('rawQueryMatchesSourceRequest', wire?.textSha256 === sha256(frame.text) && completed.calls.length === 2 && completed.calls.every(call => call.textSha256 === sha256(frame.text)) &&
      input.rawQuerySha256 === sha256(frame.text), { originalHash: sha256(frame.text), wire, management: completed.calls });
    observe('permissionScopeValid', input.workspaceId === 'term4u' && input.routing?.directory.path === path.join(fixture.projectRoot, 'term4u') &&
      c.codex.sandbox === 'workspace-write' && !c.codex.networkAccess, { sandbox: c.codex.sandbox, networkAccess: c.codex.networkAccess, workspace: input.workspaceId, basis: 'configured fixture authorization, not OS-isolation proof' });
    const disclosure = bridgeDisclosure(service.store, [first.taskId]);
    if (disclosure.complete) observe('noBridgeRawAnswerDisclosure', disclosure.pass, disclosure.actual);
    const replay = replayEvidence(service.store, [first.taskId]);
    if (replay.complete) observe('noBusinessReplayAfterUncertain', replay.pass, replay.actual);
    const nativeAudit = await nativeContextAudit(service.store, c, job, nonce), remote = remoteWriteEvidence(service.store, [first.taskId], [nativeAudit], before, after);
    fixture.save('remote-write-audit.json', remote);
    if (remote.complete) observe('noProductionRemoteWrites', remote.pass, remote.actual);
    fixture.save('fixture-status.json', { before, after, fileSha256: sha256(file) });
  } catch (error) { failure = errorCode(error, 'LIVE_CASE_FAILED'); }
  finally {
    try { await fixture.close(); cleanupConfirmed = true; } catch (error) { failure = errorCode(error, 'LIVE_CLEANUP_FAILED'); }
    finally { try { meter.stop(); } catch (error) { cleanupConfirmed = false; failure = errorCode(error, 'LIVE_METER_RESTORE_FAILED'); } }
    try { fixture.save('observations.json', observations); fixture.save('calls.json', meter.snapshot()); }
    catch (error) { failure = errorCode(error, 'LIVE_EVIDENCE_FAILED'); for (const key of Object.keys(observations)) delete observations[key]; }
  }
  const assertions: AssertionResult[] = [...test.assertions, ...globals.map(predicate => ({ id: test.id + '-GLOBAL-' + predicate, predicate, expected: 'true' }))].map(assertion => {
    const observed = observations[assertion.predicate];
    return observed ? { ...assertion, status: observed.pass ? 'PASS' : 'FAIL', actual: observed.actual, evidence: ['observations.json'] }
      : { ...assertion, status: failure ? 'FAIL' : 'BLOCKED', reason: failure ?? 'PREDICATE_ORACLE_NOT_IMPLEMENTED' };
  });
  const result = finalizeCase(test, attempt, globals, assertions);
  return failure ? { ...result, status: 'FAIL', failureCode: failure, cleanupConfirmed } : { ...result, cleanupConfirmed };
}
