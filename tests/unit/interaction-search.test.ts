import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { setup, fixture } from '../helpers.ts';
import { normalize } from '../../src/local.ts';
import { initializeHierarchy } from '../../src/orchestration/schema.ts';
import { RequestStore, sha256 } from '../../src/orchestration/requests.ts';
import { ArtifactStore } from '../../src/answers/artifact-store.ts';
import { listInteractions } from '../../src/answers/projection.ts';

function searchFixture(t: Parameters<typeof setup>[0]) {
  const f = setup(t), store = f.store(); initializeHierarchy(store);
  const requests = new RequestStore(store), artifacts = new ArtifactStore(store, path.join(f.c.stateRoot, 'artifacts'));
  return { store, async add(query: string, short: string, directory = 'A', session = 'one') {
    const request = requests.accept(normalize({ ...fixture(query), session }, f.c, 'local:codex')).request;
    const answer = artifacts.stage(request.request_id, 'system'), raw = 'RAW_ONLY_CANARY_' + randomUUID();
    artifacts.capture(answer.answer_id, raw);
    await artifacts.publish(answer.answer_id, { backend: 'system', requestId: request.request_id, completed: true, phase: 'completed', outcome: 'succeeded' },
      () => requests.transition(request.request_id, request.conversation_scope, ['accepted'], 'completed'));
    const recapId = randomUUID();
    store.db.prepare(`INSERT INTO answer_recaps(recap_id,answer_id,source_sha256,source,model_profile_digest,prompt_version,version,state,short_text,created_at)
      VALUES (?,?,?,'llm-recap','offline','offline',1,'ready',?,?)`).run(recapId, answer.answer_id, sha256(raw), short, Date.now());
    store.db.prepare(`INSERT INTO interaction_records(request_id,conversation_scope,directory_identity,kind,producer_role,answer_id,recap_id,completed_at)
      VALUES (?,?,?,'control','system',?,?,?)`).run(request.request_id, request.conversation_scope, directory, answer.answer_id, recapId, Date.now());
    return { request, recapId, raw };
  } };
}
test('OFFLINE interaction search: Chinese phrases and short terms, directory/scope filters, pagination and literal FTS syntax', async t => {
  const f = searchFixture(t), first = await f.add('中文测试第一轮', 'release ready'), second = await f.add('中文测试第二轮', 'pending', 'B');
  await f.add('中文测试外部对话', 'foreign', 'A', 'foreign');
  const search = (query: string, options = {}) => listInteractions(f.store, first.request.conversation_scope, { searchQuery: query, ...options });
  assert.deepEqual(search('中文测试').map(row => row.requestId), [second.request.request_id, first.request.request_id]);
  assert.equal(search('测试').length, 2); assert.equal(search('RELEASE')[0]!.requestId, first.request.request_id);
  assert.equal(search('release ').length, 1); assert.equal(search(' release').length, 0);
  assert.deepEqual(search('中文测试', { directoryIdentity: 'A' }).map(row => row.requestId), [first.request.request_id]);
  const page = search('中文测试', { limit: 1 }); assert.equal(page[0]!.requestId, second.request.request_id);
  assert.deepEqual(search('中文测试', { beforeSeq: page[0]!.ingressSeq }).map(row => row.requestId), [first.request.request_id]);
  const literal = await f.add('literal OR "quoted" * % _', 'literal search');
  assert.deepEqual(search('OR "quoted" * % _').map(row => row.requestId), [literal.request.request_id]);
  assert.deepEqual(search('" OR "foreign'), []);
  assert.deepEqual(search(first.raw), []);
  for (const query of ['', '  ', 'x'.repeat(257), 'bad\0query', '\ud800']) assert.throws(() => search(query), /HISTORY_QUERY/);
});
test('OFFLINE interaction search: recap changes, failed recaps and result-delivery update index without copying originals', async t => {
  const f = searchFixture(t), row = await f.add('normal query', 'VISIBLE_SENTINEL');
  const search = (query: string) => listInteractions(f.store, row.request.conversation_scope, { searchQuery: query });
  assert.equal(search('VISIBLE_SENTINEL').length, 1);
  f.store.db.prepare("UPDATE answer_recaps SET state='failed' WHERE recap_id=?").run(row.recapId);
  assert.deepEqual(search('VISIBLE_SENTINEL'), []);
  f.store.db.prepare("UPDATE answer_recaps SET state='ready',short_text='UPDATED_SENTINEL' WHERE recap_id=?").run(row.recapId);
  assert.equal(search('UPDATED_SENTINEL').length, 1); assert.deepEqual(search('VISIBLE_SENTINEL'), []);
  f.store.db.prepare('UPDATE orchestration_requests SET route_snapshot_json=? WHERE request_id=?').run(JSON.stringify({ controlKind: 'result-delivery' }), row.request.request_id);
  assert.deepEqual(search('UPDATED_SENTINEL'), []);
  const indexed = f.store.db.prepare('SELECT query,short_text FROM interaction_search WHERE rowid=?').get(row.request.ingress_seq)!;
  assert.equal(indexed.short_text, ''); assert.equal(JSON.stringify(indexed).includes(row.raw), false);
  f.store.db.prepare('DELETE FROM interaction_records WHERE request_id=?').run(row.request.request_id);
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM interaction_search').get()!.n, 0);
});
test('OFFLINE interaction search: an existing v4 database gets an idempotent derived-index backfill', async t => {
  const f = searchFixture(t), row = await f.add('backfill query', 'backfill recap');
  for (const trigger of f.store.db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'interaction_search_%'").all())
    f.store.db.exec('DROP TRIGGER ' + trigger.name);
  f.store.db.exec('DROP TABLE interaction_search; DROP VIEW interaction_search_projection;');
  const coreBefore = f.store.db.prepare('SELECT * FROM orchestration_requests').all();
  initializeHierarchy(f.store); initializeHierarchy(f.store);
  assert.deepEqual(f.store.db.prepare('SELECT * FROM orchestration_requests').all(), coreBefore);
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM interaction_search').get()!.n, 1);
  assert.equal(listInteractions(f.store, row.request.conversation_scope, { searchQuery: 'backfill recap' })[0]!.requestId, row.request.request_id);
});
