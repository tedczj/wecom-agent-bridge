import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { writeFileSync, appendFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { Config } from '../../src/config.ts';
import { invariant, errorCode } from '../../src/errors.ts';
import { ArtifactStore } from '../../src/answers/artifact-store.ts';
import { validateRecap, type RecapContent } from '../../src/answers/recap.ts';
import { sha256 } from '../../src/orchestration/requests.ts';
import { liveFixture } from './fixture.ts';
import { nativeContextAudit } from './native-context.ts';
import { bridgeDisclosure } from './bridge-disclosure.ts';
import { replayEvidence } from './replay.ts';
import { remoteWriteEvidence } from './remote-writes.ts';
import { recapSemanticFacts } from './recap-semantics.ts';
import { finalizeCase, type AssertionResult, type CaseResult } from './report.ts';
import type { LiveCase } from './spec.ts';

export async function runRecapSemanticsCase(base: Config, test: LiveCase, attempt: number, globals: string[], output: string): Promise<CaseResult> {
  invariant(test.id === 'LIVE-08', 'LIVE_SCENARIO_UNSUPPORTED');
  const fixture = await liveFixture(base, output), { service, c } = fixture, nonce = randomUUID();
  const observations: Record<string, { pass: boolean; actual: unknown }> = {};
  let failure: string | undefined, cleanupConfirmed = false;
  const observe = (name: string, pass: boolean, actual: unknown) => { observations[name] = { pass, actual }; };
  try {
    const directory = path.join(fixture.projectRoot, 'term4u'), testFile = path.join(directory, 'fixture.test.cjs'), packageFile = path.join(directory, 'package.json');
    writeFileSync(testFile, `const test=require('node:test'),assert=require('node:assert/strict');
test('fixture arithmetic',()=>{assert.equal(2+2,4);console.log(${JSON.stringify('TEST_RUN_' + nonce)});});\n`, { mode: 0o600, flag: 'wx' });
    writeFileSync(packageFile, JSON.stringify({ name: 'synthetic-acceptance-fixture', private: true, scripts: { test: 'node --test fixture.test.cjs' } }), { mode: 0o600, flag: 'wx' });
    appendFileSync(path.join(directory, 'README.md'), '\n现有测试入口：`npm test`，仅运行本地 fixture.test.cjs，无需安装依赖。后续尚未完成的事项：增加边界条件测试。\n');
    const env = { PATH: process.env.PATH ?? '/usr/bin:/bin', LANG: 'C.UTF-8', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
    for (const args of [['add', '--', 'README.md', 'fixture.test.cjs', 'package.json'], ['commit', '-m', 'synthetic existing test baseline']])
      execFileSync('git', ['-C', directory, ...args], { env, stdio: 'pipe', timeout: 30000 });
    const before = fixture.gitState(), scriptSha256 = sha256(readFileSync(testFile)), packageSha256 = sha256(readFileSync(packageFile));
    const accepted = await service.accept({ id: randomUUID(), session: 'fixture', text: test.steps[0]!.detail, images: [] });
    invariant(accepted.taskId && !accepted.rejected, 'LIVE_REQUEST_REJECTED'); await service.settle();
    const id = accepted.taskId, job = service.store.get(id); invariant(job.kind === 'agent' && job.status === 'succeeded', 'LIVE_BUSINESS_NOT_COMPLETED');
    const scope = service.store.db.prepare('SELECT conversation_scope FROM orchestration_requests WHERE request_id=?').get(id)!.conversation_scope as string;
    const artifact = service.store.db.prepare("SELECT answer_id,sha256 FROM answer_artifacts WHERE job_task_id=? AND kind='final' AND state='ready'").get(id)!;
    const raw = await new ArtifactStore(service.store, c.orchestration!.answers.root).read(artifact.answer_id as string, { role: 'delivery', scope });
    invariant(Array.from(raw.toString('utf8')).length > 2000, 'LIVE_LONG_ANSWER_REQUIRED');
    const recap = service.store.db.prepare('SELECT state,source,source_sha256,short_text,structured_json FROM answer_recaps WHERE answer_id=?').get(artifact.answer_id as string)!;
    invariant(recap.state === 'ready' && recap.source === 'llm-recap' && typeof recap.structured_json === 'string', 'LIVE_RECAP_NOT_READY');
    const content = JSON.parse(recap.structured_json) as RecapContent, validated = validateRecap(content, 1000), facts = recapSemanticFacts(content, validated.shortText);
    const native = await nativeContextAudit(service.store, c, job, nonce);
    const actualTests = native.fixtureTests ?? [], executed = actualTests.some(row => row.cwdMatches && row.completed && row.exitCode === 0 && row.markerSeen);
    const scriptUnchanged = sha256(readFileSync(testFile)) === scriptSha256 && sha256(readFileSync(packageFile)) === packageSha256;
    observe('recapFacts', facts.noCodeChanges && facts.noCommit && facts.noPush && facts.pending && facts.options && facts.question, facts);
    observe('noInventedVerification', executed && scriptUnchanged && facts.testReported && facts.noClaimedImplementation,
      { actualTests, scriptSha256, packageSha256, scriptUnchanged, facts, scope: 'actual synthetic fixture arithmetic test only; not production project tests' });
    const after = fixture.gitState(); observe('gitFacts', JSON.stringify(before) === JSON.stringify(after) && scriptUnchanged, { before, after, scriptUnchanged });
    observe('recapBound', validated.shortText === recap.short_text && Array.from(validated.shortText).length <= 1000 && recap.source_sha256 === artifact.sha256,
      { codepoints: Array.from(validated.shortText).length, sourceSha256: recap.source_sha256, rawSha256: sha256(raw) });
    const source = service.store.db.prepare('SELECT raw_query_sha256 FROM orchestration_requests WHERE request_id=?').get(id)!.raw_query_sha256;
    const wires = ['controller-wire:bridge:', 'controller-wire:route:', 'business-wire:'].map(prefix => service.store.value<{ textSha256: string }>(prefix + id));
    observe('rawQueryMatchesSourceRequest', source === sha256(test.steps[0]!.detail) && wires.every(row => row?.textSha256 === source), { source, wires });
    observe('permissionScopeValid', c.codex.sandbox === 'read-only' && !c.codex.networkAccess && JSON.parse(job.input_json).workspaceId === 'term4u', { sandbox: c.codex.sandbox, basis: 'host fixture authorization, not OS isolation' });
    const disclosure = bridgeDisclosure(service.store, [id]), replay = replayEvidence(service.store, [id]), remote = remoteWriteEvidence(service.store, [id], [native], before, after);
    if (disclosure.complete) observe('noBridgeRawAnswerDisclosure', disclosure.pass, disclosure.actual);
    if (replay.complete) observe('noBusinessReplayAfterUncertain', replay.pass, replay.actual);
    if (remote.complete) observe('noProductionRemoteWrites', remote.pass, remote.actual);
    fixture.save('business-test-exit.json', { actualTests, scriptSha256, packageSha256, native });
    writeFileSync(path.join(output, 'answer.md'), raw, { mode: 0o600 }); fixture.save('recap.json', { content, shortText: recap.short_text, sourceSha256: recap.source_sha256 });
    fixture.save('semantic-rubric.json', { facts, automatedRubric: 'conservative lexical/structured checks; runtime exit and Git facts independently required' });
    fixture.save('git-before-after.json', { before, after }); fixture.save('remote-write-audit.json', remote);
  } catch (error) { failure = errorCode(error, 'LIVE_CASE_FAILED'); }
  finally { try { await fixture.close(); cleanupConfirmed = true; } catch (error) { failure = errorCode(error, 'LIVE_CLEANUP_FAILED'); } fixture.save('observations.json', observations); }
  const assertions: AssertionResult[] = [...test.assertions, ...globals.map(predicate => ({ id: test.id + '-GLOBAL-' + predicate, predicate, expected: 'true' }))].map(a => {
    const observed = observations[a.predicate]; return observed ? { ...a, status: observed.pass ? 'PASS' : 'FAIL', actual: observed.actual, evidence: ['observations.json'] }
      : { ...a, status: failure ? 'FAIL' : 'BLOCKED', reason: failure ?? 'PREDICATE_ORACLE_NOT_IMPLEMENTED' };
  });
  const result = finalizeCase(test, attempt, globals, assertions);
  return failure ? { ...result, status: 'FAIL', failureCode: failure, cleanupConfirmed } : { ...result, cleanupConfirmed };
}
