import { fork, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { constants, openSync, closeSync, existsSync, readFileSync, writeFileSync, appendFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import type { Config } from '../../src/config.ts';
import { Store } from '../../src/store.ts';
import { invariant, errorCode, record } from '../../src/errors.ts';
import { deadline } from '../../src/async.ts';
import { processAlive, readControlled } from '../../src/fsutil.ts';
import { sha256 } from '../../src/orchestration/requests.ts';
import type { PromptAdmission } from '../../src/orchestration/dispatch.ts';
import { liveFixture, liveStopRequested } from './fixture.ts';
import { replayEvidence } from './replay.ts';
import { bridgeDisclosure } from './bridge-disclosure.ts';
import { recoveredControllerClosure } from './recovered-closure.ts';
import { finalizeCase, type AssertionResult, type CaseResult } from './report.ts';
import type { LiveCase } from './spec.ts';

export async function runCrashCase(base: Config, test: LiveCase, attempt: number, globals: string[], output: string): Promise<CaseResult> {
  invariant(test.id === 'LIVE-17', 'LIVE_SCENARIO_UNSUPPORTED');
  let child: ChildProcess | undefined, exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }> | undefined;
  let fixture: Awaited<ReturnType<typeof liveFixture>> | undefined, release = '', scriptPid: number | undefined;
  let originalId = '', originalRef = '', admissionsBefore = '', markerSha256 = '', started = '', stateRoot = '', workRoot = '';
  const knownGroups: number[] = [], observations: Record<string, { pass: boolean; actual: unknown }> = {};
  let failure: string | undefined, cleanupConfirmed = false;
  const observe = (name: string, pass: boolean, actual: unknown) => { observations[name] = { pass, actual }; };
  const releaseScript = (text: string) => {
    if (!release) return;
    const fd = openSync(release, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o600);
    try { writeFileSync(fd, text); } finally { closeSync(fd); }
  };
  try {
    fixture = await liveFixture(base, output, 'workspace-write', { beforeStart: async c => {
      stateRoot = c.stateRoot; workRoot = c.orchestration!.controllerRuntime.workRoot;
      const directory = c.routing!.workspaces.find(row => row.id === 'term4u')!.path, script = path.join(directory, 'crash-task.cjs'), token = randomUUID();
      started = path.join(directory, '.crash-started'); release = path.join(directory, '.crash-release');
      writeFileSync(script, `const fs=require('node:fs'),path=require('node:path');
fs.writeFileSync(path.join(__dirname,'.crash-started'),JSON.stringify({pid:process.pid,token:${JSON.stringify(token)},script:fs.realpathSync(__filename)}),{flag:'wx',mode:0o600});
const end=Date.now()+120000; const timer=setInterval(()=>{if(fs.existsSync(path.join(__dirname,'.crash-release'))||Date.now()>end){clearInterval(timer);process.stdout.write('fixture task ended\\n');}},100);
`, { flag: 'wx', mode: 0o600 });
      appendFileSync(path.join(directory, 'README.md'), '\n本项目的测试任务入口为 `node crash-task.cjs`。开始标记由脚本生成；运行后等待 runner 释放，不修改脚本或控制文件。\n');
      const scriptHash = sha256(readFileSync(script));
      child = fork(fileURLToPath(new URL('./crash-child.js', import.meta.url)), ['--live'], {
        detached: true, env: { PATH: process.env.PATH ?? '/usr/bin:/bin', LANG: 'C.UTF-8' }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
      child.stderr?.resume();
      exited = new Promise((resolve, reject) => { child!.once('error', reject); child!.once('exit', (code, signal) => resolve({ code, signal })); });
      const accepted = new Promise<Record<string, unknown>>((resolve, reject) => {
        child!.on('message', value => { const message = record(value); if (message.type === 'accepted') resolve(message); else if (message.type === 'failed') reject(new Error(String(message.code))); });
        child!.once('exit', () => reject(new Error('LIVE_CHILD_EXITED_BEFORE_ACCEPT')));
      });
      child.send({ config: c, frame: { id: randomUUID(), session: 'fixture', text: test.steps[0]!.detail, images: [] } });
      const ack = await deadline(accepted, 30000, 'LIVE_CHILD_START_TIMEOUT');
      invariant(typeof ack.taskId === 'string' && !ack.rejected, 'LIVE_REQUEST_REJECTED'); originalId = ack.taskId;
      const store = new Store(path.join(c.stateRoot, 'bridge.sqlite'), c, true);
      try {
        const until = Date.now() + 240000;
        while (!existsSync(started)) {
          invariant(!liveStopRequested() && Date.now() < until, 'LIVE_SCRIPT_START_TIMEOUT');
          const phase = store.db.prepare('SELECT phase FROM orchestration_requests WHERE request_id=?').get(originalId)!.phase;
          invariant(!['completed', 'failed', 'interrupted', 'cancelled'].includes(String(phase)), 'LIVE_SCRIPT_NOT_STARTED'); await sleep(100);
        }
        const bytes = await readControlled(directory, started, 4096), marker = record(JSON.parse(bytes.toString('utf8')));
        invariant(Number.isSafeInteger(marker.pid) && Number(marker.pid) > 1 && marker.token === token && marker.script === script &&
          processAlive(Number(marker.pid)) && sha256(await readControlled(directory, script, 65536)) === scriptHash, 'LIVE_SCRIPT_IDENTITY');
        scriptPid = Number(marker.pid); markerSha256 = sha256(bytes);
        const job = store.get(originalId), admissions = store.value<PromptAdmission[]>('business-prompt-admissions:' + originalId);
        invariant(job.kind === 'agent' && job.status === 'running' && admissions?.filter(row => row.admitted).length === 1, 'LIVE_PROMPT_BOUNDARY');
        originalRef = store.session(job.session_key).agent_ref_json!; invariant(originalRef, 'LIVE_NATIVE_REF_MISSING'); admissionsBefore = JSON.stringify(admissions);
        const markerFiles = [path.join(c.stateRoot, 'agent-process.json')];
        for (const role of ['bridge', 'route', 'recap']) {
          const root = path.join(c.orchestration!.controllerRuntime.workRoot, role); if (!existsSync(root)) continue;
          for (const id of readdirSync(root)) if (/^[0-9a-f-]{36}$/.test(id) && existsSync(path.join(root, id, 'process.json'))) markerFiles.push(path.join(root, id, 'process.json'));
        }
        for (const file of markerFiles) {
          const value = record(JSON.parse((await readControlled(c.stateRoot, file, 16384)).toString('utf8')));
          invariant(Number.isSafeInteger(value.pid) && Number(value.pid) > 1, 'LIVE_PROCESS_MARKER'); knownGroups.push(Number(value.pid));
        }
        const boundary = { parentPid: child.pid, taskId: originalId, admissions, nativeRefSha256: sha256(originalRef), scriptPid,
          scriptSha256: scriptHash, markerSha256, nativeGroups: knownGroups, fault: 'actual SIGKILL of bridge host process only' };
        writeFileSync(path.join(output, 'kill-boundary.json'), JSON.stringify(boundary, null, 2), { mode: 0o600 });
        invariant(child.kill('SIGKILL'), 'LIVE_KILL_FAILED');
        const exit = await deadline(exited!, 10000, 'LIVE_KILL_TIMEOUT'); invariant(exit.signal === 'SIGKILL', 'LIVE_KILL_NOT_OBSERVED');
        // Harness cleanup is distinct from bridge recovery; it never approves the interrupted job.
        releaseScript(token);
        const cleanupUntil = Date.now() + 120000;
        while (processAlive(scriptPid) || knownGroups.some(pid => processAlive(pid) || processAlive(-pid))) {
          invariant(Date.now() < cleanupUntil, 'LIVE_CRASH_CHILDREN_UNVERIFIED'); await sleep(100);
        }
      } finally { store.close(); }
    } });
    const { service, c } = fixture, original = service.store.get(originalId), session = service.store.session(original.session_key);
    const effects = service.store.db.prepare("SELECT state,job_task_id FROM controller_effects WHERE request_id=? AND effect_key='business-submit'").all(originalId);
    observe('restartState', original.status === 'interrupted' && service.store.blocked() && session.state === 'tainted' && session.agent_ref_json === originalRef,
      { status: original.status, blocked: service.store.blocked(), sessionState: session.state, nativeRefSha256: sha256(session.agent_ref_json!),
        staleResourcesArchived: readdirSync(c.stateRoot).filter(name => name.includes('.stopped-')), sideEffectsReviewed: original.reviewed_at !== null });
    observe('effectRecovery', effects.length === 1 && effects[0]!.state === 'uncertain' && effects[0]!.job_task_id === originalId, effects);
    const asked = await service.accept({ id: randomUUID(), session: 'fixture', text: test.steps[2]!.detail, images: [] });
    invariant(asked.taskId && !asked.rejected, 'LIVE_STATUS_QUERY_REJECTED'); await service.settle();
    const admissions = service.store.value<PromptAdmission[]>('business-prompt-admissions:' + originalId), jobs = service.store.db.prepare("SELECT task_id,status FROM jobs WHERE kind='agent'").all();
    const once = admissions?.filter(row => row.admitted).length === 1 && JSON.stringify(admissions) === admissionsBefore && jobs.length === 1 && jobs[0]!.task_id === originalId;
    observe('businessSubmitCount', once, { admissions, jobs });
    observe('noBusinessReplay', once && !service.store.value('business-wire:' + asked.taskId) && sha256(await readControlled(path.dirname(started), started, 4096)) === markerSha256 && service.store.blocked(),
      { admissions, markerSha256, queryId: asked.taskId, queryStatus: service.store.get(asked.taskId).status, blocked: service.store.blocked() });
    const replay = replayEvidence(service.store, [originalId]); if (replay.complete) observe('noBusinessReplayAfterUncertain', replay.pass && once, replay.actual);
    const rows = [originalId, asked.taskId].map(id => ({ source: service.store.db.prepare('SELECT raw_query_sha256 FROM orchestration_requests WHERE request_id=?').get(id)!.raw_query_sha256,
      bridge: service.store.value<{ textSha256: string }>('controller-wire:bridge:' + id)?.textSha256, business: service.store.value<{ textSha256: string }>('business-wire:' + id)?.textSha256 }));
    observe('rawQueryMatchesSourceRequest', rows.every(row => row.source === row.bridge) && rows[0]!.source === rows[0]!.business && !rows[1]!.business, rows);
    observe('permissionScopeValid', c.codex.sandbox === 'workspace-write' && !c.codex.networkAccess && JSON.parse(original.input_json).workspaceId === 'term4u',
      { basis: 'fixture configuration and observed native/script process groups only; not detached-daemon or OS-isolation proof' });
    const closure = await recoveredControllerClosure(service.store, c.orchestration!.controllerRuntime.workRoot, c.orchestration!.controllerRuntime.command, output, originalId);
    const disclosure = bridgeDisclosure(service.store, [originalId, asked.taskId], [closure]); if (disclosure.complete) observe('noBridgeRawAnswerDisclosure', disclosure.pass, disclosure.actual);
    fixture.save('restart-log.json', { restart: observations.restartState, queryId: asked.taskId, disclosure });
    fixture.save('submit-count.json', observations.businessSubmitCount); fixture.save('persisted-native-ref.json', { beforeSha256: sha256(originalRef), afterSha256: sha256(session.agent_ref_json!) });
  } catch (error) { failure = errorCode(error, 'LIVE_CASE_FAILED'); }
  finally {
    try { releaseScript('runner cleanup'); }
    catch (error) { failure = errorCode(error, 'LIVE_SCRIPT_RELEASE_FAILED'); }
    if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    try {
      if (exited) await deadline(exited, 30000, 'LIVE_CHILD_CLEANUP_TIMEOUT');
      await fixture?.close();
      const controllerMarkers = workRoot ? ['bridge', 'route', 'recap'].some(role => {
        const root = path.join(workRoot, role); return existsSync(root) && readdirSync(root).some(id => existsSync(path.join(root, id, 'process.json')));
      }) : false;
      cleanupConfirmed = (!scriptPid || !processAlive(scriptPid)) && knownGroups.every(pid => !processAlive(pid) && !processAlive(-pid)) &&
        (!stateRoot || !existsSync(path.join(stateRoot, 'agent-process.json'))) && !controllerMarkers;
      invariant(cleanupConfirmed, 'LIVE_CRASH_CLEANUP_UNVERIFIED');
    } catch (error) { failure = errorCode(error, 'LIVE_CLEANUP_FAILED'); }
    writeFileSync(path.join(output, 'observations.json'), JSON.stringify(observations, null, 2), { mode: 0o600 });
    writeFileSync(path.join(output, 'cleanup.json'), JSON.stringify({ cleanupConfirmed, stateRoot, scriptPid, knownGroups }), { mode: 0o600 });
  }
  const assertions: AssertionResult[] = [...test.assertions, ...globals.map(predicate => ({ id: test.id + '-GLOBAL-' + predicate, predicate, expected: 'true' }))].map(a => {
    const observed = observations[a.predicate]; return observed ? { ...a, status: observed.pass ? 'PASS' : 'FAIL', actual: observed.actual, evidence: ['observations.json'] }
      : { ...a, status: failure ? 'FAIL' : 'BLOCKED', reason: failure ?? 'PREDICATE_ORACLE_NOT_IMPLEMENTED' };
  });
  const result = finalizeCase(test, attempt, globals, assertions);
  return failure ? { ...result, status: 'FAIL', failureCode: failure, cleanupConfirmed } : { ...result, cleanupConfirmed };
}
