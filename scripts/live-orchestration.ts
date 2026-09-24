import { execFileSync } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, statfsSync } from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../src/config.ts';
import { ControllerFactory, ControllerCapabilityError, controllerConfigurationDigest } from '../src/controllers/factory.ts';
import { errorCode, invariant } from '../src/errors.ts';
import { privateDirectory } from '../src/fsutil.ts';
import { parseLiveSpecification, type LiveSuite } from '../tests/live/spec.ts';
import { blockedCase, type CaseResult } from '../tests/live/report.ts';
import { readonlyCases, runReadonlyCase } from '../tests/live/read-only-cases.ts';
import { runDuplicateCase } from '../tests/live/duplicate-case.ts';
import { runFifoCase } from '../tests/live/fifo-case.ts';
import { runCancelCase } from '../tests/live/cancel-case.ts';
import { runScopeCase } from '../tests/live/scope-case.ts';
import { runInteractionCase } from '../tests/live/interaction-case.ts';
import { runCorruptCase } from '../tests/live/corrupt-case.ts';
import { runDeliveryCase } from '../tests/live/delivery-case.ts';
import { runRecapCase } from '../tests/live/recap-case.ts';
import { runPartialCase } from '../tests/live/partial-case.ts';
import { runLargeHistoryCase } from '../tests/live/large-history-case.ts';
import { runExternalCase } from '../tests/live/external-case.ts';
import { runClockCase } from '../tests/live/clock-case.ts';
import { runInjectionCase } from '../tests/live/injection-case.ts';
import { runLongAnswerCase } from '../tests/live/long-answer-case.ts';
import { runCrashCase } from '../tests/live/crash-case.ts';
import { runRecapSemanticsCase } from '../tests/live/recap-semantics-case.ts';
import { runModelOverrideCase } from '../tests/live/model-override-case.ts';
import { runGitFollowupCase } from '../tests/live/git-followup-case.ts';
import { liveStopRequested, requestLiveStop } from '../tests/live/fixture.ts';
import { verifyCaseEvidence } from '../tests/live/evidence.ts';
import { candidateManifest } from '../tests/live/candidate.ts';

/** Opt-in evidence runner. A failed capability gate never falls back to doubles. */
async function main(): Promise<void> {
  const args = process.argv.slice(2), flags = new Set<string>(), options = new Map<string, string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (['--live', '--live-large-context', '--live-weixin', '--allow-fixture-writes'].includes(arg)) { invariant(!flags.has(arg), 'LIVE_ARGUMENT'); flags.add(arg); }
    else { invariant(['--config', '--out', '--suite', '--case', '--repeat', '--max-calls', '--max-tokens'].includes(arg) && args[i + 1] && !options.has(arg), 'LIVE_ARGUMENT'); options.set(arg, args[++i]!); }
  }
  invariant(flags.has('--live'), 'LIVE_OPT_IN_REQUIRED');
  process.once('SIGINT', requestLiveStop); process.once('SIGTERM', requestLiveStop);
  invariant(options.has('--config') && options.has('--out'), 'LIVE_ARGUMENT');
  const suite = options.get('--suite') ?? 'core'; invariant(['core', 'fault', 'large-context', 'weixin'].includes(suite), 'LIVE_SUITE');
  const repeat = Number(options.get('--repeat') ?? (suite === 'core' || suite === 'fault' ? 3 : 1));
  invariant(Number.isSafeInteger(repeat) && repeat === (suite === 'core' || suite === 'fault' ? 3 : 1), 'LIVE_REPEAT_REQUIRED');
  if (suite === 'large-context') {
    invariant(flags.has('--live-large-context'), 'LARGE_CONTEXT_OPT_IN_REQUIRED');
    for (const key of ['--max-calls', '--max-tokens']) invariant(Number.isSafeInteger(Number(options.get(key))) && Number(options.get(key)) > 0, 'LARGE_CONTEXT_BUDGET_REQUIRED');
  }
  if (suite === 'weixin') invariant(flags.has('--live-weixin'), 'WEIXIN_LIVE_OPT_IN_REQUIRED');
  const c = loadConfig(options.get('--config')!); invariant(c.orchestration && c.models, 'HIERARCHICAL_CONFIG_REQUIRED');
  const spec = parseLiveSpecification(JSON.parse(readFileSync('docs/plans/three-layer-agent-bridge/live-cases.json', 'utf8')));
  const cases = spec.cases.filter(test => test.suite === suite as LiveSuite && (!options.has('--case') || test.id === options.get('--case')));
  invariant(cases.length > 0, 'LIVE_CASE_SELECTION');
  const root = privateDirectory(path.join(path.resolve(options.get('--out')!), randomUUID()));
  writeFileSync(path.join(root, '.gitignore'), '*\n', { mode: 0o600 });
  const env = { PATH: process.env.PATH ?? '/usr/bin:/bin', LANG: 'C.UTF-8' };
  const gitSha = execFileSync('git', ['rev-parse', 'HEAD'], { env, encoding: 'utf8' }).trim();
  const dirty = execFileSync('git', ['status', '--porcelain'], { env, encoding: 'utf8' }).trim().length > 0;
  const configHash = createHash('sha256').update(readFileSync(options.get('--config')!)).digest('hex');
  const nativeConfigurationDigest = await controllerConfigurationDigest(c.orchestration.controllerRuntime.home, c.models[c.orchestration.bridge.modelProfile]!);
  const candidate = candidateManifest(process.cwd());
  writeFileSync(path.join(root, 'candidate.json'), JSON.stringify(candidate, null, 2), { mode: 0o600 });
  const manifest = { gitSha, dirtyWorktree: dirty, candidateSha256: candidate.sha256, configHash, nativeConfigurationDigest, suite, repeat, runnerPid: process.pid, startedAt: new Date().toISOString(),
    selectedCases: cases.map(test => test.id), fullSuite: !options.has('--case'),
    requestedModels: c.models, providerObserved: 'unknown', cost: 'unknown', largeContextOptIn: flags.has('--live-large-context') };
  writeFileSync(path.join(root, 'manifest.json'), JSON.stringify(manifest, null, 2), { mode: 0o600 });
  let blocker: string | undefined, capabilityGaps: string[] | undefined;
  try { await ControllerFactory.open(c); } catch (error) {
    blocker = errorCode(error, 'CAPABILITY_PROBE_FAILED');
    if (error instanceof ControllerCapabilityError) capabilityGaps = error.gaps;
  }
  const results: CaseResult[] = [];
  for (const test of cases) for (let attempt = 1; attempt <= repeat; attempt++) {
    const directory = path.join(root, test.id, String(attempt)); mkdirSync(directory, { recursive: true, mode: 0o700 });
    const space = statfsSync(root, { bigint: true });
    if (space.bavail * space.bsize < 2n * 1024n ** 3n) blocker = 'LIVE_DISK_RESERVE';
    if (liveStopRequested()) blocker = 'LIVE_STOP_REQUESTED';
    let result: CaseResult;
    if (blocker) result = blockedCase(test, attempt, spec.globalAssertions, blocker);
    else if (test.id === 'LIVE-05' && !Object.values(c.models).some(profile => profile.model !== c.models![c.orchestration!.business.defaultModelProfile]!.model)) {
      result = blockedCase(test, attempt, spec.globalAssertions, 'LIVE_DISTINCT_BUSINESS_MODEL_NOT_CONFIGURED');
    }
    else if (test.id === 'LIVE-11' || test.id === 'LIVE-25' || test.id === 'LIVE-16' || test.id === 'LIVE-14') {
      if (!flags.has('--allow-fixture-writes')) result = blockedCase(test, attempt, spec.globalAssertions, 'FIXTURE_WRITES_OPT_IN_REQUIRED');
      else {
        try { result = await (test.id === 'LIVE-11' ? runDuplicateCase : test.id === 'LIVE-25' ? runFifoCase : test.id === 'LIVE-14' ? runCorruptCase : runCancelCase)(c, test, attempt, spec.globalAssertions, directory); }
        catch (error) { result = blockedCase(test, attempt, spec.globalAssertions, errorCode(error, 'LIVE_FIXTURE_FAILED')); }
      }
    }
    else if (test.id === 'LIVE-21') {
      try { result = await runScopeCase(c, test, attempt, spec.globalAssertions, directory); }
      catch (error) { result = blockedCase(test, attempt, spec.globalAssertions, errorCode(error, 'LIVE_FIXTURE_FAILED')); }
    }
    else if (test.id === 'LIVE-30') {
      try { result = await runInteractionCase(c, test, attempt, spec.globalAssertions, directory); }
      catch (error) { result = blockedCase(test, attempt, spec.globalAssertions, errorCode(error, 'LIVE_FIXTURE_FAILED')); }
    }
    else if (test.id === 'LIVE-19') {
      try { result = await runDeliveryCase(c, test, attempt, spec.globalAssertions, directory); }
      catch (error) { result = blockedCase(test, attempt, spec.globalAssertions, errorCode(error, 'LIVE_FIXTURE_FAILED')); }
    }
    else if (test.id === 'LIVE-18') {
      try { result = await runRecapCase(c, test, attempt, spec.globalAssertions, directory); }
      catch (error) { result = blockedCase(test, attempt, spec.globalAssertions, errorCode(error, 'LIVE_FIXTURE_FAILED')); }
    }
    else if (test.id === 'LIVE-15') {
      try { result = await runPartialCase(c, test, attempt, spec.globalAssertions, directory); }
      catch (error) { result = blockedCase(test, attempt, spec.globalAssertions, errorCode(error, 'LIVE_FIXTURE_FAILED')); }
    }
    else if (test.id === 'LIVE-13') {
      try { result = await runLargeHistoryCase(c, test, attempt, spec.globalAssertions, directory); }
      catch (error) { result = blockedCase(test, attempt, spec.globalAssertions, errorCode(error, 'LIVE_FIXTURE_FAILED')); }
    }
    else if (test.id === 'LIVE-12') {
      try { result = await runExternalCase(c, test, attempt, spec.globalAssertions, directory); }
      catch (error) { result = blockedCase(test, attempt, spec.globalAssertions, errorCode(error, 'LIVE_FIXTURE_FAILED')); }
    }
    else if (test.id === 'LIVE-20') {
      try { result = await runClockCase(c, test, attempt, spec.globalAssertions, directory); }
      catch (error) { result = blockedCase(test, attempt, spec.globalAssertions, errorCode(error, 'LIVE_FIXTURE_FAILED')); }
    }
    else if (test.id === 'LIVE-07' || test.id === 'LIVE-09') {
      try { result = await runLongAnswerCase(c, test, attempt, spec.globalAssertions, directory); }
      catch (error) { result = blockedCase(test, attempt, spec.globalAssertions, errorCode(error, 'LIVE_FIXTURE_FAILED')); }
    }
    else if (test.id === 'LIVE-06' || test.id === 'LIVE-28') {
      if (!flags.has('--allow-fixture-writes')) result = blockedCase(test, attempt, spec.globalAssertions, 'FIXTURE_WRITES_OPT_IN_REQUIRED');
      else try { result = await runGitFollowupCase(c, test, attempt, spec.globalAssertions, directory); }
      catch (error) { result = blockedCase(test, attempt, spec.globalAssertions, errorCode(error, 'LIVE_FIXTURE_FAILED')); }
    }
    else if (test.id === 'LIVE-05') {
      try { result = await runModelOverrideCase(c, test, attempt, spec.globalAssertions, directory); }
      catch (error) { result = blockedCase(test, attempt, spec.globalAssertions, errorCode(error, 'LIVE_FIXTURE_FAILED')); }
    }
    else if (test.id === 'LIVE-08') {
      try { result = await runRecapSemanticsCase(c, test, attempt, spec.globalAssertions, directory); }
      catch (error) { result = blockedCase(test, attempt, spec.globalAssertions, errorCode(error, 'LIVE_FIXTURE_FAILED')); }
    }
    else if (test.id === 'LIVE-17') {
      if (!flags.has('--allow-fixture-writes')) result = blockedCase(test, attempt, spec.globalAssertions, 'FIXTURE_WRITES_OPT_IN_REQUIRED');
      else try { result = await runCrashCase(c, test, attempt, spec.globalAssertions, directory); }
      catch (error) { result = blockedCase(test, attempt, spec.globalAssertions, errorCode(error, 'LIVE_FIXTURE_FAILED')); }
    }
    else if (test.id === 'LIVE-24') result = blockedCase(test, attempt, spec.globalAssertions, 'DATA_MIGRATION_REMOVED');
    else if (test.id === 'LIVE-23') {
      try { result = await runInjectionCase(c, test, attempt, spec.globalAssertions, directory); }
      catch (error) { result = blockedCase(test, attempt, spec.globalAssertions, errorCode(error, 'LIVE_FIXTURE_FAILED')); }
    }
    else if (readonlyCases.has(test.id)) {
      try { result = await runReadonlyCase(c, test, attempt, spec.globalAssertions, directory); }
      catch (error) { result = blockedCase(test, attempt, spec.globalAssertions, errorCode(error, 'LIVE_FIXTURE_FAILED')); }
    } else result = blockedCase(test, attempt, spec.globalAssertions, 'LIVE_SCENARIO_ADAPTER_NOT_IMPLEMENTED');
    if (result.cleanupConfirmed !== undefined) {
      const after = await controllerConfigurationDigest(c.orchestration.controllerRuntime.home, c.models[c.orchestration.bridge.modelProfile]!);
      writeFileSync(path.join(directory, 'runtime-configuration.json'), JSON.stringify({ before: nativeConfigurationDigest, after,
        unchanged: nativeConfigurationDigest === after }), { mode: 0o600 });
      if (after !== nativeConfigurationDigest) { result = { ...result, status: 'FAIL', failureCode: 'LIVE_SHARED_CONFIG_CHANGED' }; blocker = 'LIVE_SHARED_CONFIG_CHANGED'; }
    }
    result = await verifyCaseEvidence(result, directory);
    if (result.cleanupConfirmed === false) blocker = 'LIVE_PREVIOUS_CLEANUP_UNVERIFIED';
    results.push(result); writeFileSync(path.join(directory, 'assertions.json'), JSON.stringify(result.assertions, null, 2), { mode: 0o600 });
    writeFileSync(path.join(directory, 'result.json'), JSON.stringify(result, null, 2), { mode: 0o600 });
  }
  const status = results.some(result => result.status === 'FAIL') ? 'FAIL' : results.some(result => result.status !== 'PASS') ? 'BLOCKED' : 'PASS';
  const report = { ...manifest, finishedAt: new Date().toISOString(), status, capabilityGaps, results };
  writeFileSync(path.join(root, 'report.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
  process.stdout.write(JSON.stringify({ status: report.status, cases: results.length,
    reason: status === 'PASS' ? undefined : blocker ?? results.find(result => result.status === 'FAIL')?.failureCode ?? 'LIVE_ASSERTIONS_INCOMPLETE', capabilityGaps, evidence: root }) + '\n');
  process.exitCode = status === 'PASS' ? 0 : 1;
}
main().catch(error => { process.stderr.write(errorCode(error, 'LIVE_RUNNER_FAILED') + '\n'); process.exitCode = 1; });
