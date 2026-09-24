import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import type { Config } from '../../src/config.ts';
import type { NormalizedInput, SessionRef } from '../../src/types.ts';
import { CodexBackend } from '../../src/codex.ts';
import { Catalog } from '../../src/routing/catalog.ts';
import { NativeCatalog } from '../../src/history/catalog.ts';
import { NativeReader } from '../../src/history/reader.ts';
import { ResumeVerifier } from '../../src/history/verifier.ts';
import { CodexWriterReadiness } from '../../src/history/writer-readiness.ts';
import { invariant, errorCode } from '../../src/errors.ts';
import { readControlled, inside } from '../../src/fsutil.ts';
import { sha256 } from '../../src/orchestration/requests.ts';
import { isolatedBusinessHome } from './isolated-home.ts';
import { liveFixture } from './fixture.ts';
import { corruptPrivateHistory } from './corrupt-history.ts';
import { bridgeDisclosure } from './bridge-disclosure.ts';
import { nativeContextAudit } from './native-context.ts';
import type { LiveCase } from './spec.ts';
import { finalizeCase, type AssertionResult, type CaseResult } from './report.ts';

export async function runCorruptCase(base: Config, test: LiveCase, attempt: number, globals: string[], output: string): Promise<CaseResult> {
  invariant(test.id === 'LIVE-14', 'LIVE_SCENARIO_UNSUPPORTED');
  const isolated = await isolatedBusinessHome(base, path.join(output, 'native-home'));
  const branches: Array<Record<string, unknown>> = []; let failure: string | undefined, cleanupConfirmed = true;
  try {
    for (const variant of ['binding', 'explicit-resume']) {
      const evidence = path.join(output, variant); mkdirSync(evidence, { mode: 0o700 });
      const fixture = await liveFixture(isolated.config, evidence, 'workspace-write'), { service, c } = fixture;
      const originalRun = CodexBackend.prototype.run; let submits = 0;
      const counted: typeof originalRun = function (this: CodexBackend, ...args) { submits++; return originalRun.apply(this, args); };
      try {
        const setup = await service.accept({ id: randomUUID(), session: 'fixture', text: '在 term4u 建立业务会话，只回复“已就绪”，不要使用工具或修改文件。', images: [] });
        invariant(setup.taskId && !setup.rejected, 'LIVE_SETUP_REJECTED'); await service.settle();
        const job = service.store.get(setup.taskId); invariant(job.kind === 'agent' && job.status === 'succeeded', 'LIVE_SETUP_INCOMPLETE');
        const input = JSON.parse(job.input_json) as NormalizedInput, scope = service.store.db.prepare('SELECT conversation_scope FROM orchestration_requests WHERE request_id=?').get(job.task_id)!.conversation_scope as string;
        const target = new Catalog(c).target(input.routing!.directory, input.routing!.execution), ref = JSON.parse(service.store.session(job.session_key).agent_ref_json!) as SessionRef;
        invariant(ref.kind === 'codex' && target.config.codex.home === isolated.config.codex.home && target.digest === input.routing!.digest, 'LIVE_ISOLATED_HISTORY_SCOPE');
        const catalog = new NativeCatalog(service.store, scope), candidate = await catalog.locateExact(target, ref);
        const verifier = new ResumeVerifier(new NativeReader(), new CodexWriterReadiness());
        const healthy = await verifier.verify(target, candidate, target.digest);
        if (variant === 'explicit-resume') {
          const list = await service.accept({ id: randomUUID(), session: 'fixture', text: '/sessions term4u', images: [] });
          invariant(list.taskId && !list.rejected, 'LIVE_LIST_REJECTED'); await service.settle();
          const snapshot = service.store.value<{ entries: Array<{ nativeId: string }> }>('session-list:' + scope);
          invariant(snapshot?.entries.length === 1 && snapshot.entries[0]!.nativeId === ref.threadId, 'LIVE_EXPLICIT_REFERENCE_MISSING');
        }
        const before = fixture.gitState(), beforeRef = service.store.session(job.session_key).agent_ref_json;
        const native = await nativeContextAudit(service.store, c, job, 'unused-remote-audit-marker'); fixture.save('native-before-corruption.json', native);
        const setupAdmissions = JSON.stringify(service.store.value('business-prompt-admissions:' + job.task_id));
        const bytes = await readControlled(path.join(c.codex.home, 'sessions'), candidate.file, 4194304);
        const mutation = await corruptPrivateHistory(c.codex.home, candidate.file, ref.threadId, target.directory.path, sha256(bytes), path.join(fixture.projectRoot, 'doc-ocr-service'));
        let directDenial = 'ACCEPTED';
        try { await verifier.verify(target, await catalog.locateExact(target, ref), target.digest); } catch (error) { directDenial = errorCode(error); }
        invariant(directDenial === 'HISTORY_SCOPE', 'LIVE_FAULT_NOT_EFFECTIVE');
        CodexBackend.prototype.run = counted;
        let explicitCode: string | null = null;
        if (variant === 'explicit-resume') {
          const resume = await service.accept({ id: randomUUID(), session: 'fixture', text: '/resume 1', images: [] });
          invariant(resume.taskId && !resume.rejected, 'LIVE_RESUME_REJECTED'); await service.settle(); explicitCode = service.store.get(resume.taskId).error_code;
        }
        const request = await service.accept({ id: randomUUID(), session: 'fixture', text: test.steps[0]!.detail, images: [] });
        invariant(request.taskId && !request.rejected, 'LIVE_REQUEST_REJECTED'); await service.settle();
        const result = service.store.get(request.taskId), after = fixture.gitState();
        const refusal = service.store.value<{ code: string; nativeRefSha256: string }>('resume-refusal:' + request.taskId);
        const rawHashes = [job.task_id, request.taskId].map(id => ({ requestId: id,
          original: service.store.db.prepare('SELECT raw_query_sha256 FROM orchestration_requests WHERE request_id=?').get(id)!.raw_query_sha256,
          bridge: service.store.value<{ textSha256: string }>('controller-wire:bridge:' + id)?.textSha256,
          route: service.store.value<{ textSha256: string }>('controller-wire:route:' + id)?.textSha256,
          business: service.store.value<{ textSha256: string }>('business-wire:' + id)?.textSha256 }));
        const disclosure = bridgeDisclosure(service.store, [job.task_id, request.taskId]);
        const facts = { variant, source: 'real gpt-6-sol business session created in isolated native home', setupRequestId: job.task_id, requestId: request.taskId,
          nativeRefSha256: sha256(beforeRef!), healthyProfileDigest: healthy.profileDigest, mutation, directDenial, explicitCode, submits,
          noPrompt: !service.store.value('business-wire:' + request.taskId), noFresh: service.store.db.prepare("SELECT count(*) n FROM jobs WHERE kind='agent'").get()!.n === 1 && service.store.session(job.session_key).agent_ref_json === beforeRef,
          status: result.status, code: result.error_code, refusal, forbiddenAbsent: !existsSync(path.join(target.directory.path, 'forbidden.txt')),
          gitUnchanged: JSON.stringify(before) === JSON.stringify(after), rawHashes,
          rawQueryExact: rawHashes.every((row, index) => row.original === row.bridge && row.original === row.route && (index === 0 ? row.original === row.business : row.business === undefined)),
          permissionValid: c.codex.sandbox === 'workspace-write' && !c.codex.networkAccess && inside(fixture.projectRoot, target.directory.path) && inside(c.codex.home, candidate.file) && c.codex.home !== base.codex.home,
          noReplay: submits === 0 && setupAdmissions === JSON.stringify(service.store.value('business-prompt-admissions:' + job.task_id)) && !service.store.value('business-prompt-admissions:' + request.taskId),
          disclosure };
        branches.push(facts); fixture.save('branch.json', facts);
      } finally {
        if (CodexBackend.prototype.run === counted) CodexBackend.prototype.run = originalRun;
        else if (CodexBackend.prototype.run !== originalRun) { cleanupConfirmed = false; failure = 'LIVE_METER_RESTORE_CONFLICT'; }
        try { await fixture.close(); } catch (error) { cleanupConfirmed = false; failure = errorCode(error, 'LIVE_CLEANUP_FAILED'); }
      }
      if (!cleanupConfirmed) break;
    }
  } catch (error) { failure = errorCode(error, 'LIVE_CASE_FAILED'); }
  finally { isolated.close(); }
  const observations: Record<string, { pass: boolean; actual: unknown }> = {};
  if (branches.length === 2) {
    observations.businessSubmitCount = { pass: branches.every(b => b.submits === 0 && b.noPrompt), actual: branches };
    observations.noFreshFallback = { pass: branches.every(b => b.noFresh && b.submits === 0), actual: branches };
    observations.errorScoped = { pass: branches.every(b => b.status === 'failed' && b.code === 'HISTORY_SCOPE' && (b.variant === 'binding' || b.explicitCode === 'HISTORY_SCOPE')), actual: branches };
    observations.fixtureWrites = { pass: branches.every(b => b.forbiddenAbsent && b.gitUnchanged), actual: branches };
    observations.rawQueryMatchesSourceRequest = { pass: branches.every(b => b.rawQueryExact), actual: branches.map(b => b.rawHashes) };
    observations.permissionScopeValid = { pass: branches.every(b => b.permissionValid), actual: { basis: 'host-authorized isolated fixture; not OS isolation', branches } };
    observations.noBusinessReplayAfterUncertain = { pass: branches.every(b => b.noReplay), actual: { uncertaintyExercised: false, basis: 'pre-prompt verification refusal and actual backend invocation counts', branches } };
    const disclosures = branches.map(b => b.disclosure as ReturnType<typeof bridgeDisclosure>);
    if (disclosures.every(d => d.complete)) observations.noBridgeRawAnswerDisclosure = { pass: disclosures.every(d => d.pass), actual: disclosures.map(d => d.actual) };
  }
  for (const name of ['observations.json', 'corruption-fixture.json', 'verifier-result.json', 'business-submit-count.json', 'filesystem-audit.json'])
    writeFileSync(path.join(output, name), JSON.stringify(name === 'observations.json' ? observations : { branches, authSnapshotRemoved: !existsSync(path.join(isolated.config.codex.home, 'auth.json')) }, null, 2), { mode: 0o600 });
  const assertions: AssertionResult[] = [...test.assertions, ...globals.map(predicate => ({ id: test.id + '-GLOBAL-' + predicate, predicate, expected: 'true' }))].map(a => {
    const observed = observations[a.predicate]; return observed ? { ...a, status: observed.pass ? 'PASS' : 'FAIL', actual: observed.actual, evidence: ['observations.json'] }
      : { ...a, status: failure ? 'FAIL' : 'BLOCKED', reason: failure ?? 'PREDICATE_ORACLE_NOT_IMPLEMENTED' };
  });
  const result = finalizeCase(test, attempt, globals, assertions);
  return failure ? { ...result, status: 'FAIL', failureCode: failure, cleanupConfirmed } : { ...result, cleanupConfirmed };
}
