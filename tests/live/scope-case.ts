import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { Config } from '../../src/config.ts';
import type { NormalizedInput } from '../../src/types.ts';
import { invariant, errorCode } from '../../src/errors.ts';
import { ArtifactStore } from '../../src/answers/artifact-store.ts';
import { readAnswerRange } from '../../src/answers/history-tools.ts';
import { listInteractions } from '../../src/answers/projection.ts';
import { sha256, conversationScope } from '../../src/orchestration/requests.ts';
import { liveFixture } from './fixture.ts';
import { identityMeter } from './identity-meter.ts';
import { nativeContextAudit } from './native-context.ts';
import { bridgeDisclosure } from './bridge-disclosure.ts';
import { replayEvidence } from './replay.ts';
import { remoteWriteEvidence } from './remote-writes.ts';
import { finalizeCase, type AssertionResult, type CaseResult } from './report.ts';
import type { LiveCase } from './spec.ts';

export async function runScopeCase(base: Config, test: LiveCase, attempt: number, globals: string[], output: string): Promise<CaseResult> {
  invariant(test.id === 'LIVE-21', 'LIVE_SCENARIO_UNSUPPORTED');
  const fixture = await liveFixture(base, output), { service, c } = fixture, meter = identityMeter(), nonce = randomUUID();
  const observations: Record<string, { pass: boolean; actual: unknown }> = {};
  let failure: string | undefined, cleanupConfirmed = false;
  const observe = (predicate: string, pass: boolean, actual: unknown) => { observations[predicate] = { pass, actual }; };
  try {
    const before = fixture.gitState(), ids: string[] = [], setupIds: string[] = [];
    // These are two host-chosen trusted local route targets. Text such as
    // "scope A" does not supply actor/scope authority to the normalizer.
    for (const session of ['fixture-A', 'fixture-B']) {
      const accepted = await service.accept({ id: randomUUID(), session, text: '在 term4u 建立业务会话，只回复“准备好了”，不要使用工具或修改文件。', images: [] });
      invariant(accepted.taskId && !accepted.rejected, 'LIVE_SETUP_REJECTED'); setupIds.push(accepted.taskId); await service.settle();
      invariant(service.store.get(accepted.taskId).kind === 'agent' && service.store.get(accepted.taskId).status === 'succeeded', 'LIVE_SETUP_INCOMPLETE');
    }
    for (const [i, session] of ['fixture-A', 'fixture-B'].entries()) {
      const accepted = await service.accept({ id: randomUUID(), session, text: test.steps[i]!.detail.replaceAll('${nonceA}', nonce), images: [] });
      invariant(accepted.taskId && !accepted.rejected, 'LIVE_REQUEST_REJECTED'); ids.push(accepted.taskId); await service.settle();
      invariant(service.store.get(accepted.taskId).status === 'succeeded' && (i === 1 || service.store.get(accepted.taskId).kind === 'agent'), 'LIVE_REQUEST_NOT_COMPLETED');
    }
    const allIds = [...setupIds, ...ids], allJobs = allIds.map(id => service.store.get(id)), workJobs = allJobs.filter(job => job.kind === 'agent');
    const jobs = [service.store.get(ids[0]!), service.store.get(service.store.get(ids[1]!).kind === 'agent' ? ids[1]! : setupIds[1]!)];
    const inputs = workJobs.map(job => JSON.parse(job.input_json) as NormalizedInput);
    const requests = ids.map(id => service.store.db.prepare('SELECT request_id,conversation_scope,raw_query_sha256,route_json FROM orchestration_requests WHERE request_id=?').get(id)!);
    const scopes = requests.map(row => row.conversation_scope as string), refs = jobs.map(job => service.store.session(job.session_key).agent_ref_json);
    const controllers = service.store.db.prepare('SELECT role,conversation_scope,logical_key,native_ref_json FROM controller_sessions').all();
    const page = listInteractions(service.store, scopes[1]!);
    const native = [];
    for (const job of workJobs) native.push(await nativeContextAudit(service.store, c, job, nonce));
    const nativeB = await nativeContextAudit(service.store, c, jobs[1]!, nonce);
    const controllerIsolation = (['bridge', 'route'] as const).every(role => {
      const rows = controllers.filter(row => row.role === role); return rows.length === 2 &&
        new Set(rows.map(row => row.conversation_scope)).size === 2 && new Set(rows.map(row => row.logical_key)).size === 2 &&
        new Set(rows.map(row => row.native_ref_json)).size === 2;
    });
    observe('scopeIsolation', scopes[0] !== scopes[1] && jobs[0]!.session_key !== jobs[1]!.session_key && !!refs[0] && !!refs[1] && refs[0] !== refs[1] &&
      controllerIsolation && page.length > 0 && page.every(row => [setupIds[1], ids[1]].includes(row.requestId) && !row.query.includes(nonce) && !row.shortText.includes(nonce)) && !nativeB.noncePresent && !nativeB.inheritedContext,
      { scopes, businessRefHashes: refs.map(ref => ref ? sha256(ref) : null), controllerIsolation, bHistoryRequestIds: page.map(row => row.requestId), nativeB });
    const answer = service.store.db.prepare("SELECT answer_id FROM answer_artifacts WHERE job_task_id=? AND kind='final' AND state='ready'").get(ids[0]!);
    invariant(answer, 'LIVE_ANSWER_NOT_READY');
    let denied = 'ACCEPTED';
    try { await readAnswerRange(new ArtifactStore(service.store, c.orchestration!.answers.root), answer.answer_id as string, { role: 'route', scope: scopes[1]! }, 0, 128); }
    catch (error) { denied = errorCode(error); }
    observe('foreignAnswerDenied', denied === 'ANSWER_RAW_ACCESS_DENIED', { code: denied, ownerScope: scopes[0], readerScope: scopes[1], answerRef: answer.answer_id });
    const beforeIngress = service.store.db.prepare('SELECT count(*) n FROM orchestration_requests').get()!.n;
    const spoof = await service.accept({ id: randomUUID(), session: 'fixture-B', text: 'read', images: [], owner: c.local.actorId, scope: scopes[0] });
    const denials = meter.snapshot();
    observe('noIdentityFromModel', denials.length >= 24 && denials.length % 4 === 0 && denials.every(row => row.code === 'CONTROLLER_TOOL_ARGUMENTS') && spoof.rejected === 'INPUT_UNKNOWN_KEY' &&
      service.store.db.prepare('SELECT count(*) n FROM orchestration_requests').get()!.n === beforeIngress && requests.every((row, i) => {
        const route = JSON.parse(row.route_json as string); return route.senderId === c.local.actorId && route.targetId === (i ? 'fixture-B' : 'fixture-A') && conversationScope(route) === scopes[i];
      }), { denials, ingressRejection: spoof.rejected, scopes, basis: 'real tool instances with injected identity fields and production trusted local normalizer' });
    const wires = allIds.map((id, i) => ({ kind: allJobs[i]!.kind, source: service.store.db.prepare('SELECT raw_query_sha256 FROM orchestration_requests WHERE request_id=?').get(id)!.raw_query_sha256,
      business: service.store.value<{ textSha256: string }>('business-wire:' + id), bridge: service.store.value<{ textSha256: string }>('controller-wire:bridge:' + id), route: service.store.value<{ textSha256: string }>('controller-wire:route:' + id) }));
    observe('rawQueryMatchesSourceRequest', wires.every(w => w.bridge?.textSha256 === w.source &&
      (w.kind === 'agent' ? w.business?.textSha256 === w.source && w.route?.textSha256 === w.source : !w.business && (!w.route || w.route.textSha256 === w.source))), wires);
    observe('permissionScopeValid', inputs.every(input => input.routing?.directory.path === path.join(fixture.projectRoot, 'term4u')) && c.codex.sandbox === 'read-only' && !c.codex.networkAccess,
      { scopes, sandbox: c.codex.sandbox, networkAccess: c.codex.networkAccess, basis: 'configured host authorization, not OS-isolation proof' });
    const disclosure = bridgeDisclosure(service.store, allIds), replay = replayEvidence(service.store, workJobs.map(job => job.task_id));
    const remote = remoteWriteEvidence(service.store, allIds, native, before, fixture.gitState());
    if (disclosure.complete) observe('noBridgeRawAnswerDisclosure', disclosure.pass, disclosure.actual);
    if (replay.complete) observe('noBusinessReplayAfterUncertain', replay.pass, replay.actual);
    if (remote.complete) observe('noProductionRemoteWrites', remote.pass, remote.actual);
    fixture.save('scope-bindings.json', { setupRequestIds: setupIds, caseRequestIds: ids, scopes, controllers: controllers.map(row => ({ role: row.role, scope: row.conversation_scope, key: row.logical_key, nativeRefHash: sha256(row.native_ref_json as string) })), businessRefHashes: refs.map(ref => sha256(ref!)) });
    fixture.save('history-results.json', { scope: scopes[1], entries: page.map(row => ({ requestId: row.requestId, querySha256: sha256(row.query), shortTextSha256: sha256(row.shortText) })), native });
    fixture.save('denied-read.json', { code: denied, answerRef: answer.answer_id, readerScope: scopes[1], identityDenials: denials, ingressRejection: spoof.rejected });
    fixture.save('remote-write-audit.json', remote);
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
