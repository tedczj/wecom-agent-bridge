import { randomUUID } from 'node:crypto';
import type { Config } from '../../src/config.ts';
import { invariant, errorCode } from '../../src/errors.ts';
import { ArtifactStore } from '../../src/answers/artifact-store.ts';
import { listInteractions } from '../../src/answers/projection.ts';
import { sha256 } from '../../src/orchestration/requests.ts';
import { liveFixture, liveStopSignal } from './fixture.ts';
import { answerMeter } from './answer-meter.ts';
import { recapFaultMeter } from './recap-fault-meter.ts';
import { nativeContextAudit } from './native-context.ts';
import { bridgeDisclosure } from './bridge-disclosure.ts';
import { replayEvidence } from './replay.ts';
import { finalizeCase, type AssertionResult, type CaseResult } from './report.ts';
import type { LiveCase } from './spec.ts';

export async function runLongAnswerCase(base: Config, test: LiveCase, attempt: number, globals: string[], output: string): Promise<CaseResult> {
  invariant(test.id === 'LIVE-07' || test.id === 'LIVE-09', 'LIVE_SCENARIO_UNSUPPORTED');
  const fixture = await liveFixture(base, output), { service, c } = fixture, meter = answerMeter();
  const fault = test.id === 'LIVE-07' ? recapFaultMeter(service.store) : undefined;
  const observations: Record<string, { pass: boolean; actual: unknown }> = {};
  let failure: string | undefined, cleanupConfirmed = false;
  const observe = (predicate: string, pass: boolean, actual: unknown) => { observations[predicate] = { pass, actual }; };
  try {
    invariant(c.orchestration!.answers.shortAnswerMaxChars === 1200 && c.orchestration!.answers.recapMaxChars === 1000, 'LIVE_RECAP_LIMITS');
    const setupQuery = test.id === 'LIVE-07' ? test.steps[0]!.detail :
      '在 term4u 生成超过五千字的合成技术报告，使用 Markdown 标题分为第一章至第五章。用工具生成一个新的32位十六进制随机标记，将 CHECKSUM=标记 作为第三章最后一行，其他章节不要重复标记。不要修改文件。';
    const setup = await service.accept({ id: randomUUID(), session: 'fixture', text: setupQuery, images: [] });
    invariant(setup.taskId && !setup.rejected, 'LIVE_SETUP_REJECTED'); await service.settle();
    const id = setup.taskId, job = service.store.get(id); invariant(job.kind === 'agent' && job.status === 'succeeded', 'LIVE_BUSINESS_NOT_COMPLETED');
    const scope = service.store.db.prepare('SELECT conversation_scope FROM orchestration_requests WHERE request_id=?').get(id)!.conversation_scope as string;
    const artifacts = new ArtifactStore(service.store, c.orchestration!.answers.root);
    const artifact = service.store.db.prepare("SELECT answer_id,sha256,bytes FROM answer_artifacts WHERE job_task_id=? AND kind='final' AND state='ready'").get(id)!;
    const raw = await artifacts.read(artifact.answer_id as string, { role: 'delivery', scope }), text = raw.toString('utf8');
    invariant(Array.from(text).length > 5000 && (text.match(/^#{1,6}\s/gm)?.length ?? 0) >= 5, 'LIVE_LONG_REPORT_REQUIRED');
    const region = test.id === 'LIVE-07' ? text.slice(-1200) : text.split(/^#{1,6}\s+.*(?:第三章|第3章).*$/m)[1]?.split(/^#{1,6}\s+.*(?:第四章|第4章).*$/m)[0];
    const token = region?.match(test.id === 'LIVE-09' ? /CHECKSUM\s*=\s*([a-f0-9]{32})\b/i : /\b([a-f0-9]{32,128}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})\b/i)?.[1];
    invariant(token && !setupQuery.includes(token), 'LIVE_GENERATED_MARKER_MISSING');
    const native = await nativeContextAudit(service.store, c, job, token);
    invariant(native.toolOutputContainsNonce, 'LIVE_MARKER_TOOL_PROVENANCE_UNVERIFIED');
    meter.setMarker(token);
    const recapRow = () => service.store.db.prepare('SELECT recap_id,state,source,source_sha256,short_text FROM answer_recaps WHERE answer_id=?').get(artifact.answer_id as string)!;
    const failedProjection = listInteractions(service.store, scope).find(row => row.requestId === id)!;
    if (fault) {
      const before = fault.snapshot(); invariant(before.injected && recapRow().state === 'failed', 'LIVE_FAULT_NOT_EFFECTIVE');
      const failedDisclosure = bridgeDisclosure(service.store, [id]);
      observe('noRawFallback', failedDisclosure.complete && failedDisclosure.pass && failedProjection.recapState === 'failed' &&
        failedProjection.shortText === '摘要暂不可用；业务状态见 status。' && !meter.snapshot().tools.some(row => row.role === 'bridge' && row.rawBodySeen),
      { injected: 'first recap service invocation, not business result', before, disclosure: failedDisclosure, recapState: failedProjection.recapState });
      const repaired = await fault.retry(liveStopSignal); invariant(repaired.state === 'ready', 'LIVE_RECAP_RETRY_FAILED');
    }
    const recap = recapRow(); invariant(recap.state === 'ready' && recap.source === 'llm-recap', 'LIVE_RECAP_NOT_READY');
    observe('recapBound', typeof recap.short_text === 'string' && Array.from(recap.short_text).length <= 1000 && recap.source_sha256 === artifact.sha256,
      { state: recap.state, source: recap.source, sourceSha256: recap.source_sha256, textSha256: sha256(recap.short_text as string), codepoints: Array.from(recap.short_text as string).length });
    if (test.id === 'LIVE-09') invariant(!(recap.short_text as string).includes(token), 'LIVE_MARKER_ALREADY_IN_RECAP');
    const beforeTools = meter.snapshot().tools.length, beforeJobs = service.store.db.prepare("SELECT count(*) n FROM jobs WHERE kind='agent'").get()!.n;
    const question = test.steps[test.id === 'LIVE-07' ? 1 : 0]!.detail;
    const follow = await service.accept({ id: randomUUID(), session: 'fixture', text: question, images: [] });
    invariant(follow.taskId && !follow.rejected, 'LIVE_REQUEST_REJECTED'); await service.settle();
    const followJob = service.store.get(follow.taskId); invariant(followJob.status === 'succeeded', 'LIVE_QUERY_FAILED');
    const answer = service.store.db.prepare("SELECT answer_id FROM answer_artifacts WHERE job_task_id=? AND kind='final' AND state='ready'").get(follow.taskId)!;
    const reply = await artifacts.read(answer.answer_id as string, { role: 'delivery', scope });
    const inspected = meter.snapshot(), reads = inspected.tools.slice(beforeTools), captures = inspected.captures.filter(row => row.answerId === artifact.answer_id);
    observe('rawBytesIdentity', captures.length > 0 && captures.at(-1)!.sha256 === sha256(raw) && artifact.sha256 === sha256(raw),
      { captures, artifactSha256: artifact.sha256, bytes: raw.length, markerSha256: sha256(token), toolOutputContainsMarker: native.toolOutputContainsNonce });
    const after = await artifacts.read(artifact.answer_id as string, { role: 'delivery', scope });
    observe('artifactImmutable', sha256(raw) === sha256(after), { beforeSha256: sha256(raw), afterSha256: sha256(after) });
    const firstRange = reads.findIndex(row => row.tool === 'read_answer_range' && row.answerRef === artifact.answer_id && row.markerSeen);
    observe('progressiveDisclosure', firstRange >= 0 && reads.slice(0, firstRange).some(row => row.role === 'route' && ['list_interactions', 'search_interactions', 'read_answer_outline'].includes(row.tool)), reads);
    observe('answerContains', reply.toString('utf8').includes(token), { replySha256: sha256(reply), markerSha256: sha256(token) });
    observe('businessSubmitCount', beforeJobs === 1 && service.store.db.prepare("SELECT count(*) n FROM jobs WHERE kind='agent'").get()!.n === 1 && followJob.kind === 'command',
      { beforeJobs, afterJobs: service.store.db.prepare("SELECT count(*) n FROM jobs WHERE kind='agent'").get()!.n, queryJobKind: followJob.kind });
    observe('readScope', reads.filter(row => ['read_answer_outline', 'read_answer_range'].includes(row.tool)).length > 0 &&
      reads.filter(row => ['read_answer_outline', 'read_answer_range'].includes(row.tool)).every(row => row.role === 'route' && row.answerRef === artifact.answer_id),
      { scope, expectedAnswerRef: artifact.answer_id, reads });
    const ids = [id, follow.taskId], disclosure = bridgeDisclosure(service.store, ids);
    observe('bridgeNoRawBody', disclosure.complete && disclosure.pass && inspected.tools.every(row => row.role !== 'bridge' || !row.rawBodySeen), { disclosure, tools: inspected.tools });
    if (disclosure.complete) observe('noBridgeRawAnswerDisclosure', disclosure.pass && inspected.tools.every(row => row.role !== 'bridge' || !row.rawBodySeen), disclosure.actual);
    const work = ids.filter(value => service.store.get(value).kind === 'agent'), replay = replayEvidence(service.store, work);
    if (replay.complete) observe('noBusinessReplayAfterUncertain', replay.pass, replay.actual);
    const wires = ids.map(value => ({ source: service.store.db.prepare('SELECT raw_query_sha256 FROM orchestration_requests WHERE request_id=?').get(value)!.raw_query_sha256,
      bridge: service.store.value<{ textSha256: string }>('controller-wire:bridge:' + value)?.textSha256,
      business: service.store.value<{ textSha256: string }>('business-wire:' + value)?.textSha256, kind: service.store.get(value).kind }));
    observe('rawQueryMatchesSourceRequest', wires.every(row => row.source === row.bridge && (row.kind === 'agent' ? row.source === row.business : row.business === undefined)), wires);
    observe('permissionScopeValid', c.codex.sandbox === 'read-only' && !c.codex.networkAccess && JSON.parse(job.input_json).workspaceId === 'term4u', { sandbox: c.codex.sandbox, basis: 'configured fixture authorization, not OS isolation' });
    fixture.save('raw-final.sha256', { captures, native }); fixture.save('artifact-manifest.json', artifact); fixture.save('recap.json', observations.recapBound);
    fixture.save('bridge-input-audit.json', disclosure); fixture.save('tool-policy.json', disclosure); fixture.save('controller-input-audit.json', { disclosure, wires });
    fixture.save('history-tool-sequence.json', inspected.tools); fixture.save('read-ranges.json', reads); fixture.save('job-count.json', observations.businessSubmitCount);
  } catch (error) { failure = errorCode(error, 'LIVE_CASE_FAILED'); }
  finally {
    fixture.save('tool-observations.json', meter.snapshot());
    try { await fixture.close(); cleanupConfirmed = true; } catch (error) { failure = errorCode(error, 'LIVE_CLEANUP_FAILED'); }
    try { fault?.stop(); meter.stop(); } catch (error) { cleanupConfirmed = false; failure = errorCode(error); }
    fixture.save('observations.json', observations);
  }
  const assertions: AssertionResult[] = [...test.assertions, ...globals.map(predicate => ({ id: test.id + '-GLOBAL-' + predicate, predicate, expected: 'true' }))].map(a => {
    const observed = observations[a.predicate]; return observed ? { ...a, status: observed.pass ? 'PASS' : 'FAIL', actual: observed.actual, evidence: ['observations.json'] }
      : { ...a, status: failure ? 'FAIL' : 'BLOCKED', reason: failure ?? 'PREDICATE_ORACLE_NOT_IMPLEMENTED' };
  });
  const result = finalizeCase(test, attempt, globals, assertions);
  return failure ? { ...result, status: 'FAIL', failureCode: failure, cleanupConfirmed } : { ...result, cleanupConfirmed };
}
