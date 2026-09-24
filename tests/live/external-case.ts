import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { Config } from '../../src/config.ts';
import type { NormalizedInput, SessionRef } from '../../src/types.ts';
import { CodexBackend } from '../../src/codex.ts';
import { Catalog } from '../../src/routing/catalog.ts';
import { NativeCatalog } from '../../src/history/catalog.ts';
import { ArtifactStore } from '../../src/answers/artifact-store.ts';
import { normalize } from '../../src/local.ts';
import { invariant, errorCode } from '../../src/errors.ts';
import { sha256, conversationScope } from '../../src/orchestration/requests.ts';
import { isolatedBusinessHome } from './isolated-home.ts';
import { liveFixture } from './fixture.ts';
import { nativeContextAudit } from './native-context.ts';
import { bridgeDisclosure } from './bridge-disclosure.ts';
import { replayEvidence } from './replay.ts';
import { remoteWriteEvidence } from './remote-writes.ts';
import { finalizeCase, type AssertionResult, type CaseResult } from './report.ts';
import type { LiveCase } from './spec.ts';

export async function runExternalCase(base: Config, test: LiveCase, attempt: number, globals: string[], output: string): Promise<CaseResult> {
  invariant(test.id === 'LIVE-12', 'LIVE_SCENARIO_UNSUPPORTED');
  const isolated = await isolatedBusinessHome(base, path.join(output, 'native-home'));
  let fixture: Awaited<ReturnType<typeof liveFixture>> | undefined, failure: string | undefined, cleanupConfirmed = false;
  const observations: Record<string, { pass: boolean; actual: unknown }> = {};
  const observe = (predicate: string, pass: boolean, actual: unknown) => { observations[predicate] = { pass, actual }; };
  try {
    fixture = await liveFixture(isolated.config, output); const { service, c } = fixture, nonce = randomUUID(), beforeGit = fixture.gitState();
    const catalog = new Catalog(c), directory = catalog.configured.find(row => row.id === 'term4u')!, model = c.models![c.orchestration!.business.defaultModelProfile]!;
    const target = catalog.target(directory, model);
    const incoming = normalize({ id: randomUUID(), session: 'fixture', text: `记住本会话校验词 ${nonce}。只回复“已记住”，不要使用工具或修改文件。`, images: [] }, c, 'local:codex');
    const external: NormalizedInput = { taskId: randomUUID(), messageId: incoming.messageId, route: incoming.route, receivedAt: incoming.receivedAt,
      text: incoming.text, images: [], workspaceId: directory.id, sessionKey: 'external-fixture-' + randomUUID(), generation: 0 };
    const backend = new CodexBackend(target.config, undefined, undefined, true), refs: SessionRef[] = [], events: string[] = [];
    let first;
    try { first = await backend.run(external, undefined, { persistSession: async ref => { refs.push(ref); }, progress: event => events.push(event.type) }, new AbortController().signal); }
    finally { await backend.stop(); }
    invariant(first.outcome === 'success' && first.finishEvidence?.cleanupConfirmed && refs.length === 1 && refs[0]!.kind === 'codex', 'LIVE_EXTERNAL_SETUP_FAILED');
    invariant(service.store.db.prepare('SELECT count(*) n FROM jobs').get()!.n === 0 && service.store.db.prepare('SELECT count(*) n FROM business_bindings').get()!.n === 0, 'LIVE_EXTERNAL_NOT_INDEPENDENT');
    const scope = conversationScope(incoming.route), native = new NativeCatalog(service.store, scope), page = await native.listMetadata(target);
    const expected = refs[0]!, before = await native.locateExact(target, expected);
    fixture.save('external-cli-session.json', { source: 'real CodexBackend CLI invocation outside Bridge ingress/store', nativeRefSha256: sha256(JSON.stringify(expected)),
      querySha256: sha256(incoming.text), nonceSha256: sha256(nonce), finish: first.finishEvidence, events, sourceRevision: before.sourceRevision });
    observe('nativeDiscovery', page.discoveryCoverage === 'complete' && page.entries.length === 1 && JSON.stringify(page.entries[0]!.ref) === JSON.stringify(expected) && page.entries[0]!.role === 'external',
      { coverage: page.discoveryCoverage, orderBasis: page.orderBasis, entries: page.entries.map(row => ({ refSha256: sha256(JSON.stringify(row.ref)), role: row.role })) });
    const accepted = await service.accept({ id: randomUUID(), session: 'fixture', text: test.steps[0]!.detail, images: [] });
    invariant(accepted.taskId && !accepted.rejected, 'LIVE_REQUEST_REJECTED'); await service.settle();
    const id = accepted.taskId, job = service.store.get(id); invariant(job.kind === 'agent' && job.status === 'succeeded', 'LIVE_BUSINESS_NOT_COMPLETED');
    const observedRef = service.store.session(job.session_key).agent_ref_json;
    observe('selectedNativeSession', observedRef === JSON.stringify(expected), { expectedRefSha256: sha256(JSON.stringify(expected)), observedRefSha256: sha256(observedRef!) });
    const artifact = service.store.db.prepare("SELECT answer_id FROM answer_artifacts WHERE job_task_id=? AND kind='final' AND state='ready'").get(id)!;
    const answer = await new ArtifactStore(service.store, c.orchestration!.answers.root).read(artifact.answer_id as string, { role: 'delivery', scope });
    observe('answerEquals', answer.toString('utf8').trim() === nonce, { answerSha256: sha256(answer), expectedSha256: sha256(nonce) });
    const audit = await nativeContextAudit(service.store, c, job, nonce);
    const source = service.store.db.prepare('SELECT raw_query_sha256 FROM orchestration_requests WHERE request_id=?').get(id)!.raw_query_sha256;
    const wires = ['business-wire:', 'controller-wire:bridge:', 'controller-wire:route:'].map(prefix => service.store.value<{ textSha256: string }>(prefix + id));
    const exact = source === sha256(test.steps[0]!.detail) && wires.every(row => row?.textSha256 === source) && audit.inputs.some(row => row.completed && row.textSha256 === source);
    observe('queryByteIdentity', exact, { source, wires, native: audit }); observe('rawQueryMatchesSourceRequest', exact, { source, wires });
    const management = service.store.db.prepare("SELECT native_id FROM native_session_catalog WHERE role IN ('bridge','route','recap')").all().map(row => row.native_id);
    const after = await native.listMetadata(target);
    observe('managementExcluded', management.length >= 2 && after.entries.every(row => row.ref.kind === 'codex' && !management.includes(row.ref.threadId)),
      { managementIds: management, candidates: after.entries.map(row => row.ref.kind === 'codex' ? row.ref.threadId : row.ref.sessionId) });
    observe('permissionScopeValid', c.codex.home !== base.codex.home && target.directory.path === path.join(fixture.projectRoot, 'term4u') && c.codex.sandbox === 'read-only' && !c.codex.networkAccess,
      { isolatedNativeHome: true, sandbox: c.codex.sandbox, basis: 'host fixture authorization; not OS isolation' });
    const disclosure = bridgeDisclosure(service.store, [id]), replay = replayEvidence(service.store, [id]);
    if (disclosure.complete) observe('noBridgeRawAnswerDisclosure', disclosure.pass, disclosure.actual);
    if (replay.complete) observe('noBusinessReplayAfterUncertain', replay.pass, replay.actual);
    const remote = remoteWriteEvidence(service.store, [id], [audit], beforeGit, fixture.gitState());
    if (remote.complete) observe('noProductionRemoteWrites', remote.pass, remote.actual);
    fixture.save('remote-write-audit.json', remote);
    fixture.save('catalog.json', observations.nativeDiscovery); fixture.save('resume-events.json', audit); fixture.save('business-input.sha256', { source, wire: wires[0] });
  } catch (error) { failure = errorCode(error, 'LIVE_CASE_FAILED'); }
  finally { try { await fixture?.close(); cleanupConfirmed = true; } catch (error) { failure = errorCode(error, 'LIVE_CLEANUP_FAILED'); } isolated.close(); fixture?.save('observations.json', observations); }
  const assertions: AssertionResult[] = [...test.assertions, ...globals.map(predicate => ({ id: test.id + '-GLOBAL-' + predicate, predicate, expected: 'true' }))].map(a => {
    const observed = observations[a.predicate]; return observed ? { ...a, status: observed.pass ? 'PASS' : 'FAIL', actual: observed.actual, evidence: ['observations.json'] }
      : { ...a, status: failure ? 'FAIL' : 'BLOCKED', reason: failure ?? 'PREDICATE_ORACLE_NOT_IMPLEMENTED' };
  });
  const result = finalizeCase(test, attempt, globals, assertions);
  return failure ? { ...result, status: 'FAIL', failureCode: failure, cleanupConfirmed } : { ...result, cleanupConfirmed };
}
