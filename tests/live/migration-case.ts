import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseConfig, type Config } from '../../src/config.ts';
import { Store } from '../../src/store.ts';
import { CodexBackend } from '../../src/codex.ts';
import { normalize } from '../../src/local.ts';
import { Catalog } from '../../src/routing/catalog.ts';
import { hash } from '../../src/routing/config.ts';
import { maintainV4 } from '../../src/migrations/maintenance.ts';
import { ArtifactStore } from '../../src/answers/artifact-store.ts';
import { sha256 } from '../../src/orchestration/requests.ts';
import { errorCode, invariant } from '../../src/errors.ts';
import type { NormalizedInput } from '../../src/types.ts';
import { liveFixture, liveStopSignal } from './fixture.ts';
import { isolatedBusinessHome } from './isolated-home.ts';
import { bridgeDisclosure } from './bridge-disclosure.ts';
import { replayEvidence } from './replay.ts';
import { migrationBaseline, migrationNativeAudits } from './migration-baseline.ts';
import { remoteWriteEvidence } from './remote-writes.ts';
import { finalizeCase, type AssertionResult, type CaseResult } from './report.ts';
import type { LiveCase } from './spec.ts';

function preservedState(store: Store) {
  return { jobs: store.db.prepare('SELECT task_id,request_hash,status,error_code,finished_at FROM jobs ORDER BY seq').all(),
    sessions: store.db.prepare('SELECT session_key,agent_ref_json,last_response_at,state FROM sessions ORDER BY session_key').all(),
    outbox: store.db.prepare('SELECT delivery_id,task_id,state,attempts,body_json FROM outbox ORDER BY delivery_id').all().map(row => ({ ...row, body_json: sha256(row.body_json as string) })),
    cursor: store.db.prepare("SELECT value FROM metadata WHERE key='weixin:cursor'").get()?.value };
}
export async function runMigrationCase(base: Config, test: LiveCase, attempt: number, globals: string[], output: string): Promise<CaseResult> {
  invariant(test.id === 'LIVE-24', 'LIVE_SCENARIO_UNSUPPORTED');
  const isolated = await isolatedBusinessHome(base, path.join(output, 'native-home'));
  const originalRun = CodexBackend.prototype.run, calls: Array<{ taskId: string; textSha256: string }> = [], branches: Array<Record<string, unknown>> = [];
  const counted: typeof originalRun = function (this: CodexBackend, ...args) {
    calls.push({ taskId: args[0].taskId, textSha256: sha256(args[0].text) }); return originalRun.apply(this, args);
  };
  CodexBackend.prototype.run = counted;
  let failure: string | undefined, cleanupConfirmed = true;
  try {
    for (const tainted of [false, true]) {
      const directory = path.join(output, tainted ? 'tainted' : 'healthy'); mkdirSync(directory, { mode: 0o700 });
      const nonce = randomUUID(); let legacyKey = '', legacyRef = '', clippedId = '', migrationFacts: Record<string, unknown> = {};
      const fixture = await liveFixture(isolated.config, directory, 'read-only', { beforeStart: async c => {
        const legacy = parseConfig({ ...c, models: undefined, orchestration: undefined }), file = path.join(c.stateRoot, 'bridge.sqlite');
        const source = new Store(file, legacy);
        try {
          const catalog = new Catalog(legacy), model = c.models![c.orchestration!.business.defaultModelProfile]!, target = catalog.target(catalog.configured.find(row => row.id === 'term4u')!, model);
          const incoming = normalize({ id: randomUUID(), session: 'fixture', text: `在本会话记住校验词 ${nonce}。只回复“已记住”，不要使用工具或修改文件。`, images: [] }, legacy, 'local:codex');
          const job = source.reserve(incoming, 'agent', { ...target, reason: 'work', bind: true }).job;
          source.prepared(job.task_id, []); invariant(source.claim()?.task_id === job.task_id, 'LIVE_LEGACY_CLAIM');
          const backend = new CodexBackend(target.config, undefined, undefined, true); let result;
          try { result = await backend.run(JSON.parse(job.input_json) as NormalizedInput, undefined,
            { persistSession: async ref => source.persistSession(job.session_key, ref), progress: () => {} }, liveStopSignal); }
          finally { await backend.stop(); }
          invariant(result.outcome === 'success' && result.finishEvidence?.cleanupConfirmed, 'LIVE_LEGACY_NATIVE_SETUP');
          source.complete(job.task_id, 'succeeded', result.finalText); legacyKey = job.session_key;
          legacyRef = source.session(legacyKey).agent_ref_json!; invariant(legacyRef, 'LIVE_NATIVE_REF_MISSING');
          const oldScope = hash([incoming.route.channelId, incoming.route.kind, incoming.route.targetId, incoming.route.senderId]);
          source.put('conversation:' + oldScope, { active: target.directory, aliases: {}, recent: [] });
          // Synthetic legacy rows exercise truncation/taint; the native session above is real.
          const clipped = source.reserve(normalize({ id: randomUUID(), session: 'fixture', text: '合成旧版裁剪结果记录', images: [] }, legacy, 'local:codex'), 'command').job;
          source.complete(clipped.task_id, 'succeeded', '旧版内容'.repeat(Math.ceil(c.reply.maxResultBytes / 4)));
          invariant(source.get(clipped.task_id).error_code === 'OUTPUT_TRUNCATED', 'LIVE_LEGACY_TRUNCATION'); clippedId = clipped.task_id;
          if (tainted) {
            const interrupted = source.reserve(normalize({ id: randomUUID(), session: 'fixture', text: '合成旧版中断状态；未调用业务模型', images: [] }, legacy, 'local:codex'), 'agent', { ...target, reason: 'work', bind: true }).job;
            source.prepared(interrupted.task_id, []); source.claim(); source.complete(interrupted.task_id, 'interrupted', 'synthetic v3 interrupted state', 'EXECUTION_INTERRUPTED');
          }
          source.db.prepare("UPDATE outbox SET state='unknown'").run();
          source.db.prepare("INSERT INTO metadata(key,value) VALUES ('weixin:cursor','synthetic-migration-cursor')").run();
          invariant(source.duplicate(incoming)?.task_id === job.task_id, 'LIVE_LEGACY_DEDUP');
          const before = preservedState(source), callsBefore = calls.length;
          const dry = await maintainV4(c, path.join(directory, 'dry-run'));
          invariant(source.db.prepare('PRAGMA user_version').get()!.user_version === 3 && JSON.stringify(preservedState(source)) === JSON.stringify(before), 'LIVE_DRY_RUN_MUTATED_SOURCE');
          const applied = await maintainV4(c, path.join(directory, 'apply'), true);
          const after = preservedState(source), marker = source.value<{ completeness: string; originalArchived: boolean }>('legacy-result:' + clippedId);
          migrationFacts = { before, after, beforeSha256: sha256(JSON.stringify(before)), afterSha256: sha256(JSON.stringify(after)), dry, applied,
            backupSha256: sha256(readFileSync(path.join(applied.backup, 'snapshot.sqlite'))), callsBefore, callsAfter: calls.length,
            marker, oldFullArtifacts: source.db.prepare("SELECT count(*) n FROM answer_artifacts WHERE request_id=? AND kind='final' AND state='ready'").get(clippedId)!.n,
            profileMapping: source.value('legacy-profile-migration:' + legacyKey), blocked: source.blocked(),
            fixtureDisclosure: 'native session is real; truncated command result, cursor and interrupted state are synthetic legacy fixtures' };
        } finally { source.close(); }
      } });
      try {
        const { service, c } = fixture, beforeCalls = calls.length;
        const query = tainted ? '在 term4u 显式新建业务会话，只回复“开始”。' : test.steps[1]!.detail;
        const accepted = await service.accept({ id: randomUUID(), session: 'fixture', text: query, images: [] });
        invariant(accepted.taskId && !accepted.rejected, 'LIVE_MIGRATION_REQUEST'); await service.settle();
        const id = accepted.taskId, job = service.store.get(id), state = service.store.session(legacyKey);
        let resumed = false, answerMatches = false;
        if (!tainted) {
          invariant(job.kind === 'agent' && job.status === 'succeeded', 'LIVE_MIGRATION_RESUME_FAILED');
          resumed = job.session_key === legacyKey && state.agent_ref_json === legacyRef;
          const scope = service.store.db.prepare('SELECT conversation_scope FROM orchestration_requests WHERE request_id=?').get(id)!.conversation_scope as string;
          const artifact = service.store.db.prepare("SELECT answer_id FROM answer_artifacts WHERE job_task_id=? AND state='ready' AND kind='final'").get(id)!;
          const answer = await new ArtifactStore(service.store, c.orchestration!.answers.root).read(artifact.answer_id as string, { role: 'delivery', scope });
          answerMatches = answer.toString('utf8').trim() === nonce;
        }
        const raw = service.store.db.prepare('SELECT raw_query_sha256 FROM orchestration_requests WHERE request_id=?').get(id)!.raw_query_sha256;
        const bridge = service.store.value<{ textSha256: string }>('controller-wire:bridge:' + id), business = service.store.value<{ textSha256: string }>('business-wire:' + id);
        const disclosure = bridgeDisclosure(service.store, [id]), replay = tainted ? undefined : replayEvidence(service.store, [id]);
        const fact = { tainted, migration: migrationFacts, resumed, answerMatches, callsBeforeQuery: beforeCalls, callsAfterQuery: calls.length,
          blockedAfterQuery: service.store.blocked(), oldSessionState: state.state, nativeRefPreserved: state.agent_ref_json === legacyRef,
          originalOutboxUnknown: service.store.db.prepare("SELECT count(*) n FROM outbox WHERE task_id=? AND state<>'unknown'").get(clippedId)!.n === 0,
          rawExact: raw === sha256(query) && bridge?.textSha256 === raw && (tainted ? !business : business?.textSha256 === raw),
          disclosure, replay, fixtureOnly: c.codex.home !== base.codex.home && !c.codex.networkAccess && c.codex.sandbox === 'read-only' };
        fixture.save('migration-branch.json', fact);
        const native = await migrationNativeAudits(service.store, c), baseline = await migrationBaseline(service.store, directory, native);
        const remote = remoteWriteEvidence(service.store, [id], native, undefined, undefined, baseline); fixture.save('remote-write-audit.json', remote);
        branches.push({ ...fact, remote });
      } finally { try { await fixture.close(); } catch (error) { cleanupConfirmed = false; failure = errorCode(error, 'LIVE_CLEANUP_FAILED'); } }
      if (!cleanupConfirmed) break;
    }
  } catch (error) { failure = errorCode(error, 'LIVE_CASE_FAILED'); }
  finally {
    if (CodexBackend.prototype.run === counted) CodexBackend.prototype.run = originalRun;
    else { cleanupConfirmed = false; failure = 'LIVE_METER_RESTORE_CONFLICT'; }
    isolated.close();
  }
  const observations: Record<string, { pass: boolean; actual: unknown }> = {};
  if (branches.length === 2) {
    const migrations = branches.map(row => row.migration as Record<string, unknown>);
    observations.migrationPreservesIdentity = { pass: migrations.every(row => row.beforeSha256 === row.afterSha256) && branches.every(row => row.originalOutboxUnknown), actual: migrations };
    observations.legacyHonesty = { pass: migrations.every(row => (row.marker as { completeness: string; originalArchived: boolean }).completeness === 'legacy-truncated' &&
      !(row.marker as { originalArchived: boolean }).originalArchived && row.oldFullArtifacts === 0), actual: migrations.map(row => ({ marker: row.marker, fullArtifacts: row.oldFullArtifacts })) };
    observations.sameNativeSession = { pass: branches[0]!.resumed === true && branches[0]!.answerMatches === true, actual: branches[0] };
    observations.taintPreserved = { pass: branches[1]!.blockedAfterQuery === true && branches[1]!.oldSessionState === 'tainted' && branches[1]!.nativeRefPreserved === true &&
      branches[1]!.callsBeforeQuery === branches[1]!.callsAfterQuery, actual: branches[1] };
    observations.noMigrationReplay = { pass: migrations.every(row => row.callsBefore === row.callsAfter), actual: migrations };
    observations.rawQueryMatchesSourceRequest = { pass: branches.every(row => row.rawExact), actual: branches };
    observations.permissionScopeValid = { pass: branches.every(row => row.fixtureOnly), actual: { fixtureOnly: true, notOsIsolation: true } };
    const disclosures = branches.map(row => row.disclosure as ReturnType<typeof bridgeDisclosure>);
    if (disclosures.every(row => row.complete)) observations.noBridgeRawAnswerDisclosure = { pass: disclosures.every(row => row.pass), actual: disclosures };
    const replay = branches[0]!.replay as ReturnType<typeof replayEvidence>;
    if (replay.complete) observations.noBusinessReplayAfterUncertain = { pass: replay.pass && observations.noMigrationReplay.pass && observations.taintPreserved.pass, actual: { replay, calls } };
    const remotes = branches.map(branch => branch.remote as ReturnType<typeof remoteWriteEvidence>);
    if (remotes.every(remote => remote.complete)) observations.noProductionRemoteWrites = { pass: remotes.every(remote => remote.pass), actual: remotes.map(remote => remote.actual) };
  }
  for (const name of ['migration-diff.json', 'backup-manifest.json', 'resume-trace.json', 'legacy-artifact-status.json', 'observations.json'])
    writeFileSync(path.join(output, name), JSON.stringify(name === 'observations.json' ? observations : { branches, calls }, null, 2), { mode: 0o600 });
  const assertions: AssertionResult[] = [...test.assertions, ...globals.map(predicate => ({ id: test.id + '-GLOBAL-' + predicate, predicate, expected: 'true' }))].map(a => {
    const observed = observations[a.predicate]; return observed ? { ...a, status: observed.pass ? 'PASS' : 'FAIL', actual: observed.actual, evidence: ['observations.json'] }
      : { ...a, status: failure ? 'FAIL' : 'BLOCKED', reason: failure ?? 'PREDICATE_ORACLE_NOT_IMPLEMENTED' };
  });
  const result = finalizeCase(test, attempt, globals, assertions);
  return failure ? { ...result, status: 'FAIL', failureCode: failure, cleanupConfirmed } : { ...result, cleanupConfirmed };
}
