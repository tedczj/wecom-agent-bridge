import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { Config } from '../../src/config.ts';
import { CodexBackend } from '../../src/codex.ts';
import { NativeCatalog } from '../../src/history/catalog.ts';
import { Catalog } from '../../src/routing/catalog.ts';
import { BusinessSessions } from '../../src/orchestration/business-sessions.ts';
import { conversationScope, sha256 } from '../../src/orchestration/requests.ts';
import { normalize } from '../../src/local.ts';
import { invariant, errorCode } from '../../src/errors.ts';
import { isolatedBusinessHome } from './isolated-home.ts';
import { seedPartialCatalog } from './partial-fixture.ts';
import { liveFixture } from './fixture.ts';
import { bridgeDisclosure } from './bridge-disclosure.ts';
import { finalizeCase, type AssertionResult, type CaseResult } from './report.ts';
import type { LiveCase } from './spec.ts';

export async function runPartialCase(base: Config, test: LiveCase, attempt: number, globals: string[], output: string): Promise<CaseResult> {
  invariant(test.id === 'LIVE-15', 'LIVE_SCENARIO_UNSUPPORTED');
  const isolated = await isolatedBusinessHome(base, path.join(output, 'native-home'));
  let fixture: Awaited<ReturnType<typeof liveFixture>> | undefined, failure: string | undefined, cleanupConfirmed = false;
  const originalList = NativeCatalog.prototype.listMetadata, originalResolve = BusinessSessions.prototype.resolve, originalRun = CodexBackend.prototype.run;
  const pages: Array<{ cursor?: string; nextCursor?: string; coverage: string; orderBasis: string; diagnostics: string[];
    entries: Array<{ nativeId: string; lastCompletedAt: number | null; updatedAt: number | null }> }> = [];
  const options: Array<{ requestId: string; intent: string; value: Awaited<ReturnType<typeof originalResolve>> }> = [];
  let businessCalls = 0;
  const listed: typeof originalList = async function (this: NativeCatalog, ...args) {
    const result = await originalList.apply(this, args);
    pages.push({ cursor: args[1], nextCursor: result.nextCursor, coverage: result.discoveryCoverage, orderBasis: result.orderBasis, diagnostics: result.diagnostics,
      entries: result.entries.map(e => ({ nativeId: e.ref.kind === 'codex' ? e.ref.threadId : e.ref.sessionId, lastCompletedAt: e.lastCompletedAt, updatedAt: e.updatedAt })) }); return result;
  };
  const resolved: typeof originalResolve = async function (this: BusinessSessions, ...args) {
    const value = await originalResolve.apply(this, args); options.push({ requestId: args[0].requestId, intent: args[2] ?? 'automatic', value }); return value;
  };
  const counted: typeof originalRun = function (this: CodexBackend, ...args) { businessCalls++; return originalRun.apply(this, args); };
  const observations: Record<string, { pass: boolean; actual: unknown }> = {};
  const observe = (predicate: string, pass: boolean, actual: unknown) => { observations[predicate] = { pass, actual }; };
  try {
    fixture = await liveFixture(isolated.config, output); const { service, c } = fixture;
    const model = c.models![c.orchestration!.business.defaultModelProfile]!, catalog = new Catalog(c), directory = catalog.configured.find(d => d.id === 'term4u')!;
    const target = catalog.target(directory, model), frame = { id: randomUUID(), session: 'fixture', text: test.steps[0]!.detail, images: [] };
    const scope = conversationScope(normalize(frame, c, 'local:codex').route), seed = seedPartialCatalog(c.codex.home, directory.path, model);
    const first = await new NativeCatalog(service.store, scope).listMetadata(target), next = await new NativeCatalog(service.store, scope).listMetadata(target, first.nextCursor);
    invariant(first.entries.length === 0 && first.discoveryCoverage === 'partial' && first.nextCursor && next.entries.length === 2 && next.orderBasis === 'updated-at', 'LIVE_PARTIAL_FIXTURE');
    invariant(seed.candidates[0]!.updatedAt > seed.candidates[1]!.updatedAt && seed.candidates[0]!.lastCompletedAt < seed.candidates[1]!.lastCompletedAt, 'LIVE_ORDER_FIXTURE');
    NativeCatalog.prototype.listMetadata = listed; BusinessSessions.prototype.resolve = resolved; CodexBackend.prototype.run = counted;
    const accepted = await service.accept(frame); invariant(accepted.taskId && !accepted.rejected, 'LIVE_REQUEST_REJECTED'); await service.settle();
    const id = accepted.taskId, jobs = service.store.db.prepare("SELECT task_id,status FROM jobs WHERE kind='agent'").all();
    const discovery = service.store.value('discovery-unverified:' + id);
    observe('businessSubmitCount', businessCalls === 0 && !service.store.value('business-wire:' + id), { businessCalls, agentJobs: jobs });
    observe('noFreshFallback', businessCalls === 0 && jobs.length === 0 && service.store.db.prepare('SELECT count(*) n FROM business_bindings').get()!.n === 0,
      { businessCalls, agentJobs: jobs, discovery });
    observe('explicitCoverage', pages.some(page => page.coverage === 'partial' && !!page.nextCursor) &&
      (options.length === 0 || options.some(row => row.value.discoveryCoverage === 'partial' && row.value.needsClarification && !!row.value.nextCursor)), { pages, options });
    observe('orderingCorrect', next.entries[0]!.ref.kind === 'codex' && next.entries[0]!.ref.threadId === seed.candidates[0]!.id &&
      pages.length > 0 && pages.every(page => page.orderBasis !== 'last-completed-response') &&
      options.every(row => row.value.orderBasis !== 'last-completed-response' && row.value.options.every(option => !option.isDefault)) && businessCalls === 0,
      { candidates: seed.candidates.map(({ file, ...metadata }) => metadata), options, businessCalls });
    const source = service.store.db.prepare('SELECT raw_query_sha256 FROM orchestration_requests WHERE request_id=?').get(id)!.raw_query_sha256;
    const wires = ['controller-wire:bridge:', 'controller-wire:route:'].map(prefix => service.store.value<{ textSha256: string }>(prefix + id));
    observe('rawQueryMatchesSourceRequest', source === sha256(frame.text) && wires.every(w => w?.textSha256 === source) && !service.store.value('business-wire:' + id), { source, wires });
    observe('permissionScopeValid', c.codex.home !== base.codex.home && c.codex.sandbox === 'read-only' && !c.codex.networkAccess && businessCalls === 0,
      { isolatedNativeHome: true, sandbox: c.codex.sandbox, businessCalls, basis: 'host fixture scope; not OS isolation' });
    observe('noBusinessReplayAfterUncertain', businessCalls === 0 && !service.store.value('business-prompt-admissions:' + id), { businessCalls, uncertaintyExercised: false });
    const disclosure = bridgeDisclosure(service.store, [id]); if (disclosure.complete) observe('noBridgeRawAnswerDisclosure', disclosure.pass, disclosure.actual);
    fixture.save('catalog-pages.json', { seed, observedPages: pages }); fixture.save('coverage.json', { discovery, options });
    fixture.save('selection-log.json', { businessCalls, jobs, options });
  } catch (error) { failure = errorCode(error, 'LIVE_CASE_FAILED'); }
  finally {
    let restored = true;
    if (NativeCatalog.prototype.listMetadata === listed) NativeCatalog.prototype.listMetadata = originalList;
    else if (NativeCatalog.prototype.listMetadata !== originalList) restored = false;
    if (BusinessSessions.prototype.resolve === resolved) BusinessSessions.prototype.resolve = originalResolve;
    else if (BusinessSessions.prototype.resolve !== originalResolve) restored = false;
    if (CodexBackend.prototype.run === counted) CodexBackend.prototype.run = originalRun;
    else if (CodexBackend.prototype.run !== originalRun) restored = false;
    try { await fixture?.close(); cleanupConfirmed = restored; } catch (error) { failure = errorCode(error, 'LIVE_CLEANUP_FAILED'); }
    if (!restored) failure = 'LIVE_METER_RESTORE_CONFLICT';
    isolated.close(); fixture?.save('observations.json', observations);
  }
  const assertions: AssertionResult[] = [...test.assertions, ...globals.map(predicate => ({ id: test.id + '-GLOBAL-' + predicate, predicate, expected: 'true' }))].map(a => {
    const observed = observations[a.predicate]; return observed ? { ...a, status: observed.pass ? 'PASS' : 'FAIL', actual: observed.actual, evidence: ['observations.json'] }
      : { ...a, status: failure ? 'FAIL' : 'BLOCKED', reason: failure ?? 'PREDICATE_ORACLE_NOT_IMPLEMENTED' };
  });
  const result = finalizeCase(test, attempt, globals, assertions);
  return failure ? { ...result, status: 'FAIL', failureCode: failure, cleanupConfirmed } : { ...result, cleanupConfirmed };
}
