import test from 'node:test';
import assert from 'node:assert/strict';
import * as sqlite from 'node:sqlite';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { setup, fixture } from '../helpers.ts';
import { normalize } from '../../src/local.ts';
import { migrateV4 } from '../../src/migrations/v4.ts';
import { sha256 } from '../../src/orchestration/requests.ts';
import { migrationBaseline, verifiedMigrationBaseline } from '../live/migration-baseline.ts';
import type { NativeInputAudit } from '../live/native-context.ts';

test('OFFLINE migration baseline: real SQLite snapshot and immutable rows, with explicit native-record double and synthetic history', async t => {
  const { backup } = sqlite as unknown as { backup: (db: sqlite.DatabaseSync, destination: string) => Promise<number> };
  const f = setup(t), store = f.store(), text = '在本会话记住校验词 00000000-0000-0000-0000-000000000000。只回复“已记住”，不要使用工具或修改文件。';
  const job = store.reserve(normalize(fixture(text), f.c, 'local:codex'), 'agent').job;
  store.prepared(job.task_id, []); store.claim();
  const ref = { kind: 'codex' as const, threadId: '00000000-0000-0000-0000-000000000001' }; store.persistSession(job.session_key, ref); store.complete(job.task_id, 'succeeded', '已记住');
  const clipped = store.reserve(normalize(fixture('合成旧版裁剪结果记录'), f.c, 'local:codex'), 'command').job;
  store.complete(clipped.task_id, 'succeeded', 'x'.repeat(f.c.reply.maxResultBytes + 1)); assert.equal(store.get(clipped.task_id).error_code, 'OUTPUT_TRUNCATED');
  const evidence = path.join(f.root, 'evidence'); mkdirSync(evidence); const snapshot = path.join(evidence, 'snapshot.sqlite'); await backup(store.db, snapshot);
  const before = { jobs: store.db.prepare('SELECT task_id,request_hash,status,error_code,finished_at FROM jobs ORDER BY seq').all() };
  writeFileSync(path.join(evidence, 'migration-branch.json'), JSON.stringify({ migration: { before, after: before, beforeSha256: sha256(JSON.stringify(before)), afterSha256: sha256(JSON.stringify(before)),
    callsBefore: 1, callsAfter: 1, applied: { backup: evidence }, backupSha256: sha256(readFileSync(snapshot)),
    fixtureDisclosure: 'native session is real; truncated command result, cursor and interrupted state are synthetic legacy fixtures' } }));
  migrateV4(store);
  const native: NativeInputAudit = { nativeRefHash: sha256(JSON.stringify(ref)), fileSha256: 'OFFLINE-double', sourceRevision: 'OFFLINE-double', noncePresent: false, inheritedContext: false,
    execution: { toolRecords: 0, unclassifiedRecords: 0, noToolExecution: true }, inputs: [{ turnId: 'OFFLINE-double', textSha256: sha256(text), completed: true }] };
  const proof = await migrationBaseline(store, evidence, [native]); assert.equal(verifiedMigrationBaseline(store, proof), true);
  assert.equal(verifiedMigrationBaseline(store, { ...proof }), false); assert.deepEqual(proof.syntheticJobIds, [clipped.task_id]);
  assert.throws(() => (proof.jobIds as string[]).push('foreign'));
  await assert.rejects(migrationBaseline(store, evidence, [{ ...native, nativeRefHash: 'foreign' }]), /LIVE_MIGRATION_NATIVE_EFFECTS/);
  const input = store.get(job.task_id).input_json; store.db.prepare('UPDATE jobs SET input_json=? WHERE task_id=?').run('{}', job.task_id);
  assert.equal(verifiedMigrationBaseline(store, proof), false); await assert.rejects(migrationBaseline(store, evidence, [native]), /LIVE_MIGRATION_BASELINE_CHANGED/);
  store.db.prepare('UPDATE jobs SET input_json=? WHERE task_id=?').run(input, job.task_id);
  writeFileSync(snapshot, 'tampered'); await assert.rejects(migrationBaseline(store, evidence, [native]), /LIVE_MIGRATION_BACKUP/);
});
