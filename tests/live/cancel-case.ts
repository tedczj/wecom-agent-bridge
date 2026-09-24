import { randomUUID } from 'node:crypto';
import { existsSync, writeFileSync, appendFileSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import type { Config } from '../../src/config.ts';
import type { NormalizedInput } from '../../src/types.ts';
import { invariant, errorCode } from '../../src/errors.ts';
import { deadline } from '../../src/async.ts';
import { processAlive, readControlled } from '../../src/fsutil.ts';
import { sha256 } from '../../src/orchestration/requests.ts';
import { liveFixture } from './fixture.ts';
import { replayEvidence } from './replay.ts';
import { bridgeDisclosure } from './bridge-disclosure.ts';
import { finalizeCase, type AssertionResult, type CaseResult } from './report.ts';
import type { LiveCase } from './spec.ts';

export async function runCancelCase(base: Config, test: LiveCase, attempt: number, globals: string[], output: string): Promise<CaseResult> {
  invariant(test.id === 'LIVE-16', 'LIVE_SCENARIO_UNSUPPORTED');
  const fixture = await liveFixture(base, output, 'workspace-write'), { service, c } = fixture;
  const directory = path.join(fixture.projectRoot, 'term4u'), token = randomUUID(), script = path.join(directory, 'long-task.cjs');
  const started = path.join(directory, '.long-started'), release = path.join(directory, '.long-release');
  const observations: Record<string, { pass: boolean; actual: unknown }> = {};
  let failure: string | undefined, cleanupConfirmed = false, scriptPid: number | undefined;
  const observe = (name: string, pass: boolean, actual: unknown) => { observations[name] = { pass, actual }; };
  try {
    writeFileSync(script, `const fs=require('node:fs'),path=require('node:path');
fs.writeFileSync(path.join(__dirname,'.long-started'),JSON.stringify({pid:process.pid,token:${JSON.stringify(token)},at:Date.now(),script:fs.realpathSync(__filename)}),{flag:'wx',mode:0o600});
const end=Date.now()+120000;
const timer=setInterval(()=>{fs.writeFileSync(path.join(__dirname,'.long-heartbeat'),String(Date.now()),{mode:0o600});
if(fs.existsSync(path.join(__dirname,'.long-release'))||Date.now()>end){clearInterval(timer);process.stdout.write('long task stopped\\n');}},100);
`, { mode: 0o600, flag: 'wx' });
    appendFileSync(path.join(directory, 'README.md'), '\n长任务测试入口：`node long-task.cjs`。脚本由 runner 取消，请正常运行，不修改脚本和控制文件。\n');
    const scriptSha256 = sha256(readFileSync(script));
    const accepted = await service.accept({ id: randomUUID(), session: 'fixture', text: test.steps[0]!.detail, images: [] });
    invariant(accepted.taskId && !accepted.rejected, 'LIVE_REQUEST_REJECTED');
    const id = accepted.taskId, expires = Date.now() + 240000;
    while (!existsSync(started)) {
      invariant(Date.now() < expires, 'LIVE_SCRIPT_START_TIMEOUT');
      const phase = service.store.db.prepare('SELECT phase FROM orchestration_requests WHERE request_id=?').get(id)!.phase;
      invariant(!['failed', 'cancelled', 'interrupted', 'completed'].includes(String(phase)), 'LIVE_SCRIPT_NOT_STARTED'); await sleep(100);
    }
    const markerBytes = await readControlled(directory, started, 4096), marker = JSON.parse(markerBytes.toString('utf8'));
    invariant(Number.isSafeInteger(marker.pid) && marker.pid > 1 && marker.token === token && marker.script === script && processAlive(marker.pid), 'LIVE_PROCESS_UNVERIFIED');
    const pid: number = marker.pid; scriptPid = pid;
    const command = execFileSync('/bin/ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8', timeout: 3000, maxBuffer: 16384 });
    invariant(command.includes('long-task.cjs'), 'LIVE_PROCESS_UNVERIFIED');
    const running = service.store.get(id), beforeClock = service.store.session(running.session_key).last_response_at;
    invariant(running.kind === 'agent' && running.status === 'running', 'LIVE_NOT_RUNNING');
    const beforeCancel = Date.now();
    const cancelled = await deadline(service.accept({ id: randomUUID(), session: 'fixture', text: '/cancel ' + id, images: [] }), 5000, 'LIVE_CANCEL_TIMEOUT');
    const elapsed = Date.now() - beforeCancel;
    invariant(cancelled.taskId && !cancelled.rejected, 'LIVE_CANCEL_REJECTED');
    const control = service.store.get(cancelled.taskId);
    observe('controlResponsiveness', elapsed < 5000 && control.kind === 'command' && control.status === 'succeeded', { elapsedMs: elapsed, taskId: cancelled.taskId, status: control.status });
    fixture.save('cancel-request.json', { requestId: id, cancelTaskId: cancelled.taskId, elapsedMs: elapsed, status: control.status });
    await deadline(service.settle(), 30000, 'LIVE_CANCEL_SETTLE_TIMEOUT');
    const terminal = service.store.get(id), stopped = !processAlive(pid), blocked = service.store.blocked();
    observe('executionStoppedOrBlocked', terminal.status === 'cancelled' && stopped || terminal.status === 'interrupted' && blocked,
      { status: terminal.status, errorCode: terminal.error_code, knownScriptStopped: stopped, blocked, scope: 'observed fixture process only; not arbitrary detached-daemon proof' });
    const admissions = service.store.value<Array<{ admitted: boolean }>>('business-prompt-admissions:' + id);
    const status = await service.accept({ id: randomUUID(), session: 'fixture', text: '/status', images: [] });
    invariant(status.taskId && !status.rejected, 'LIVE_STATUS_REJECTED'); await deadline(service.settle(), 10000, 'LIVE_STATUS_TIMEOUT');
    observe('noBusinessReplay', admissions?.filter(a => a.admitted).length === 1 && JSON.stringify(admissions) === JSON.stringify(service.store.value('business-prompt-admissions:' + id)) &&
      service.store.db.prepare("SELECT count(*) n FROM jobs WHERE kind='agent'").get()!.n === 1 && sha256(await readControlled(directory, started, 4096)) === sha256(markerBytes),
      { admissions, after: service.store.value('business-prompt-admissions:' + id), agentJobs: service.store.db.prepare("SELECT task_id,status FROM jobs WHERE kind='agent'").all() });
    const afterClock = service.store.session(running.session_key).last_response_at;
    observe('lastResponseUnchanged', afterClock === beforeClock, { beforeClock, afterClock });
    const input = JSON.parse(running.input_json) as NormalizedInput;
    const source = service.store.db.prepare('SELECT raw_query_sha256 FROM orchestration_requests WHERE request_id=?').get(id)!.raw_query_sha256;
    const wires = ['business-wire:', 'controller-wire:bridge:', 'controller-wire:route:'].map(prefix => service.store.value<{ textSha256: string }>(prefix + id));
    observe('rawQueryMatchesSourceRequest', wires.every(w => w?.textSha256 === source), { source, wires });
    observe('permissionScopeValid', input.routing?.directory.path === directory && c.codex.sandbox === 'workspace-write' && !c.codex.networkAccess,
      { directorySha256: sha256(directory), sandbox: c.codex.sandbox, networkAccess: c.codex.networkAccess, basis: 'host scope/configuration, not OS-isolation proof' });
    const replay = replayEvidence(service.store, [id]); if (replay.complete) observe('noBusinessReplayAfterUncertain', replay.pass, replay.actual);
    const disclosure = bridgeDisclosure(service.store, [id]); if (disclosure.complete) observe('noBridgeRawAnswerDisclosure', disclosure.pass, disclosure.actual);
    invariant(sha256(readFileSync(script)) === scriptSha256, 'LIVE_SCRIPT_CHANGED');
    fixture.save('process-events.json', { marker, commandSha256: sha256(command), scriptSha256, stoppedBeforeHarnessRelease: stopped });
    fixture.save('terminal-state.json', { jobStatus: terminal.status, errorCode: terminal.error_code, blocked, beforeClock, afterClock });
    fixture.save('workspace-lock.json', { blocked, nativeProcessMarkerPresent: existsSync(path.join(c.stateRoot, 'agent-process.json')) });
  } catch (error) { failure = errorCode(error, 'LIVE_CASE_FAILED'); }
  finally {
    // Test cleanup releases only this known script; terminal assertions above are
    // captured before this cleanup and never attribute its stop to the bridge.
    try { writeFileSync(release, token, { mode: 0o600 }); } catch (error) { failure = errorCode(error, 'LIVE_SCRIPT_RELEASE_FAILED'); }
    try {
      await fixture.close(); const until = Date.now() + 2000;
      while (scriptPid && processAlive(scriptPid) && Date.now() < until) await sleep(50);
      cleanupConfirmed = !scriptPid || !processAlive(scriptPid); invariant(cleanupConfirmed, 'LIVE_SCRIPT_CLEANUP_UNVERIFIED');
    } catch (error) { failure = errorCode(error, 'LIVE_CLEANUP_FAILED'); }
    fixture.save('observations.json', observations);
  }
  const assertions: AssertionResult[] = [...test.assertions, ...globals.map(predicate => ({ id: test.id + '-GLOBAL-' + predicate, predicate, expected: 'true' }))].map(a => {
    const observed = observations[a.predicate]; return observed ? { ...a, status: observed.pass ? 'PASS' : 'FAIL', actual: observed.actual, evidence: ['observations.json'] }
      : { ...a, status: failure ? 'FAIL' : 'BLOCKED', reason: failure ?? 'PREDICATE_ORACLE_NOT_IMPLEMENTED' };
  });
  const result = finalizeCase(test, attempt, globals, assertions);
  return failure ? { ...result, status: 'FAIL', failureCode: failure, cleanupConfirmed } : { ...result, cleanupConfirmed };
}
