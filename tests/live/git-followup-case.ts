import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import type { Config } from '../../src/config.ts';
import type { NormalizedInput } from '../../src/types.ts';
import { invariant, errorCode } from '../../src/errors.ts';
import { Catalog } from '../../src/routing/catalog.ts';
import { HistoryReferences } from '../../src/history/references.ts';
import { sha256 } from '../../src/orchestration/requests.ts';
import { liveFixture } from './fixture.ts';
import { bridgeDisclosure } from './bridge-disclosure.ts';
import { replayEvidence } from './replay.ts';
import { finalizeCase, type AssertionResult, type CaseResult } from './report.ts';
import type { LiveCase } from './spec.ts';
import { nativeContextAudit } from './native-context.ts';
import { remoteWriteEvidence } from './remote-writes.ts';

export async function runGitFollowupCase(base: Config, test: LiveCase, attempt: number, globals: string[], output: string, variant?: 'unique' | 'ambiguous'): Promise<CaseResult> {
  invariant(test.id === 'LIVE-06' || test.id === 'LIVE-28', 'LIVE_SCENARIO_UNSUPPORTED');
  if (test.id === 'LIVE-28' && !variant) {
    const branches: Array<{ name: string; result: CaseResult }> = [];
    for (const name of ['unique', 'ambiguous'] as const) {
      const directory = path.join(output, name); mkdirSync(directory, { mode: 0o700 });
      const result = await runGitFollowupCase(base, test, attempt, globals, directory, name); branches.push({ name, result });
      if (result.cleanupConfirmed === false) break;
    }
    const assertions: AssertionResult[] = [...test.assertions, ...globals.map(predicate => ({ id: test.id + '-GLOBAL-' + predicate, predicate, expected: 'true' }))].map(a => {
      const rows = branches.map(branch => branch.result.assertions.find(row => row.predicate === a.predicate)!);
      return { ...a, status: rows.some(row => row.status === 'FAIL') ? 'FAIL' : branches.length === 2 && rows.every(row => row.status === 'PASS') ? 'PASS' : 'BLOCKED',
        actual: branches.map((branch, i) => ({ variant: branch.name, observation: rows[i] })), evidence: branches.map(branch => branch.name + '/observations.json') };
    });
    for (const name of ['clarification-state.json', 'source-request-hashes.json', 'actual-wire-input.json', 'git-before-after.json'])
      writeFileSync(path.join(output, name), JSON.stringify(branches, null, 2), { mode: 0o600 });
    return { ...finalizeCase(test, attempt, globals, assertions), cleanupConfirmed: branches.length === 2 && branches.every(branch => branch.result.cleanupConfirmed) };
  }
  const fixture = await liveFixture(base, output, 'workspace-write'), { service, c } = fixture;
  const observations: Record<string, { pass: boolean; actual: unknown }> = {};
  let failure: string | undefined, cleanupConfirmed = false;
  const observe = (name: string, pass: boolean, actual: unknown) => { observations[name] = { pass, actual }; };
  const env = { PATH: process.env.PATH ?? '/usr/bin:/bin', LANG: 'C.UTF-8', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000 }).trim();
  try {
    const a = path.join(fixture.projectRoot, 'term4u'), b = path.join(fixture.projectRoot, 'wecom-agent-bridge'), bare = path.join(a, '.fixture-origin');
    const sentinel = randomUUID(), first = 'ALPHA_' + randomUUID(), second = 'BETA_' + randomUUID();
    writeFileSync(path.join(b, 'sentinel.txt'), sentinel, { mode: 0o600, flag: 'wx' }); git(b, 'add', '--', 'sentinel.txt'); git(b, 'commit', '-m', 'synthetic foreign directory sentinel');
    writeFileSync(path.join(a, '.gitignore'), '.fixture-origin/\n', { mode: 0o600, flag: 'wx' });
    appendFileSync(path.join(a, 'README.md'), '\n验收 remote 仅为当前目录内 .fixture-origin 本地 bare 仓库；两个独立改动应分别提交。不要配置互联网 remote。\n');
    git(a, 'add', '--', '.gitignore', 'README.md'); git(a, 'commit', '-m', 'synthetic local-only remote baseline');
    git(a, 'init', '--bare', bare); git(bare, 'config', 'core.hooksPath', '/dev/null');
    git(a, 'remote', 'add', 'origin', bare); git(a, 'push', '-u', 'origin', 'fixture');
    const gitBefore = fixture.gitState(); fixture.save('git-before.json', gitBefore);
    const baseline = git(a, 'rev-parse', 'HEAD');
    const send = async (text: string) => {
      const accepted = await service.accept({ id: randomUUID(), session: 'fixture', text, images: [] });
      invariant(accepted.taskId && !accepted.rejected, 'LIVE_REQUEST_REJECTED'); await service.settle(); return service.store.get(accepted.taskId);
    };
    const setup = await send(`在 term4u 完成两个独立改动：新增 feature-one.txt，唯一一行是 ${first}；新增 feature-two.txt，唯一一行是 ${second}。不要修改其他文件，不要 commit，不要 push。完成后简短说明进度。`);
    invariant(setup.kind === 'agent' && setup.status === 'succeeded' && readFileSync(path.join(a, 'feature-one.txt'), 'utf8').trim() === first &&
      readFileSync(path.join(a, 'feature-two.txt'), 'utf8').trim() === second && git(a, 'rev-parse', 'HEAD') === baseline, 'LIVE_GIT_SETUP_FAILED');
    const setupIds = [setup.task_id];
    if (variant === 'ambiguous') {
      const pending = await send(`在 wecom-agent-bridge 新增 pending-b.txt，唯一一行是 ${sentinel}。只做这一项独立修改，不 commit、不 push，不改 sentinel.txt。`);
      invariant(pending.kind === 'agent' && pending.status === 'succeeded' && readFileSync(path.join(b, 'pending-b.txt'), 'utf8').trim() === sentinel, 'LIVE_SECOND_CANDIDATE_SETUP');
      setupIds.push(pending.task_id);
    }
    const bBefore = fixture.gitState()['wecom-agent-bridge']!;
    const input = JSON.parse(setup.input_json) as NormalizedInput, scope = service.store.db.prepare('SELECT conversation_scope FROM orchestration_requests WHERE request_id=?').get(setup.task_id)!.conversation_scope as string;
    const session = service.store.session(setup.session_key), originalRef = session.agent_ref_json!, clock = session.last_response_at;
    const switched = await send('/route wecom-agent-bridge'); invariant(switched.status === 'succeeded', 'LIVE_ACTIVE_DIRECTORY_SETUP');
    const beforeWork = service.store.db.prepare("SELECT count(*) n FROM jobs WHERE kind='agent'").get()!.n;
    const history = await send(test.steps[0]!.detail); invariant(history.status === 'succeeded', 'LIVE_HISTORY_QUERY_FAILED');
    const state = service.store.value<{ activeWorkspace?: string; queryFocus?: { directoryRef: string; sessionRef?: string; sessionKey?: string } }>('orchestration:conversation:' + scope)!;
    let exactFocus = state.queryFocus?.sessionKey === setup.session_key;
    if (!exactFocus && state.queryFocus?.sessionRef) {
      const target = new Catalog(c).target(input.routing!.directory, input.routing!.execution);
      const candidate = await new HistoryReferences(service.store).get(scope, target, state.queryFocus.sessionRef);
      exactFocus = JSON.stringify(candidate.ref) === originalRef;
    }
    observe('noTargetMutationOnRead', history.kind === 'command' && state.activeWorkspace === 'wecom-agent-bridge' && state.queryFocus?.directoryRef === 'term4u' && exactFocus &&
      service.store.session(setup.session_key).last_response_at === clock && service.store.db.prepare("SELECT count(*) n FROM jobs WHERE kind='agent'").get()!.n === beforeWork,
      { state, exactFocus, clockBefore: clock, clockAfter: service.store.session(setup.session_key).last_response_at, beforeWork });
    const managementIds = [history.task_id];
    if (variant === 'ambiguous') {
      // A real user-level setup statement makes both actual dirty projects candidates; it does not choose either target.
      const context = await send('当前 term4u 和 wecom-agent-bridge 都有待提交改动。下一条如果省略项目名，请先确认是哪一个，不能替我选；这里只说明目录选择要求，不执行任何业务。');
      invariant(context.kind === 'command' && context.status === 'succeeded' && service.store.db.prepare("SELECT count(*) n FROM jobs WHERE kind='agent'").get()!.n === beforeWork, 'LIVE_AMBIGUITY_CONTEXT_FAILED');
      managementIds.push(context.task_id);
    }
    const workQuery = test.steps.find(step => step.order === (test.id === 'LIVE-06' ? 3 : 2))!.detail;
    const requested = await send(workQuery); let work = requested, clarificationId: string | undefined, duplicateConfirmed = true;
    const afterInitial = service.store.db.prepare("SELECT count(*) n FROM jobs WHERE kind='agent'").get()!.n;
    const pending = service.store.value<{ pendingSelection?: { sourceRequestId: string; optionRefs: string[] } }>('orchestration:conversation:' + scope)?.pendingSelection;
    if (test.id === 'LIVE-28') {
      if (variant === 'ambiguous') invariant(requested.kind === 'command' && pending?.sourceRequestId === requested.task_id && afterInitial === beforeWork, 'LIVE_AMBIGUOUS_WORK_EXECUTED');
      if (requested.kind === 'command') {
        invariant(pending?.sourceRequestId === requested.task_id && afterInitial === beforeWork && pending.optionRefs.includes('term4u'), 'LIVE_CLARIFICATION_NOT_PERSISTED');
        const choice = { id: randomUUID(), session: 'fixture', text: test.steps.find(step => step.order === 4)!.detail.replace(/^（仅在收到目标澄清时）/, ''), images: [] };
        const accepted = await service.accept(choice); invariant(accepted.taskId && !accepted.rejected, 'LIVE_CHOICE_REJECTED'); await service.settle();
        clarificationId = accepted.taskId; work = service.store.get(accepted.taskId);
        const admissions = JSON.stringify(service.store.value('business-prompt-admissions:' + work.task_id));
        duplicateConfirmed = (await service.accept(choice)).duplicate === true; await service.settle();
        duplicateConfirmed &&= admissions === JSON.stringify(service.store.value('business-prompt-admissions:' + work.task_id));
        managementIds.push(requested.task_id);
      }
    }
    invariant(work.kind === 'agent' && work.status === 'succeeded', 'LIVE_GIT_WORK_NOT_COMPLETED');
    const actualRef = service.store.session(work.session_key).agent_ref_json;
    observe('selectedNativeSession', work.session_key === setup.session_key && actualRef === originalRef, { beforeSha256: sha256(originalRef), afterSha256: sha256(actualRef!), businessSessionKey: work.session_key });
    const wire = service.store.value<{ textSha256: string }>('business-wire:' + work.task_id);
    const request = service.store.db.prepare('SELECT raw_query_sha256,source_request_id FROM orchestration_requests WHERE request_id=?').get(work.task_id)!;
    const source = service.store.db.prepare('SELECT raw_query_sha256 FROM orchestration_requests WHERE request_id=?').get(requested.task_id)!.raw_query_sha256;
    observe('queryByteIdentity', source === sha256(workQuery) && wire?.textSha256 === source, { source, control: request.raw_query_sha256, wire });
    if (test.id === 'LIVE-28') {
      observe('safeEllipticalTarget', JSON.parse(work.input_json).workspaceId === 'term4u' && work.session_key === setup.session_key &&
        (variant !== 'ambiguous' || !!clarificationId && afterInitial === beforeWork), { variant, selectedWorkspace: JSON.parse(work.input_json).workspaceId, beforeWork, afterInitial, clarificationId, pending });
      observe('clarificationSourceIdentity', clarificationId ? request.source_request_id === requested.task_id && source !== request.raw_query_sha256 && wire?.textSha256 === source : request.source_request_id === null,
        { variant, originalWorkId: requested.task_id, clarificationId, sourceRequestId: request.source_request_id, sourceHash: source, controlHash: request.raw_query_sha256, wire });
    }
    const head = git(a, 'rev-parse', 'HEAD'), branch = git(a, 'symbolic-ref', '--short', 'HEAD'), remote = git(a, 'remote', 'get-url', 'origin');
    const remoteHead = git(bare, 'rev-parse', '--verify', 'refs/heads/' + branch), count = Number(git(a, 'rev-list', '--count', baseline + '..HEAD'));
    observe('gitFacts', count >= 2 && head === remoteHead && git(a, 'status', '--porcelain') === '' && realpathSync(remote) === bare &&
      git(a, 'show', 'HEAD:feature-one.txt').trim() === first && git(a, 'show', 'HEAD:feature-two.txt').trim() === second,
      { baseline, head, branch, remoteHead, commits: count, localBareOnly: remote === bare, log: git(a, 'log', '--format=%H %s', baseline + '..HEAD') });
    const bAfter = fixture.gitState()['wecom-agent-bridge']!;
    observe('foreignDirectoryUnchanged', JSON.stringify(bBefore) === JSON.stringify(bAfter) && readFileSync(path.join(b, 'sentinel.txt'), 'utf8') === sentinel && remote === bare && (test.id !== 'LIVE-28' || observations.gitFacts!.pass),
      { before: bBefore, after: bAfter, sentinelSha256: sha256(sentinel) });
    const admissions = service.store.value<Array<{ admitted: boolean }>>('business-prompt-admissions:' + work.task_id) ?? [];
    observe('businessSubmitCount', admissions.filter(row => row.admitted).length === 1 && duplicateConfirmed && service.store.db.prepare("SELECT count(*) n FROM jobs WHERE kind='agent'").get()!.n === setupIds.length + 1,
      { admissions, duplicateConfirmed, expectedTotalIncludingSetup: setupIds.length + 1 });
    const ids = [...setupIds, ...managementIds, work.task_id], wires = ids.map(id => ({ source: service.store.db.prepare(`SELECT COALESCE(s.raw_query_sha256,r.raw_query_sha256) raw_query_sha256
      FROM orchestration_requests r LEFT JOIN orchestration_requests s ON s.request_id=r.source_request_id WHERE r.request_id=?`).get(id)!.raw_query_sha256,
      kind: service.store.get(id).kind, bridge: service.store.value<{ textSha256: string }>('controller-wire:bridge:' + id)?.textSha256,
      business: service.store.value<{ textSha256: string }>('business-wire:' + id)?.textSha256 }));
    observe('rawQueryMatchesSourceRequest', wires.every(row => row.source === row.bridge && (row.kind === 'agent' ? row.source === row.business : !row.business)), wires);
    observe('permissionScopeValid', c.codex.sandbox === 'workspace-write' && !c.codex.networkAccess && remote === bare && [setup, work].every(job => JSON.parse(job.input_json).workspaceId === 'term4u'),
      { sandbox: c.codex.sandbox, localBareOnly: true, notOsIsolation: true });
    const disclosure = bridgeDisclosure(service.store, ids), replay = replayEvidence(service.store, [...setupIds, work.task_id]);
    if (disclosure.complete) observe('noBridgeRawAnswerDisclosure', disclosure.pass, disclosure.actual);
    if (replay.complete) observe('noBusinessReplayAfterUncertain', replay.pass, replay.actual);
    const requestIds = (service.store.db.prepare('SELECT request_id FROM orchestration_requests ORDER BY ingress_seq').all() as { request_id: string }[]).map(row => row.request_id);
    const sessions = new Map(requestIds.map(id => service.store.get(id)).filter(job => job.kind === 'agent').map(job => [job.session_key, job]));
    const native = await Promise.all([...sessions.values()].map(job => nativeContextAudit(service.store, c, job, 'unused-remote-audit-marker')));
    const remoteAudit = remoteWriteEvidence(service.store, requestIds, native, gitBefore, fixture.gitState());
    fixture.save('remote-write-audit.json', remoteAudit);
    if (remoteAudit.complete) observe('noProductionRemoteWrites', remoteAudit.pass, remoteAudit.actual);
    fixture.save('read-vs-execute-events.json', observations.noTargetMutationOnRead); fixture.save('native-session-ids.json', observations.selectedNativeSession);
    fixture.save('git-log.json', observations.gitFacts); fixture.save('local-remote-ref.json', { head, branch, remoteHead, remote }); fixture.save('B-before-after.json', observations.foreignDirectoryUnchanged);
  } catch (error) { failure = errorCode(error, 'LIVE_CASE_FAILED'); }
  finally { try { await fixture.close(); cleanupConfirmed = true; } catch (error) { failure = errorCode(error, 'LIVE_CLEANUP_FAILED'); } fixture.save('observations.json', observations); }
  const assertions: AssertionResult[] = [...test.assertions, ...globals.map(predicate => ({ id: test.id + '-GLOBAL-' + predicate, predicate, expected: 'true' }))].map(a => {
    const observed = observations[a.predicate]; return observed ? { ...a, status: observed.pass ? 'PASS' : 'FAIL', actual: observed.actual, evidence: ['observations.json'] }
      : { ...a, status: failure ? 'FAIL' : 'BLOCKED', reason: failure ?? 'PREDICATE_ORACLE_NOT_IMPLEMENTED' };
  });
  const result = finalizeCase(test, attempt, globals, assertions);
  return failure ? { ...result, status: 'FAIL', failureCode: failure, cleanupConfirmed } : { ...result, cleanupConfirmed };
}
