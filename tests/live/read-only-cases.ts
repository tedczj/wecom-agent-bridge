import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Config } from '../../src/config.ts';
import type { NormalizedInput } from '../../src/types.ts';
import { ArtifactStore } from '../../src/answers/artifact-store.ts';
import { listInteractions } from '../../src/answers/projection.ts';
import { sha256 } from '../../src/orchestration/requests.ts';
import { invariant, errorCode } from '../../src/errors.ts';
import { liveFixture } from './fixture.ts';
import type { LiveCase } from './spec.ts';
import { finalizeCase, type AssertionResult, type CaseResult } from './report.ts';
import { bridgeDisclosure } from './bridge-disclosure.ts';
import { replayEvidence } from './replay.ts';
import { nativeContextAudit, nonceAnswerClaim } from './native-context.ts';
import { remoteWriteEvidence } from './remote-writes.ts';
import { geometryImage, geometryAnswer } from './visual-fixture.ts';

export const readonlyCases = new Set(['LIVE-01', 'LIVE-02', 'LIVE-03', 'LIVE-04', 'LIVE-10', 'LIVE-22', 'LIVE-29']);
export async function runReadonlyCase(base: Config, test: LiveCase, attempt: number, globals: string[], output: string): Promise<CaseResult> {
  invariant(readonlyCases.has(test.id) && test.steps.every(step => step.action === 'user'), 'LIVE_SCENARIO_UNSUPPORTED');
  const fixture = await liveFixture(base, output), { service, c } = fixture, nonce = randomUUID(), requestIds: string[] = [];
  const observations: Record<string, { pass: boolean; actual: unknown }> = {};
  const blockedReasons: Record<string, string> = {};
  let executionError: string | undefined, cleanupConfirmed = false;
  try {
    const before = fixture.gitState();
    let imageFile: string | undefined, imageSha256: string | undefined;
    if (test.id === 'LIVE-22') {
      const bytes = await geometryImage(); imageFile = path.join(fixture.root, 'image.png'); imageSha256 = sha256(bytes);
      writeFileSync(imageFile, bytes, { mode: 0o600 }); fixture.save('image-fixture.json', { sha256: imageSha256, width: 192, height: 112 });
    }
    let setupSession: string | undefined, setupRequest: string | undefined;
    if (test.id === 'LIVE-29') {
      const accepted = await service.accept({ id: randomUUID(), session: 'fixture', text: '在 term4u 建立业务会话，只回复“准备好了”，不要修改文件。', images: [] });
      invariant(accepted.taskId && !accepted.rejected, 'LIVE_SETUP_REJECTED'); await service.settle();
      const job = service.store.get(accepted.taskId);
      invariant(job.kind === 'agent' && job.status === 'succeeded', 'LIVE_SETUP_INCOMPLETE'); setupSession = job.session_key;
      setupRequest = accepted.taskId;
      fixture.save('setup.json', { requestId: accepted.taskId, sessionHash: sha256(job.session_key) });
    }
    for (const step of test.steps) {
      let raw = step.detail.replaceAll('${nonce}', nonce);
      if (test.id === 'LIVE-10') { raw = raw.replaceAll('\\r\\n', '\r\n'); invariant(raw.includes('\r\n'), 'LIVE_CRLF_FIXTURE'); }
      const frame = { id: randomUUID(), session: 'fixture', text: raw, images: imageFile && step.order === 1 ? [imageFile] : [] };
      const accepted = await service.accept(frame); invariant(accepted.taskId && !accepted.rejected, 'LIVE_REQUEST_REJECTED'); requestIds.push(accepted.taskId);
      await service.settle();
      const job = service.store.get(accepted.taskId);
      invariant(job.kind === 'agent' && job.status === 'succeeded', 'LIVE_BUSINESS_NOT_COMPLETED');
    }
    const requests = requestIds.map(id => service.store.db.prepare('SELECT request_id,conversation_scope,raw_query_sha256,phase FROM orchestration_requests WHERE request_id=?').get(id)!);
    const jobs = requestIds.map(id => service.store.get(id)).filter(job => job.kind === 'agent');
    fixture.save('request-status.json', requests);
    invariant(jobs.length === test.steps.length && jobs.every(job => job.status === 'succeeded'), 'LIVE_BUSINESS_NOT_COMPLETED');
    if (setupSession) invariant(jobs[0]!.session_key === setupSession, 'LIVE_SETUP_SESSION_NOT_REUSED');
    const inputs = jobs.map(job => JSON.parse(job.input_json) as NormalizedInput), refs = jobs.map(job => service.store.session(job.session_key).agent_ref_json);
    const audits = jobs.map(job => ({ requestId: job.task_id, source: service.store.db.prepare('SELECT raw_query_sha256 FROM orchestration_requests WHERE request_id=?').get(JSON.parse(job.input_json).sourceRequestId)!.raw_query_sha256,
      business: service.store.value<{ textSha256: string; attachmentHashes: string[] }>('business-wire:' + job.task_id),
      bridge: service.store.value<{ textSha256: string; attachmentHashes: string[] }>('controller-wire:bridge:' + job.task_id), route: service.store.value<{ textSha256: string; attachmentHashes: string[] }>('controller-wire:route:' + job.task_id) }));
    const answers: string[] = [], answerIds: string[] = [];
    for (const job of jobs) {
      const artifact = service.store.db.prepare("SELECT answer_id FROM answer_artifacts WHERE job_task_id=? AND state='ready' AND kind='final'").get(job.task_id);
      invariant(artifact, 'LIVE_ANSWER_NOT_READY');
      answerIds.push(artifact.answer_id as string);
      const root = requests.find(request => request.request_id === job.task_id)!;
      answers.push((await new ArtifactStore(service.store, c.orchestration!.answers.root).read(artifact.answer_id as string, { role: 'delivery', scope: root.conversation_scope as string })).toString('utf8'));
    }
    const observe = (predicate: string, pass: boolean, actual: unknown) => { observations[predicate] = { pass, actual }; };
    const exact = audits.length === jobs.length && audits.length > 0 && audits.every(a => a.business?.textSha256 === a.source && a.bridge?.textSha256 === a.source && a.route?.textSha256 === a.source);
    observe('queryByteIdentity', exact, audits); observe('rawQueryMatchesSourceRequest', exact, audits);
    observe('nativePromptObserved', audits.length > 0 && audits.every(a => !!a.business), audits.map(a => ({ requestId: a.requestId, observed: !!a.business })));
    observe('noHistoryInjection', exact && inputs.every(input => !input.contextTaskIds?.length && !input.originalText), { exact, inputs: inputs.length });
    observe('businessSubmitCount', jobs.length === 1, jobs.length);
    const after = fixture.gitState(); observe('fixtureWrites', JSON.stringify(before) === JSON.stringify(after), { before, after });
    observe('directoryIdentity', inputs[0]?.workspaceId === 'multi-lang-video-generator', inputs.map(input => input.workspaceId));
    observe('directorySequence', JSON.stringify(inputs.map(input => input.workspaceId)) === JSON.stringify(['term4u', 'term4u', 'doc-ocr-service', 'term4u']), inputs.map(input => input.workspaceId));
    observe('businessSessionIdentity', refs.length === 4 && refs[0] === refs[3] && refs[0] !== refs[2], refs.map(ref => ref ? sha256(ref) : null));
    observe('sameNativeSession', refs.length >= 2 && !!refs[0] && refs[0] === refs[1], refs.map(ref => ref ? sha256(ref) : null));
    if (test.id === 'LIVE-22') {
      const hashes = audits.map(a => ({ business: a.business?.attachmentHashes, bridge: a.bridge?.attachmentHashes, route: a.route?.attachmentHashes }));
      observe('attachmentIdentity', inputs[0]!.images.length === 1 && inputs[0]!.images[0]!.sha256 === imageSha256 &&
        Object.values(hashes[0]!).every(value => JSON.stringify(value) === JSON.stringify([imageSha256])), { imageSha256, hashes });
      observe('noHistoricalImageCopy', inputs[1]!.images.length === 0 && Object.values(hashes[1]!).every(value => Array.isArray(value) && value.length === 0), { hashes: hashes[1] });
      if (geometryAnswer(answers[0]!, answers[1]!) === 'matches') observe('visualAnswer', true, { answerHashes: answers.map(sha256), rubric: 'explicit red circle and blue square, followed by red; no OCR' });
      else blockedReasons.visualAnswer = 'SEMANTIC_REVIEW_REQUIRED';
    }
    observe('differentNativeSession', refs.length >= 2 && !!refs[0] && !!refs[1] && refs[0] !== refs[1], refs.map(ref => ref ? sha256(ref) : null));
    observe('answerEquals', answers[1]?.trim() === nonce, { answerHash: answers[1] ? sha256(answers[1]) : null, expectedHash: sha256(nonce) });
    if (test.id === 'LIVE-03' || test.id === 'LIVE-04') {
      const native = await nativeContextAudit(service.store, c, jobs.at(-1)!, nonce);
      fixture.save('native-context.json', native);
      if (test.id === 'LIVE-03') {
        const first = native.inputs.findIndex(input => input.textSha256 === inputs[0]!.rawQuerySha256 && input.completed);
        const second = native.inputs.findIndex(input => input.textSha256 === inputs[1]!.rawQuerySha256 && input.completed);
        observe('nativeTurnContinuity', refs[0] === refs[1] && first >= 0 && second > first && native.inputs[first]!.turnId !== native.inputs[second]!.turnId, native);
      } else observe('secretAbsentFromContext', refs[0] !== refs[1] && refs[1] === refs[2] && !native.noncePresent && !native.inheritedContext &&
        native.inputs.some(input => input.textSha256 === inputs[1]!.rawQuerySha256 && input.completed) &&
        native.inputs.some(input => input.textSha256 === inputs[2]!.rawQuerySha256 && input.completed), native);
    }
    if (test.id === 'LIVE-04') {
      const claim = nonceAnswerClaim(answers[2]!);
      if (claim === 'uncertain') blockedReasons.newSessionResponse = 'SEMANTIC_REVIEW_REQUIRED';
      else observe('newSessionResponse', claim === 'denies', { claim, answerSha256: sha256(answers[2]!), basis: 'unambiguous direct answer; context isolation checked separately' });
    }
    const controllers = service.store.db.prepare('SELECT role,generation,logical_key,native_ref_json FROM controller_sessions ORDER BY created_at').all();
    observe('controllerCreationCount', controllers.filter(row => row.role === 'bridge').length === 1 && controllers.filter(row => row.role === 'route').length === 1, controllers.map(row => ({ role: row.role, generation: row.generation, key: row.logical_key })));
    observe('routeSessionIdentity', controllers.filter(row => row.role === 'route').length === 2 && controllers.every(row => row.generation === 0), controllers.map(row => ({ role: row.role, key: row.logical_key, generation: row.generation })));
    observe('modelDefaultSource', inputs.length === 1 && inputs[0]!.routing?.modelSource === 'daily' && inputs[0]!.routing?.execution?.reasoning === c.models![c.orchestration!.business.defaultModelProfile]!.reasoning,
      { sources: inputs.map(input => input.routing?.modelSource), configuredReasoning: c.models![c.orchestration!.business.defaultModelProfile]!.reasoning, specificationOverride: 'operator-selected profile' });
    const recaps = service.store.db.prepare(`SELECT answer_id,source,short_text,state FROM answer_recaps WHERE answer_id IN (${answerIds.map(() => '?').join(',')})`).all(...answerIds);
    observe('shortAnswerVerbatim', answers.length === 1 && recaps.length === 1 && recaps[0]!.source === 'verbatim-short' && recaps[0]!.short_text === answers[0], { source: recaps[0]?.source, hash: answers[0] ? sha256(answers[0]) : null });
    observe('recapInvocationCount', recaps.length === 1 && recaps[0]!.source === 'verbatim-short' && !service.store.db.prepare("SELECT 1 FROM native_session_catalog WHERE role='recap'").get(), { sources: recaps.map(row => row.source) });
    observe('artifactImmutable', answers.length === jobs.length && answers.length > 0, { hashes: answers.map(sha256) });
    if (test.id === 'LIVE-29') {
      const projection = listInteractions(service.store, requests[0]!.conversation_scope as string).find(row => row.requestId === requestIds[0]);
      observe('bridgeProjection', !!projection && projection.answerRef === answerIds[0] && projection.shortText === answers[0] && projection.recapState === 'ready',
        { requestId: projection?.requestId, answerRef: projection?.answerRef, shortTextSha256: projection ? sha256(projection.shortText) : null,
          basis: 'production list_interactions projection over the real completed answer; no extra management prompt' });
    }
    observe('permissionScopeValid', inputs.every(input => c.routing!.workspaces.some(workspace => workspace.path === input.routing?.directory.path)) && c.codex.sandbox === 'read-only' && !c.codex.networkAccess,
      { selectedWorkspaces: inputs.map(input => input.workspaceId), sandbox: c.codex.sandbox, networkAccess: c.codex.networkAccess, basis: 'host authorization and configured permissions, not OS-isolation proof' });
    const disclosure = bridgeDisclosure(service.store, requestIds);
    if (disclosure.complete) observe('noBridgeRawAnswerDisclosure', disclosure.pass, disclosure.actual);
    const replay = replayEvidence(service.store, requestIds);
    if (replay.complete) observe('noBusinessReplayAfterUncertain', replay.pass, replay.actual);
    const allRequests = setupRequest ? [setupRequest, ...requestIds] : requestIds;
    try {
      const nativeAudits = [];
      for (const id of allRequests) nativeAudits.push(await nativeContextAudit(service.store, c, service.store.get(id), nonce));
      const remote = remoteWriteEvidence(service.store, allRequests, nativeAudits, before, after);
      fixture.save('remote-write-audit.json', remote);
      if (remote.complete) observe('noProductionRemoteWrites', remote.pass, remote.actual);
      else blockedReasons.noProductionRemoteWrites = 'REMOTE_WRITE_AUDIT_INCOMPLETE';
    } catch (error) { blockedReasons.noProductionRemoteWrites = errorCode(error, 'REMOTE_WRITE_AUDIT_INCOMPLETE'); }
    fixture.save('observations.json', observations); fixture.save('request-status.json', requests);
  } catch (error) { executionError = errorCode(error, 'LIVE_CASE_FAILED'); }
  finally { try { await fixture.close(); cleanupConfirmed = true; } catch (error) { executionError = errorCode(error, 'LIVE_CLEANUP_FAILED'); } }
  const results: AssertionResult[] = [...test.assertions, ...globals.map(predicate => ({ id: test.id + '-GLOBAL-' + predicate, predicate, expected: 'true' }))].map(assertion => {
    const observation = observations[assertion.predicate];
    return observation ? { ...assertion, status: observation.pass ? 'PASS' : 'FAIL', actual: observation.actual, evidence: ['observations.json'] }
      : { ...assertion, status: executionError ? 'FAIL' : 'BLOCKED', reason: executionError ?? blockedReasons[assertion.predicate] ?? 'PREDICATE_ORACLE_NOT_IMPLEMENTED' };
  });
  const result = finalizeCase(test, attempt, globals, results);
  return executionError ? { ...result, status: 'FAIL', failureCode: executionError, cleanupConfirmed } : { ...result, cleanupConfirmed };
}
