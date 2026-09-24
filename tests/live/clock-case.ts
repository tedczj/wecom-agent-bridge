import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Config } from '../../src/config.ts';
import { invariant, errorCode } from '../../src/errors.ts';
import { ArtifactStore } from '../../src/answers/artifact-store.ts';
import { RecapService } from '../../src/answers/recap.ts';
import { modelDigest } from '../../src/orchestration/config.ts';
import { sha256 } from '../../src/orchestration/requests.ts';
import { liveFixture } from './fixture.ts';
import { bridgeDisclosure } from './bridge-disclosure.ts';
import { replayEvidence } from './replay.ts';
import { finalizeCase, type AssertionResult, type CaseResult } from './report.ts';
import type { LiveCase } from './spec.ts';

export async function runClockCase(base: Config, test: LiveCase, attempt: number, globals: string[], output: string): Promise<CaseResult> {
  invariant(test.id === 'LIVE-20', 'LIVE_SCENARIO_UNSUPPORTED');
  const branches: Array<Record<string, unknown>> = []; let failure: string | undefined, cleanupConfirmed = true;
  try {
    for (const variant of ['at-24h', 'after-24h', 'explicit-old', 'management-only']) {
      const evidence = path.join(output, variant); mkdirSync(evidence, { mode: 0o700 }); let injectedNow: number | undefined;
      const fixture = await liveFixture(base, evidence, 'read-only', { businessClock: () => injectedNow ?? Date.now() }), { service, c } = fixture;
      try {
        const setup = await service.accept({ id: randomUUID(), session: 'fixture', text: `在 term4u 记住本会话校验词 ${randomUUID()}。只回复“已记住”，不要使用工具或修改文件。`, images: [] });
        invariant(setup.taskId && !setup.rejected, 'LIVE_SETUP_REJECTED'); await service.settle();
        const original = service.store.get(setup.taskId); invariant(original.kind === 'agent' && original.status === 'succeeded', 'LIVE_SETUP_INCOMPLETE');
        const session = service.store.session(original.session_key), beforeRef = session.agent_ref_json, beforeClock = session.last_response_at;
        invariant(beforeRef && beforeClock !== null, 'LIVE_NATIVE_REF_MISSING');
        injectedNow = beforeClock + 24 * 3600000 + (variant === 'at-24h' ? 0 : 1);
        const queryIds = [setup.taskId], samples: Array<{ operation: string; lastResponseAt: number | null }> = [];
        const send = async (text: string) => {
          const accepted = await service.accept({ id: randomUUID(), session: 'fixture', text, images: [] });
          invariant(accepted.taskId && !accepted.rejected, 'LIVE_REQUEST_REJECTED'); await service.settle();
          return service.store.get(accepted.taskId);
        };
        let branchPass = false, rotation: unknown;
        if (variant === 'at-24h' || variant === 'after-24h') {
          const job = await send(test.steps[0]!.detail); queryIds.push(job.task_id);
          invariant(job.kind === 'agent' && job.status === 'succeeded', 'LIVE_BUSINESS_NOT_COMPLETED');
          const ref = service.store.session(job.session_key).agent_ref_json;
          branchPass = variant === 'at-24h' ? job.session_key === original.session_key && ref === beforeRef : job.session_key !== original.session_key && !!ref && ref !== beforeRef;
          samples.push({ operation: variant, lastResponseAt: service.store.session(original.session_key).last_response_at });
        } else if (variant === 'explicit-old') {
          const list = await send('/sessions term4u'); invariant(list.status === 'succeeded', 'LIVE_SESSION_LIST_FAILED');
          const resumed = await send('/resume 1');
          branchPass = resumed.kind === 'command' && resumed.status === 'succeeded' && resumed.session_key === original.session_key && service.store.session(original.session_key).agent_ref_json === beforeRef;
          samples.push({ operation: 'explicit-resume-with-verifier', lastResponseAt: service.store.session(original.session_key).last_response_at });
        } else {
          for (const command of ['/sessions term4u', '/read 1', '/result ' + setup.taskId]) {
            const job = await send(command); invariant(job.status === 'succeeded', 'LIVE_MANAGEMENT_CONTROL_FAILED');
            samples.push({ operation: command.split(' ')[0]!, lastResponseAt: service.store.session(original.session_key).last_response_at });
          }
          const scope = service.store.db.prepare('SELECT conversation_scope FROM orchestration_requests WHERE request_id=?').get(setup.taskId)!.conversation_scope as string;
          const artifact = service.store.db.prepare("SELECT answer_id FROM answer_artifacts WHERE job_task_id=? AND kind='final' AND state='ready'").get(setup.taskId)!;
          const recap = await new RecapService(service.store, new ArtifactStore(service.store, c.orchestration!.answers.root), undefined,
            modelDigest(c.models![c.orchestration!.answers.recapModelProfile]!)).run(artifact.answer_id as string, scope);
          invariant(recap.state === 'ready' && recap.source === 'verbatim-short', 'LIVE_RECAP_CACHE_UNAVAILABLE');
          samples.push({ operation: 'cached-verbatim-recap; no LLM call claimed', lastResponseAt: service.store.session(original.session_key).last_response_at });
          const before = service.store.db.prepare('SELECT controller_id,role,generation,usage_json FROM controller_sessions WHERE is_current=1').all();
          invariant(before.length === 2, 'LIVE_CONTROLLER_SETUP');
          // Boundary-state injection only. Never falsify a runtime usage sample.
          service.store.db.prepare("UPDATE controller_sessions SET state='rotate_pending' WHERE is_current=1 AND state='ready'").run();
          const history = await send('只查询 term4u 的历史进度，不执行任何业务任务。'); queryIds.push(history.task_id);
          invariant(history.kind === 'command' && history.status === 'succeeded', 'LIVE_HISTORY_QUERY_FAILED');
          const after = service.store.db.prepare('SELECT controller_id,role,generation FROM controller_sessions WHERE is_current=1').all();
          const retired = service.store.db.prepare("SELECT controller_id,usage_json FROM controller_sessions WHERE state='retired'").all();
          rotation = { injected: 'registry rotate_pending state, not runtime usage', real80Verified: false, before, after };
          samples.push({ operation: 'injected-rotation-and-real-history-query', lastResponseAt: service.store.session(original.session_key).last_response_at });
          branchPass = after.some(row => row.role === 'bridge' && Number(row.generation) > 0) && before.every(row =>
            !retired.some(old => old.controller_id === row.controller_id) || retired.find(old => old.controller_id === row.controller_id)!.usage_json === row.usage_json);
        }
        const work = service.store.db.prepare("SELECT task_id,status FROM jobs WHERE kind='agent'").all();
        if (variant === 'management-only' || variant === 'explicit-old') branchPass &&= work.length === 1 && samples.every(s => s.lastResponseAt === beforeClock);
        const raw = queryIds.map(id => ({ source: service.store.db.prepare('SELECT raw_query_sha256 FROM orchestration_requests WHERE request_id=?').get(id)!.raw_query_sha256,
          bridge: service.store.value<{ textSha256: string }>('controller-wire:bridge:' + id)?.textSha256,
          business: service.store.value<{ textSha256: string }>('business-wire:' + id)?.textSha256, kind: service.store.get(id).kind }));
        const disclosure = bridgeDisclosure(service.store, queryIds), replay = replayEvidence(service.store, work.map(row => row.task_id as string));
        const facts = { variant, branchPass, clockInjected: true, usageInjected: false, rotationStateInjected: variant === 'management-only', real24hWait: false,
          beforeClock, injectedNow, beforeRefSha256: sha256(beforeRef), afterRefSha256: sha256(service.store.session(original.session_key).agent_ref_json!), samples, rotation, work,
          rawExact: raw.every(row => row.source === row.bridge && (row.kind === 'agent' ? row.source === row.business : row.business === undefined)), raw,
          disclosure, replay, permissionValid: c.codex.sandbox === 'read-only' && !c.codex.networkAccess };
        branches.push(facts); fixture.save('branch.json', facts);
      } finally { try { await fixture.close(); } catch (error) { cleanupConfirmed = false; failure = errorCode(error, 'LIVE_CLEANUP_FAILED'); } }
      if (!cleanupConfirmed) break;
    }
  } catch (error) { failure = errorCode(error, 'LIVE_CASE_FAILED'); }
  const observations: Record<string, { pass: boolean; actual: unknown }> = {};
  if (branches.length === 4) {
    observations.ageBoundary = { pass: branches.slice(0, 2).every(b => b.branchPass), actual: branches.slice(0, 2) };
    observations.noClockRefreshByManagement = { pass: branches[3]!.branchPass === true, actual: branches[3] };
    observations.explicitOldResume = { pass: branches[2]!.branchPass === true, actual: branches[2] };
    observations.injectionDisclosure = { pass: true, actual: { clockInjected: true, rotationStateInjected: true, usageInjected: false, real24hWait: false, real80Verified: false } };
    observations.rawQueryMatchesSourceRequest = { pass: branches.every(b => b.rawExact), actual: branches.map(b => b.raw) };
    observations.permissionScopeValid = { pass: branches.every(b => b.permissionValid), actual: { basis: 'host profile, not OS isolation' } };
    const disclosures = branches.map(b => b.disclosure as ReturnType<typeof bridgeDisclosure>), replays = branches.map(b => b.replay as ReturnType<typeof replayEvidence>);
    if (disclosures.every(d => d.complete)) observations.noBridgeRawAnswerDisclosure = { pass: disclosures.every(d => d.pass), actual: disclosures.map(d => d.actual) };
    if (replays.every(d => d.complete)) observations.noBusinessReplayAfterUncertain = { pass: replays.every(d => d.pass), actual: replays.map(d => d.actual) };
  }
  for (const name of ['clock-seam.json', 'binding-before-after.json', 'last-response-times.json', 'observations.json'])
    writeFileSync(path.join(output, name), JSON.stringify(name === 'observations.json' ? observations : { branches, real24hWait: false, real80Verified: false }, null, 2), { mode: 0o600 });
  const assertions: AssertionResult[] = [...test.assertions, ...globals.map(predicate => ({ id: test.id + '-GLOBAL-' + predicate, predicate, expected: 'true' }))].map(a => {
    const observed = observations[a.predicate]; return observed ? { ...a, status: observed.pass ? 'PASS' : 'FAIL', actual: observed.actual, evidence: ['observations.json'] }
      : { ...a, status: failure ? 'FAIL' : 'BLOCKED', reason: failure ?? 'PREDICATE_ORACLE_NOT_IMPLEMENTED' };
  });
  const result = finalizeCase(test, attempt, globals, assertions);
  return failure ? { ...result, status: 'FAIL', failureCode: failure, cleanupConfirmed } : { ...result, cleanupConfirmed };
}
