import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import type { Store } from '../../src/store.ts';
import { readControlled } from '../../src/fsutil.ts';
import { invariant, record } from '../../src/errors.ts';
import { sha256 } from '../../src/orchestration/requests.ts';
import type { NativeInputAudit } from './native-context.ts';
import { inspectContextRecords, verifyPhysicalNativeEffects } from './native-context.ts';
import type { Config } from '../../src/config.ts';
import type { NormalizedInput, SessionRef } from '../../src/types.ts';
import { Catalog } from '../../src/routing/catalog.ts';
import { NativeCatalog, historyRevision } from '../../src/history/catalog.ts';
import { NativeReader } from '../../src/history/reader.ts';
import { nativeRoot } from '../../src/history/files.ts';

export interface MigrationBaseline { jobIds: readonly string[]; syntheticJobIds: readonly string[]; nativeJobId: string; snapshotSha256: string; normalizedLegacyInputSha256: string }
const jobColumns = 'task_id,request_hash,status,error_code,finished_at,kind,session_key,input_json';
const signature = (store: Store, ids: readonly string[]) => sha256(JSON.stringify(ids.map(id => {
  const job = store.get(id); return { job: store.db.prepare('SELECT ' + jobColumns + ' FROM jobs WHERE task_id=?').get(id),
    ref: store.session(job.session_key).agent_ref_json, version: store.db.prepare('SELECT hash_version FROM orchestration_requests WHERE job_task_id=?').get(id) };
})));
const verified = new WeakMap<object, { store: Store; signature: string }>();
export const verifiedMigrationBaseline = (store: Store, value: MigrationBaseline): boolean => {
  const proof = verified.get(value); return proof?.store === store && proof.signature === signature(store, value.jobIds);
};

/** Audit both the real legacy CLI setup and the v4 continuation; legacy model-profile hashes stay historical. */
export async function migrationNativeAudits(store: Store, c: Config): Promise<NativeInputAudit[]> {
  const jobs = store.db.prepare("SELECT j.task_id,r.conversation_scope FROM jobs j JOIN orchestration_requests r ON r.job_task_id=j.task_id WHERE j.kind='agent' AND j.status='succeeded' ORDER BY j.seq").all();
  const seen = new Set<string>(), result: NativeInputAudit[] = [];
  for (const row of jobs) {
    const job = store.get(row.task_id as string), input = JSON.parse(job.input_json) as NormalizedInput;
    invariant(input.routing, 'LIVE_MIGRATION_NATIVE_SETUP');
    const catalog = new Catalog(c), directory = catalog.validate(input.routing.directory), target = catalog.target(directory);
    const ref = JSON.parse(store.session(job.session_key).agent_ref_json!) as SessionRef, refHash = sha256(JSON.stringify(ref));
    if (seen.has(refHash)) continue; seen.add(refHash);
    const candidate = await new NativeCatalog(store, row.conversation_scope as string).locateExact(target, ref), evidence = await new NativeReader().inspect(target, candidate);
    invariant(!evidence.incomplete && !evidence.unknownEvents && evidence.activity === 'idle', 'LIVE_MIGRATION_NATIVE_UNVERIFIED');
    const bytes = await readControlled(nativeRoot(target), candidate.file, 4194304), audit = inspectContextRecords(bytes.toString('utf8'), 'unused-remote-audit-marker', directory.path);
    await verifyPhysicalNativeEffects(audit, c, directory.path);
    invariant(historyRevision(candidate.file) === candidate.sourceRevision, 'HISTORY_CHANGED');
    result.push({ ...audit, nativeRefHash: refHash, sourceRevision: candidate.sourceRevision, workspace: { id: directory.id, path: directory.path },
      runtimeProfile: { model: evidence.model, reasoning: evidence.reasoning } });
  }
  return result;
}

/** The actual v3 fixture snapshot, one observed native setup and explicitly synthetic legacy rows. */
export async function migrationBaseline(store: Store, evidenceRoot: string, native: NativeInputAudit[]): Promise<MigrationBaseline> {
  const facts = record(JSON.parse((await readControlled(evidenceRoot, path.join(evidenceRoot, 'migration-branch.json'), 131072)).toString('utf8')));
  const migration = record(facts.migration), before = record(migration.before), after = record(migration.after);
  invariant(migration.fixtureDisclosure === 'native session is real; truncated command result, cursor and interrupted state are synthetic legacy fixtures' &&
    sha256(JSON.stringify(before)) === migration.beforeSha256 && sha256(JSON.stringify(after)) === migration.afterSha256 &&
    JSON.stringify(before) === JSON.stringify(after) && migration.callsBefore === migration.callsAfter, 'LIVE_MIGRATION_BASELINE');
  const backup = record(migration.applied).backup; invariant(typeof backup === 'string', 'LIVE_MIGRATION_BACKUP');
  const file = path.join(backup, 'snapshot.sqlite'), bytes = await readControlled(evidenceRoot, file, 67108864);
  invariant(sha256(bytes) === migration.backupSha256, 'LIVE_MIGRATION_BACKUP');
  const db = new DatabaseSync(file, { readOnly: true });
  let rows: Array<Record<string, unknown>>;
  try {
    invariant(db.prepare('PRAGMA user_version').get()!.user_version === 3, 'LIVE_MIGRATION_BACKUP');
    rows = db.prepare('SELECT task_id,request_hash,status,error_code,finished_at FROM jobs ORDER BY seq').all();
    invariant(JSON.stringify(rows) === JSON.stringify(before.jobs) && [2, 3].includes(rows.length), 'LIVE_MIGRATION_BASELINE');
    for (const row of rows) {
      const current = store.db.prepare('SELECT task_id,request_hash,status,error_code,finished_at FROM jobs WHERE task_id=?').get(row.task_id as string);
      invariant(JSON.stringify(current) === JSON.stringify(row) && store.db.prepare('SELECT hash_version FROM orchestration_requests WHERE job_task_id=?').get(row.task_id as string)?.hash_version === 'legacy-v3', 'LIVE_MIGRATION_BASELINE_CHANGED');
      const original = db.prepare('SELECT ' + jobColumns + ' FROM jobs WHERE task_id=?').get(row.task_id as string)!;
      invariant(JSON.stringify(original) === JSON.stringify(store.db.prepare('SELECT ' + jobColumns + ' FROM jobs WHERE task_id=?').get(row.task_id as string)) &&
        db.prepare('SELECT agent_ref_json FROM sessions WHERE session_key=?').get(original.session_key as string)?.agent_ref_json === store.session(original.session_key as string).agent_ref_json,
      'LIVE_MIGRATION_BASELINE_CHANGED');
    }
  } finally { db.close(); }
  const jobs = rows.map(row => store.get(row.task_id as string)), actual = jobs.filter(job => job.kind === 'agent' && job.status === 'succeeded');
  invariant(actual.length === 1, 'LIVE_MIGRATION_NATIVE_SETUP');
  const job = actual[0]!, input = JSON.parse(job.input_json), ref = store.session(job.session_key).agent_ref_json;
  invariant(typeof input.text === 'string' && /^在本会话记住校验词 [0-9a-f-]{36}。只回复“已记住”，不要使用工具或修改文件。$/.test(input.text) && ref, 'LIVE_MIGRATION_NATIVE_SETUP');
  const inputHash = sha256(input.text);
  invariant(native.some(row => row.nativeRefHash === sha256(ref) && (row.execution.noToolExecution || row.execution.noRemoteActions === true) &&
    row.inputs.some(input => input.completed && input.textSha256 === inputHash)), 'LIVE_MIGRATION_NATIVE_EFFECTS');
  const synthetic = jobs.filter(row => row.task_id !== job.task_id);
  invariant(synthetic.filter(row => row.kind === 'command' && row.status === 'succeeded' && row.error_code === 'OUTPUT_TRUNCATED' && JSON.parse(row.input_json).text === '合成旧版裁剪结果记录').length === 1 &&
    synthetic.every(row => row.kind === 'command' || row.status === 'interrupted' && row.error_code === 'EXECUTION_INTERRUPTED' &&
      JSON.parse(row.input_json).text === '合成旧版中断状态；未调用业务模型'), 'LIVE_MIGRATION_SYNTHETIC_BASELINE');
  invariant(sha256(await readControlled(evidenceRoot, file, 67108864)) === migration.backupSha256, 'LIVE_MIGRATION_BACKUP_CHANGED');
  const proof = Object.freeze({ jobIds: Object.freeze(jobs.map(row => row.task_id)), syntheticJobIds: Object.freeze(synthetic.map(row => row.task_id)), nativeJobId: job.task_id,
    snapshotSha256: migration.backupSha256 as string, normalizedLegacyInputSha256: inputHash });
  verified.set(proof, { store, signature: signature(store, proof.jobIds) }); return proof;
}
