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
import { HierarchicalBridge } from '../../src/orchestration/engine.ts';
import { liveFixture } from './fixture.ts';
import { mediaOrderMeter } from './media-order-meter.ts';
import { bridgeDisclosure } from './bridge-disclosure.ts';
import { replayEvidence } from './replay.ts';
import { finalizeCase, type AssertionResult, type CaseResult } from './report.ts';
import type { LiveCase } from './spec.ts';

export async function runFifoCase(base: Config, test: LiveCase, attempt: number, globals: string[], output: string): Promise<CaseResult> {
  invariant(test.id === 'LIVE-25', 'LIVE_SCENARIO_UNSUPPORTED');
  const fixture = await liveFixture(base, output, 'workspace-write'), { service, c } = fixture;
  const meter = mediaOrderMeter(), directory = path.join(fixture.projectRoot, 'term4u'), token = randomUUID();
  const releaseFile = path.join(directory, '.first-release');
  const observations: Record<string, { pass: boolean; actual: unknown }> = {};
  let failure: string | undefined, cleanupConfirmed = false, scriptPid: number | undefined;
  const observe = (name: string, pass: boolean, actual: unknown) => { observations[name] = { pass, actual }; };
  try {
    writeFileSync(path.join(directory, 'package.json'), JSON.stringify({ private: true, type: 'commonjs' }), { mode: 0o600, flag: 'wx' });
    for (const name of ['first-task', 'second-task']) {
      const file = path.join(directory, name);
      writeFileSync(file, '#!/usr/bin/env node\n' + `const fs=require('node:fs'); const path=require('node:path'); const root=__dirname;
const record={pid:process.pid,token:${JSON.stringify(token)},script:fs.realpathSync(__filename),at:Date.now()};
fs.writeFileSync(path.join(root,${JSON.stringify('.' + name + '-started')}),JSON.stringify(record),{flag:'wx',mode:0o600});
${name === 'first-task' ? `const end=Date.now()+120000;
const timer=setInterval(()=>{if(fs.existsSync(path.join(root,'.first-release'))){clearInterval(timer);process.stdout.write('first-task completed\\n');}
else if(Date.now()>end){clearInterval(timer);process.exitCode=2;}},100);` : "process.stdout.write('second-task completed\\n');"}
`, { mode: 0o700, flag: 'wx' });
    }
    appendFileSync(path.join(directory, 'README.md'), '\n测试入口：`./first-task` 与 `./second-task`。first-task 等待 runner 的释放信号，请正常运行脚本，不修改它们或它们的控制文件。\n');
    const sourceHashes = Object.fromEntries(['first-task', 'second-task', 'README.md', 'package.json'].map(name => [name, sha256(readFileSync(path.join(directory, name)))]));
    const gitBefore = fixture.gitState(); fixture.save('git-before.json', gitBefore);
    const frames = test.steps.slice(0, 2).map(step => ({ id: randomUUID(), session: 'fixture', text: step.detail, images: [] }));
    const first = await service.accept(frames[0]), second = await service.accept(frames[1]);
    invariant(first.taskId && second.taskId && !first.rejected && !second.rejected, 'LIVE_REQUEST_REJECTED');
    const ids = [first.taskId, second.taskId];
    invariant(service.bridge instanceof HierarchicalBridge, 'LIVE_HIERARCHICAL_REQUIRED');
    await deadline(service.bridge.mediaReady(second.taskId), 5000, 'LIVE_SECOND_MEDIA_NOT_READY');
    const media = meter.snapshot(), secondReadyFirst = media.some(e => e.taskId === second.taskId && e.event === 'completed') &&
      !media.some(e => e.taskId === first.taskId && e.event === 'completed');
    const noEarlyPlanning = service.store.db.prepare('SELECT count(*) n FROM controller_sessions').get()!.n === 0;
    fixture.save('media-order.json', { media, secondReadyFirst, noEarlyPlanning }); meter.release();
    const started = path.join(directory, '.first-task-started'), expires = Date.now() + 240000;
    while (!existsSync(started)) {
      invariant(Date.now() < expires, 'LIVE_SCRIPT_START_TIMEOUT');
      const phase = service.store.db.prepare('SELECT phase FROM orchestration_requests WHERE request_id=?').get(first.taskId)!.phase;
      invariant(!['failed', 'cancelled', 'interrupted', 'completed'].includes(String(phase)), 'LIVE_SCRIPT_NOT_STARTED'); await sleep(100);
    }
    const process = JSON.parse((await readControlled(directory, started, 4096)).toString('utf8'));
    invariant(Number.isSafeInteger(process.pid) && process.pid > 1 && process.token === token && process.script === path.join(directory, 'first-task') && processAlive(process.pid), 'LIVE_PROCESS_UNVERIFIED');
    const pid: number = process.pid; scriptPid = pid;
    const command = execFileSync('/bin/ps', ['-p', String(scriptPid), '-o', 'command='], { encoding: 'utf8', timeout: 3000, maxBuffer: 16384 });
    invariant(command.includes('first-task'), 'LIVE_PROCESS_UNVERIFIED');
    const firstJob = service.store.get(first.taskId), native = service.store.session(firstJob.session_key).agent_ref_json;
    const beforeStatus = Date.now();
    const status = await deadline(service.accept({ id: randomUUID(), session: 'fixture', text: '/status', images: [] }), 5000, 'LIVE_STATUS_TIMEOUT');
    const elapsed = Date.now() - beforeStatus;
    invariant(status.taskId && !status.rejected, 'LIVE_STATUS_REJECTED');
    const statusJob = service.store.get(status.taskId), firstRunning = service.store.get(first.taskId).status === 'running';
    const secondNotSubmitted = !service.store.value('business-wire:' + second.taskId) && !existsSync(path.join(directory, '.second-task-started'));
    fixture.save('status-response.json', { requestId: status.taskId, elapsedMs: elapsed, kind: statusJob.kind, status: statusJob.status,
      resultSha256: sha256(statusJob.result_text ?? ''), firstRunning, secondNotSubmitted });
    fixture.save('slot-ownership.json', { scriptPid,
      controllers: service.store.db.prepare('SELECT role,controller_id,state,generation FROM controller_sessions').all(),
      requests: service.store.db.prepare('SELECT request_id,phase FROM orchestration_requests ORDER BY ingress_seq').all(),
      jobs: service.store.db.prepare('SELECT task_id,kind,status,started_at,finished_at FROM jobs ORDER BY seq').all() });
    observe('controlResponsiveness', elapsed < 5000 && firstRunning && statusJob.kind === 'command' && statusJob.status === 'succeeded' && processAlive(pid),
      { elapsedMs: elapsed, statusTaskId: status.taskId, status: statusJob.status, firstRunning, scriptPid, commandSha256: sha256(command) });
    writeFileSync(releaseFile, token, { mode: 0o600, flag: 'wx' });
    await deadline(service.settle(), 360000, 'LIVE_SETTLE_TIMEOUT');
    const jobs = ids.map(id => service.store.get(id));
    invariant(jobs.every(job => job.kind === 'agent' && job.status === 'succeeded'), 'LIVE_BUSINESS_NOT_COMPLETED');
    const lastMarker = JSON.parse((await readControlled(directory, path.join(directory, '.second-task-started'), 4096)).toString('utf8'));
    const admissions = ids.map(id => service.store.value<Array<{ at: number; admitted: boolean }>>('business-prompt-admissions:' + id));
    const secondSubmit = admissions[1]?.find(a => a.admitted)?.at;
    fixture.save('scheduler-timeline.json', { media: meter.snapshot(), admissions,
      requests: service.store.db.prepare('SELECT request_id,ingress_seq,phase FROM orchestration_requests ORDER BY ingress_seq').all(),
      jobs: jobs.map(j => ({ taskId: j.task_id, startedAt: j.started_at, finishedAt: j.finished_at })), firstScriptAt: process.at, secondScriptAt: lastMarker.at });
    observe('fifoOrder', secondReadyFirst && noEarlyPlanning && secondNotSubmitted && Number.isSafeInteger(secondSubmit) &&
      jobs[0]!.finished_at !== null && secondSubmit! >= jobs[0]!.finished_at! && lastMarker.token === token && lastMarker.at >= jobs[0]!.finished_at!,
      { media, secondReadyFirst, noEarlyPlanning, secondNotSubmitted, admissions, jobs: jobs.map(j => ({ id: j.task_id, startedAt: j.started_at, finishedAt: j.finished_at })), secondScriptAt: lastMarker.at });
    observe('noDeadlock', jobs.every(j => j.status === 'succeeded') && !processAlive(pid), { statuses: jobs.map(j => j.status), scriptStopped: !processAlive(pid) });
    observe('sameNativeSession', !!native && jobs[0]!.session_key === jobs[1]!.session_key && service.store.session(jobs[1]!.session_key).agent_ref_json === native, { nativeRefHash: native ? sha256(native) : null });
    const inputs = jobs.map(j => JSON.parse(j.input_json) as NormalizedInput);
    const wires = ids.map(id => ({ source: service.store.db.prepare('SELECT raw_query_sha256 FROM orchestration_requests WHERE request_id=?').get(id)!.raw_query_sha256,
      business: service.store.value<{ textSha256: string }>('business-wire:' + id), bridge: service.store.value<{ textSha256: string }>('controller-wire:bridge:' + id), route: service.store.value<{ textSha256: string }>('controller-wire:route:' + id) }));
    observe('rawQueryMatchesSourceRequest', wires.every(w => [w.business, w.bridge, w.route].every(sent => sent?.textSha256 === w.source)), wires);
    observe('permissionScopeValid', inputs.every(input => input.workspaceId === 'term4u' && input.routing?.directory.path === directory) && c.codex.sandbox === 'workspace-write' && !c.codex.networkAccess,
      { basis: 'host fixture authorization, not OS isolation', directoryHash: sha256(directory), sandbox: c.codex.sandbox, networkAccess: c.codex.networkAccess });
    const disclosure = bridgeDisclosure(service.store, ids), replay = replayEvidence(service.store, ids);
    if (disclosure.complete) observe('noBridgeRawAnswerDisclosure', disclosure.pass, disclosure.actual);
    if (replay.complete) observe('noBusinessReplayAfterUncertain', replay.pass, replay.actual);
    invariant(Object.entries(sourceHashes).every(([name, hash]) => sha256(readFileSync(path.join(directory, name))) === hash), 'LIVE_SCRIPT_CHANGED');
    fixture.save('process-events.json', { first: process, second: lastMarker, sourceHashes });
  } catch (error) { failure = errorCode(error, 'LIVE_CASE_FAILED'); }
  finally {
    meter.release();
    try { if (!existsSync(releaseFile)) writeFileSync(releaseFile, token, { mode: 0o600 }); }
    catch (error) { failure = errorCode(error, 'LIVE_SCRIPT_RELEASE_FAILED'); }
    try { await fixture.close(); cleanupConfirmed = !scriptPid || !processAlive(scriptPid); invariant(cleanupConfirmed, 'LIVE_SCRIPT_CLEANUP_UNVERIFIED'); }
    catch (error) { failure = errorCode(error, 'LIVE_CLEANUP_FAILED'); }
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
