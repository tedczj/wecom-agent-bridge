import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Config } from '../../src/config.ts';
import type { NormalizedInput, SessionRef } from '../../src/types.ts';
import { Catalog } from '../../src/routing/catalog.ts';
import { NativeCatalog, historyRevision, type CandidateMetadata } from '../../src/history/catalog.ts';
import { NativeReader } from '../../src/history/reader.ts';
import { invariant, errorCode } from '../../src/errors.ts';
import { sha256 } from '../../src/orchestration/requests.ts';
import { isolatedBusinessHome } from './isolated-home.ts';
import { liveFixture } from './fixture.ts';
import { bridgeDisclosure } from './bridge-disclosure.ts';
import { replayEvidence } from './replay.ts';
import { finalizeCase, type AssertionResult, type CaseResult } from './report.ts';
import type { LiveCase } from './spec.ts';

export async function runLargeHistoryCase(base: Config, test: LiveCase, attempt: number, globals: string[], output: string): Promise<CaseResult> {
  invariant(test.id === 'LIVE-13', 'LIVE_SCENARIO_UNSUPPORTED');
  const isolated = await isolatedBusinessHome(base, path.join(output, 'native-home'));
  let fixture: Awaited<ReturnType<typeof liveFixture>> | undefined, failure: string | undefined, cleanupConfirmed = false;
  const inspect = NativeReader.prototype.inspect, locate = NativeCatalog.prototype.locateExact;
  const reads: Array<{ fileSha256: string; refSha256: string }> = [], lookups: string[] = [];
  const observedRead: typeof inspect = function (this: NativeReader, ...args) {
    reads.push({ fileSha256: sha256(args[1].file), refSha256: sha256(JSON.stringify(args[1].ref)) }); return inspect.apply(this, args);
  };
  const observedLocate: typeof locate = function (this: NativeCatalog, ...args) { lookups.push(sha256(JSON.stringify(args[1]))); return locate.apply(this, args); };
  const observations: Record<string, { pass: boolean; actual: unknown }> = {};
  const observe = (predicate: string, pass: boolean, actual: unknown) => { observations[predicate] = { pass, actual }; };
  try {
    fixture = await liveFixture(isolated.config, output); const { service, c } = fixture;
    const first = await service.accept({ id: randomUUID(), session: 'fixture', text: `在 term4u 记住本会话校验词 ${randomUUID()}。只回复“已记住”，不要使用工具或修改文件。`, images: [] });
    invariant(first.taskId && !first.rejected, 'LIVE_SETUP_REJECTED'); await service.settle();
    const before = service.store.get(first.taskId); invariant(before.kind === 'agent' && before.status === 'succeeded', 'LIVE_SETUP_INCOMPLETE');
    const input = JSON.parse(before.input_json) as NormalizedInput, scope = service.store.db.prepare('SELECT conversation_scope FROM orchestration_requests WHERE request_id=?').get(first.taskId)!.conversation_scope as string;
    const target = new Catalog(c).target(input.routing!.directory, input.routing!.execution), ref = JSON.parse(service.store.session(before.session_key).agent_ref_json!) as SessionRef;
    const healthy = await new NativeCatalog(service.store, scope).locateExact(target, ref);
    const syntheticId = randomUUID(), file = path.join(c.codex.home, 'sessions', syntheticId + '.jsonl');
    const header = JSON.stringify({ type: 'session_meta', payload: { id: syntheticId, cwd: target.directory.path, timestamp: new Date(Date.now() - 86400000).toISOString() } });
    const largeLine = JSON.stringify({ type: 'response_item', payload: { type: 'function_call_output', call_id: 'synthetic-old-tool', output: 'x'.repeat(9 * 1024 * 1024) } });
    writeFileSync(file, header + '\n' + largeLine + '\n', { mode: 0o600, flag: 'wx' });
    const candidate: CandidateMetadata = { ref: { kind: 'codex', threadId: syntheticId }, file, title: 'synthetic unrelated old tool record',
      createdAt: Date.now() - 86400000, updatedAt: null, lastCompletedAt: null, role: 'external', sourceRevision: historyRevision(file) };
    // Inspect the synthetic record separately before auditing the real resume;
    // its warning must not become a global refusal of the healthy exact target.
    const diagnostic = await new NativeReader().inspect(target, candidate);
    NativeReader.prototype.inspect = observedRead; NativeCatalog.prototype.locateExact = observedLocate;
    const accepted = await service.accept({ id: randomUUID(), session: 'fixture', text: test.steps[0]!.detail, images: [] });
    invariant(accepted.taskId && !accepted.rejected, 'LIVE_REQUEST_REJECTED'); await service.settle();
    const id = accepted.taskId, job = service.store.get(id), afterRef = service.store.session(job.session_key).agent_ref_json;
    const admissions = service.store.value<Array<{ admitted: boolean }>>('business-prompt-admissions:' + id) ?? [];
    observe('resumeNoDiscoveryScan', lookups.length > 0 && lookups.every(value => value === sha256(JSON.stringify(ref))) && reads.length > 0 && reads.every(row => row.fileSha256 === sha256(healthy.file)),
      { lookups, reads, syntheticFileSha256: sha256(file), basis: 'real NativeReader inspection calls during bound resume; independent diagnostic excluded' });
    observe('selectedNativeSession', job.session_key === before.session_key && afterRef === JSON.stringify(ref), { beforeRefSha256: sha256(JSON.stringify(ref)), afterRefSha256: afterRef ? sha256(afterRef) : null });
    observe('businessSubmitCount', job.kind === 'agent' && job.status === 'succeeded' && admissions.filter(row => row.admitted).length === 1 &&
      service.store.db.prepare("SELECT count(*) n FROM jobs WHERE kind='agent'").get()!.n === 2, { status: job.status, admissions });
    observe('diagnosticIsolation', diagnostic.page.contentTruncated && diagnostic.page.omittedKinds.includes('oversized-string') && job.status === 'succeeded' && job.error_code === null,
      { syntheticHistory: true, diagnostic: { activity: diagnostic.activity, incomplete: diagnostic.incomplete, omittedKinds: diagnostic.page.omittedKinds }, actualJob: { status: job.status, errorCode: job.error_code } });
    const ids = [first.taskId, id], wires = ids.map(requestId => ({ source: service.store.db.prepare('SELECT raw_query_sha256 FROM orchestration_requests WHERE request_id=?').get(requestId)!.raw_query_sha256,
      business: service.store.value<{ textSha256: string }>('business-wire:' + requestId), bridge: service.store.value<{ textSha256: string }>('controller-wire:bridge:' + requestId), route: service.store.value<{ textSha256: string }>('controller-wire:route:' + requestId) }));
    observe('rawQueryMatchesSourceRequest', wires.every(row => [row.business, row.bridge, row.route].every(sent => sent?.textSha256 === row.source)), wires);
    observe('permissionScopeValid', c.codex.home !== base.codex.home && c.codex.sandbox === 'read-only' && !c.codex.networkAccess && target.directory.path === path.join(fixture.projectRoot, 'term4u'),
      { isolatedNativeHome: true, sandbox: c.codex.sandbox, basis: 'host fixture scope, not OS isolation' });
    const disclosure = bridgeDisclosure(service.store, ids), replay = replayEvidence(service.store, ids);
    if (disclosure.complete) observe('noBridgeRawAnswerDisclosure', disclosure.pass, disclosure.actual);
    if (replay.complete) observe('noBusinessReplayAfterUncertain', replay.pass, replay.actual);
    // Keep post-run evidence collection separate from the observed resume reads.
    NativeReader.prototype.inspect = inspect; NativeCatalog.prototype.locateExact = locate;
    fixture.save('fixture-history-manifest.json', { syntheticHistory: true, bytesInOneLine: Buffer.byteLength(largeLine), fileSha256: sha256(header + '\n' + largeLine + '\n'), realSessionRefSha256: sha256(JSON.stringify(ref)) });
    fixture.save('file-read-audit.json', { reads, lookups }); fixture.save('resume-result.json', { jobId: id, status: job.status, errorCode: job.error_code });
  } catch (error) { failure = errorCode(error, 'LIVE_CASE_FAILED'); }
  finally {
    let restored = true;
    if (NativeReader.prototype.inspect === observedRead) NativeReader.prototype.inspect = inspect; else if (NativeReader.prototype.inspect !== inspect) restored = false;
    if (NativeCatalog.prototype.locateExact === observedLocate) NativeCatalog.prototype.locateExact = locate; else if (NativeCatalog.prototype.locateExact !== locate) restored = false;
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
