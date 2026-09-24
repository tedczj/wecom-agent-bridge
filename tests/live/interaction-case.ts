import { randomUUID } from 'node:crypto';
import { statfsSync } from 'node:fs';
import type { Config } from '../../src/config.ts';
import { invariant, errorCode } from '../../src/errors.ts';
import { normalize } from '../../src/local.ts';
import { ArtifactStore } from '../../src/answers/artifact-store.ts';
import { RecapService } from '../../src/answers/recap.ts';
import { listInteractions } from '../../src/answers/projection.ts';
import { RequestStore, sha256 } from '../../src/orchestration/requests.ts';
import type { ToolAuditRecord } from '../../src/orchestration/audit.ts';
import { controllerConfigurationDigest } from '../../src/controllers/factory.ts';
import { liveFixture } from './fixture.ts';
import { historyMeter, directoryAnswerMatches } from './history-meter.ts';
import { bridgeDisclosure } from './bridge-disclosure.ts';
import { replayEvidence } from './replay.ts';
import { finalizeCase, type AssertionResult, type CaseResult } from './report.ts';
import type { LiveCase } from './spec.ts';

export async function runInteractionCase(base: Config, test: LiveCase, attempt: number, globals: string[], output: string): Promise<CaseResult> {
  invariant(test.id === 'LIVE-30', 'LIVE_SCENARIO_UNSUPPORTED');
  const fixture = await liveFixture(base, output), { service, c } = fixture, canary = randomUUID();
  const meter = historyMeter(canary), setupIds: string[] = [], queryIds: string[] = [];
  const observations: Record<string, { pass: boolean; actual: unknown }> = {};
  let failure: string | undefined, cleanupConfirmed = false;
  const observe = (predicate: string, pass: boolean, actual: unknown) => { observations[predicate] = { pass, actual }; };
  try {
    const configDigest = await controllerConfigurationDigest(c.orchestration!.controllerRuntime.home, c.models![c.orchestration!.bridge.modelProfile]!);
    const artifacts = new ArtifactStore(service.store, c.orchestration!.answers.root), requests = new RequestStore(service.store);
    let liveScope = '', directoryA = '';
    for (let n = 1; n <= 31; n++) {
      const free = statfsSync(fixture.root, { bigint: true }); invariant(free.bavail * free.bsize >= 2n * 1024n ** 3n, 'LIVE_DISK_RESERVE');
      invariant(await controllerConfigurationDigest(c.orchestration!.controllerRuntime.home, c.models![c.orchestration!.bridge.modelProfile]!) === configDigest, 'LIVE_SHARED_CONFIG_CHANGED');
      const project = n % 2 ? 'term4u' : 'doc-ocr-service', label = 'R' + String(n).padStart(2, '0') + ' ' + project;
      const accepted = await service.accept({ id: randomUUID(), session: 'fixture', text: `在 ${project}，本轮编号 R${String(n).padStart(2, '0')}。只回复“${label}”，不要调用工具，不要修改文件。`, images: [] });
      invariant(accepted.taskId && !accepted.rejected, 'LIVE_SETUP_REJECTED'); await service.settle();
      const job = service.store.get(accepted.taskId); invariant(job.kind === 'agent' && job.status === 'succeeded', 'LIVE_SETUP_INCOMPLETE');
      const row = service.store.db.prepare(`SELECT r.conversation_scope,i.directory_identity,i.answer_id FROM orchestration_requests r
        JOIN interaction_records i ON i.request_id=r.request_id WHERE r.request_id=?`).get(accepted.taskId)!;
      const answer = await artifacts.read(row.answer_id as string, { role: 'delivery', scope: row.conversation_scope as string });
      invariant(answer.toString('utf8').trim() === label, 'LIVE_SETUP_LABEL_MISMATCH');
      liveScope = row.conversation_scope as string; if (n === 1) directoryA = row.directory_identity as string;
      setupIds.push(accepted.taskId);
      fixture.save('setup-progress.json', { completed: n, required: 31, requestIds: setupIds, model: c.models![c.orchestration!.business.defaultModelProfile], negativeFixture: 'synthetic host record; no model call' });
      process.stderr.write(JSON.stringify({ event: 'live.interaction_setup_completed', attempt, completed: n, required: 31 }) + '\n');
    }
    // Put the synthetic foreign record newest and in directory A: a missing
    // scope filter must expose it in either query, rather than hide it off-page.
    const negative = requests.accept(normalize({ id: randomUUID(), session: 'foreign-negative', text: 'PRIVATE_TITLE_' + canary, images: [] }, c, 'local:codex')).request;
    const foreignAnswer = artifacts.stage(negative.request_id, 'system'); artifacts.capture(foreignAnswer.answer_id, 'PRIVATE_ANSWER_' + canary);
    await artifacts.publish(foreignAnswer.answer_id, { backend: 'system', requestId: negative.request_id, completed: true, phase: 'completed', outcome: 'succeeded' },
      () => requests.transition(negative.request_id, negative.conversation_scope, ['accepted'], 'completed'));
    const recap = await new RecapService(service.store, artifacts, undefined, 'synthetic-negative').run(foreignAnswer.answer_id, negative.conversation_scope);
    service.store.db.prepare(`INSERT INTO interaction_records(request_id,conversation_scope,directory_identity,kind,producer_role,answer_id,recap_id,completed_at)
      VALUES (?,?,?,'control','system',?,?,?)`).run(negative.request_id, negative.conversation_scope, directoryA, foreignAnswer.answer_id, recap.recap_id, Date.now());
    const modelCountBefore = service.store.db.prepare("SELECT count(*) n FROM jobs WHERE kind='agent'").get()!.n;
    const pages = [];
    for (const step of test.steps) {
      const offset = meter.snapshot().length;
      const accepted = await service.accept({ id: randomUUID(), session: 'fixture', text: step.detail, images: [] });
      invariant(accepted.taskId && !accepted.rejected, 'LIVE_REQUEST_REJECTED'); queryIds.push(accepted.taskId); await service.settle();
      invariant(service.store.get(accepted.taskId).status === 'succeeded', 'LIVE_QUERY_NOT_COMPLETED');
      const captured = meter.snapshot().slice(offset), audit = service.store.value<ToolAuditRecord[]>('tool-audit:' + accepted.taskId) ?? [];
      invariant(captured.every(page => audit.some(row => row.role === page.role && row.callId === page.callId && row.status === 'returned' && row.resultSha256 === page.resultSha256)), 'LIVE_HISTORY_WIRE_MISMATCH');
      pages.push(captured);
    }
    const expected = setupIds.slice(1).reverse(), conversationPage = pages[0]!.find(page => page.scope === 'conversation' && JSON.stringify(page.entries.map(e => e.requestId)) === JSON.stringify(expected));
    observe('interactionPageCount', !!conversationPage && conversationPage.entries.length === 30, { expectedIds: expected, captured: pages[0] });
    const oldest = conversationPage?.entries.at(-1)?.ingressSeq;
    const next = oldest ? listInteractions(service.store, liveScope, { beforeSeq: oldest }) : [];
    observe('interactionOrder', !!conversationPage && conversationPage.entries.every((row, i, rows) => i === 0 || rows[i - 1]!.ingressSeq > row.ingressSeq) &&
      next.length === 1 && next[0]!.requestId === setupIds[0], { firstPageIds: conversationPage?.entries.map(e => e.requestId), beforeSeq: oldest,
        nextPageIds: next.map(e => e.requestId), basis: 'actual model page followed by production cursor lookup over the same real records' });
    const secondSeq = service.store.db.prepare('SELECT ingress_seq FROM orchestration_requests WHERE request_id=?').get(queryIds[1]!)!.ingress_seq as number;
    const directoryPage = listInteractions(service.store, liveScope, { directoryIdentity: directoryA, beforeSeq: secondSeq });
    const filtered = pages[1]!.find(page => page.scope === 'directory' && JSON.stringify(page.entries.map(e => e.requestId)) === JSON.stringify(directoryPage.map(e => e.requestId)));
    const answers = [];
    for (const id of queryIds) {
      const answer = service.store.db.prepare("SELECT answer_id FROM answer_artifacts WHERE request_id=? AND kind='final' AND state='ready'").get(id)!;
      answers.push((await artifacts.read(answer.answer_id as string, { role: 'delivery', scope: liveScope })).toString('utf8'));
    }
    const expectedRows = filtered?.entries ?? conversationPage?.entries.filter(row => row.directoryIdentity === directoryA) ?? [];
    const labels = expectedRows.filter(row => setupIds.includes(row.requestId)).map(row => 'R' + String(setupIds.indexOf(row.requestId) + 1).padStart(2, '0'));
    observe('directoryFilter', expectedRows.length > 0 && expectedRows.every(e => e.directoryIdentity === directoryA) && directoryAnswerMatches(answers[1]!, labels),
      { expectedDirectoryIdentity: directoryA, captured: pages[1], expectedIds: expectedRows.map(e => e.requestId), expectedLabels: labels,
        answerSha256: sha256(answers[1]!), basis: filtered ? 'fresh directory page and final answer' : 'filtering the actual preceding 30-row model input and final answer' });
    observe('readScope', answers.every(answer => !answer.includes(canary) && !answer.includes(foreignAnswer.answer_id)) && pages.flat().length > 0 && pages.flat().every(page => !page.foreignCanarySeen && page.entries.every(row => row.requestId !== negative.request_id && row.answerRef !== foreignAnswer.answer_id)),
      { negativeRequestId: negative.request_id, negativeAnswerRef: foreignAnswer.answer_id, canarySha256: sha256(canary), pages: pages.flat() });
    const modelCountAfter = service.store.db.prepare("SELECT count(*) n FROM jobs WHERE kind='agent'").get()!.n;
    observe('businessSubmitCount', modelCountBefore === 31 && modelCountAfter === modelCountBefore && queryIds.every(id => !service.store.value('business-wire:' + id)), { before: modelCountBefore, after: modelCountAfter });
    const allIds = [...setupIds, ...queryIds], workJobs = setupIds.map(id => service.store.get(id));
    const wires = allIds.map(id => ({ id, kind: service.store.get(id).kind, source: service.store.db.prepare('SELECT raw_query_sha256 FROM orchestration_requests WHERE request_id=?').get(id)!.raw_query_sha256,
      business: service.store.value<{ textSha256: string }>('business-wire:' + id), bridge: service.store.value<{ textSha256: string }>('controller-wire:bridge:' + id), route: service.store.value<{ textSha256: string }>('controller-wire:route:' + id) }));
    observe('rawQueryMatchesSourceRequest', wires.every(w => w.bridge?.textSha256 === w.source && (w.kind === 'agent' ? w.business?.textSha256 === w.source && w.route?.textSha256 === w.source : !w.business && (!w.route || w.route.textSha256 === w.source))), wires);
    observe('permissionScopeValid', workJobs.every(job => ['term4u', 'doc-ocr-service'].includes(JSON.parse(job.input_json).workspaceId)) && c.codex.sandbox === 'read-only' && !c.codex.networkAccess,
      { sandbox: c.codex.sandbox, networkAccess: c.codex.networkAccess, basis: 'host fixture profile, not OS isolation' });
    const disclosure = bridgeDisclosure(service.store, allIds), replay = replayEvidence(service.store, setupIds);
    if (disclosure.complete) observe('noBridgeRawAnswerDisclosure', disclosure.pass, disclosure.actual);
    if (replay.complete) observe('noBusinessReplayAfterUncertain', replay.pass, replay.actual);
    fixture.save('interaction-page.json', pages[0]); fixture.save('directory-page.json', pages[1]);
    fixture.save('pagination-cursors.json', { beforeSeq: oldest, nextPageIds: next.map(e => e.requestId) });
    fixture.save('scope-negative-check.json', observations.readScope);
    fixture.save('model-invocations.json', { setupRequestIds: setupIds, queryRequestIds: queryIds, businessBeforeQueries: modelCountBefore, businessAfterQueries: modelCountAfter,
      internalToolCalls: allIds.reduce((n, id) => n + (service.store.value<ToolAuditRecord[]>('tool-audit:' + id)?.length ?? 0), 0),
      recapEvents: service.store.db.prepare(`SELECT r.source,r.state,count(*) count FROM answer_recaps r JOIN answer_artifacts a ON a.answer_id=r.answer_id
        JOIN orchestration_requests q ON q.request_id=a.request_id WHERE q.conversation_scope=? GROUP BY r.source,r.state`).all(liveScope),
      negativeFixture: 'synthetic host record; excluded from live invocation counts' });
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
