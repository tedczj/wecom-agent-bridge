import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { setup } from '../helpers.ts';
import { JsonlProjection, type ProjectedRecord } from '../../src/history/jsonl-projection.ts';
import { NativeReader } from '../../src/history/reader.ts';
import { ResumeVerifier } from '../../src/history/verifier.ts';
import { historyRevision, type CandidateMetadata } from '../../src/history/catalog.ts';
import { NativeCatalog } from '../../src/history/catalog.ts';
import { migrateV4 } from '../../src/migrations/v4.ts';
import type { Target } from '../../src/routing/catalog.ts';

const line = (value: unknown) => JSON.stringify(value) + '\n';
function history(f: ReturnType<typeof setup>, extra = '') {
  const id = randomUUID(), root = path.join(f.c.codex.home, 'sessions'); mkdirSync(root);
  const file = path.join(root, id + '.jsonl'), at = new Date(Date.now() - 1000).toISOString();
  const raw = line({ payload: { cwd: f.workspace, id }, type: 'session_meta' }) +
    line({ type: 'turn_context', payload: { cwd: f.workspace, model: 'gpt-6-sol', effort: 'medium' } }) +
    line({ type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn' } }) + extra +
    line({ type: 'event_msg', timestamp: at, payload: { type: 'user_message', message: 'No-progress check: automation-looking text' } }) +
    line({ type: 'response_item', payload: { type: 'reasoning', content: 'hidden reasoning secret' } }) +
    line({ type: 'event_msg', timestamp: at, payload: { type: 'task_complete', turn_id: 'turn', last_agent_message: 'visible final' } });
  writeFileSync(file, raw);
  const target: Target = { config: { ...f.c, codex: { ...f.c.codex, model: 'gpt-6-sol', reasoning: 'medium' } }, digest: 'profile',
    directory: { id: 'test', path: f.workspace, identity: 'inode', profile: 'read', aliases: [], description: '' } };
  const candidate: CandidateMetadata = { ref: { kind: 'codex', threadId: id }, file, title: '', createdAt: null, updatedAt: null, lastCompletedAt: null, role: 'external', sourceRevision: historyRevision(file) };
  return { target, candidate, file, raw };
}
test('OFFLINE M5: streaming projection handles chunk boundaries, escapes, containers and exact small values', () => {
  const values = [ { a: [true, false, null, -1.2e3, {}, []], s: '😀 e\u0301\n\r\t"\\' }, JSON.parse('{"__proto__":null,"payload":{"output":"value"},"type":"response_item"}') ];
  const input = values.map(line).join(''), rows: ProjectedRecord[] = [];
  const parser = new JsonlProjection(row => rows.push(row));
  for (let i = 0; i < input.length; i += 3) parser.push(input.slice(i, i + 3));
  assert.deepEqual(rows.map(row => JSON.parse(JSON.stringify(row.value))), values);
  assert.deepEqual(parser.end(), { incomplete: false });
  for (const invalid of ['{"a":1,}', '{"a":01}', '{"a":truefalse}', '{"a":1,"a":2}', '{"a":"\\q"}', '{"a":[1,]}', '{"a":1}\n[]\n']) {
    assert.throws(() => new JsonlProjection(() => {}).push(invalid + '\n'), /HISTORY_FORMAT/);
  }
});
test('OFFLINE M5: 9 MiB tool string preceding type is omitted but subsequent metadata/completion still verifies', async t => {
  const f = setup(t), h = history(f, line({ payload: { output: 'x'.repeat(9 * 1024 * 1024), type: 'function_call_output' }, type: 'response_item' }));
  const reader = new NativeReader(), evidence = await reader.inspect(h.target, h.candidate);
  assert.equal(evidence.activity, 'idle'); assert.ok(evidence.lastCompletedAt);
  assert.ok(evidence.page.omittedKinds.includes('oversized-string'));
  assert.equal(evidence.page.messages.some(m => m.text.includes('hidden reasoning secret')), false);
  assert.equal(evidence.page.messages[0]!.purpose, 'unknown');
  assert.equal(evidence.page.messages.at(-1)!.text, 'visible final');
  const verifier = new ResumeVerifier(reader, { check: async () => 'idle' });
  assert.equal((await verifier.verify(h.target, h.candidate, 'profile')).sourceRevision, h.candidate.sourceRevision);
});
test('OFFLINE M5: discarded huge strings still validate bad escapes at their end', async t => {
  const f = setup(t), h = history(f, '{"payload":{"output":"' + 'x'.repeat(9 * 1024 * 1024) + '\\q","type":"function_call_output"},"type":"response_item"}\n');
  await assert.rejects(new NativeReader().readWindow(h.target, h.candidate), /HISTORY_FORMAT/);
});
test('OFFLINE M5: partial records, unknown critical events and writer uncertainty deny execution', async t => {
  const f = setup(t), h = history(f), reader = new NativeReader();
  const uncertain = new ResumeVerifier(reader, { check: async () => 'unknown' });
  await assert.rejects(uncertain.verify(h.target, h.candidate, 'profile'), /HISTORY_WRITER_UNVERIFIED/);
  appendFileSync(h.file, '{"payload":'); h.candidate.sourceRevision = historyRevision(h.file);
  assert.equal((await reader.inspect(h.target, h.candidate)).incomplete, true);
  const verifier = new ResumeVerifier(reader, { check: async () => 'idle' });
  await assert.rejects(verifier.verify(h.target, h.candidate, 'profile'), /HISTORY_UNVERIFIED/);
  writeFileSync(h.file, h.raw + line({ type: 'event_msg', payload: { type: 'future-execution-state' } })); h.candidate.sourceRevision = historyRevision(h.file);
  await assert.rejects(verifier.verify(h.target, h.candidate, 'profile'), /HISTORY_UNVERIFIED/);
});
test('OFFLINE M5: cursor and pre-dispatch revision/profile checks reject changed native history', async t => {
  const f = setup(t), h = history(f, Array.from({ length: 25 }, (_, i) => line({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'message-' + i }] } })).join(''));
  const reader = new NativeReader(), page = await reader.readWindow(h.target, h.candidate);
  assert.equal(page.messages.length, 10); assert.ok(page.nextCursor);
  const next = await reader.readWindow(h.target, h.candidate, page.nextCursor);
  assert.equal(next.messages[0]!.text, 'message-10');
  const verifier = new ResumeVerifier(reader, { check: async () => 'idle' }), check = await verifier.verify(h.target, h.candidate, 'profile');
  await assert.rejects(verifier.verify({ ...h.target, config: { ...h.target.config, codex: { ...h.target.config.codex, model: 'other' } } }, h.candidate, 'profile'), /HISTORY_PROFILE_MISMATCH/);
  appendFileSync(h.file, line({ type: 'event_msg', payload: { type: 'task_started' } }));
  await assert.rejects(verifier.revalidate(h.target, h.candidate, check), /HISTORY_CHANGED/);
  h.candidate.sourceRevision = historyRevision(h.file);
  await assert.rejects(reader.readWindow(h.target, h.candidate, page.nextCursor), /HISTORY_CURSOR/);
});
test('OFFLINE M5: Pi header/branch reading does not convert assistant timestamps into agent_settled evidence', async t => {
  const f = setup(t, 'pi'), store = f.store(); migrateV4(store);
  const id = randomUUID(), file = path.join(f.c.agent.sessionRoot, id + '.jsonl');
  writeFileSync(file, line({ type: 'session', version: 3, id, cwd: f.workspace, timestamp: new Date().toISOString() }) +
    line({ id: 'user', parentId: null, type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'question' }] } }) +
    line({ id: 'assistant', parentId: 'user', type: 'message', timestamp: new Date().toISOString(), message: { role: 'assistant', content: [{ type: 'text', text: 'answer' }] } }));
  const target: Target = { config: f.c, digest: 'pi-profile', directory: { id: 'test', path: f.workspace, identity: 'inode', profile: 'read', aliases: [], description: '' } };
  const catalog = new NativeCatalog(store, 'scope'), page = await catalog.listMetadata(target);
  assert.equal(page.entries.length, 1); assert.equal(page.entries[0]!.ref.kind, 'pi');
  const candidate = await catalog.locateExact(target, { kind: 'pi', sessionId: id, sessionFile: file, hasHistory: true });
  const reader = new NativeReader(), evidence = await reader.inspect(target, candidate);
  assert.deepEqual(evidence.page.messages.map(m => m.text), ['question', 'answer']);
  assert.equal(evidence.lastCompletedAt, null); assert.equal(evidence.activity, 'unknown');
  const verifier = new ResumeVerifier(reader, { check: async () => 'idle' });
  await assert.rejects(verifier.verify(target, candidate, 'pi-profile'), /PI_SETTLED_UNVERIFIED/);
  const proof = { nativeId: id, sourceRevision: candidate.sourceRevision, profileDigest: 'pi-profile', finish: { backend: 'pi' as const, agentSettled: true as const, idle: true as const, cleanupConfirmed: true as const } };
  assert.equal((await verifier.verify(target, candidate, 'pi-profile', undefined, proof)).sourceRevision, candidate.sourceRevision);
  await assert.rejects(verifier.verify(target, candidate, 'pi-profile', undefined, { ...proof, profileDigest: 'other' }), /PI_SETTLED_UNVERIFIED/);
});
test('OFFLINE M5: 0.155.1 settings, UI mirrors and world state preserve machine scope checks', async t => {
  const f = setup(t), h = history(f), id = h.candidate.ref.kind === 'codex' ? h.candidate.ref.threadId : '';
  const additions = line({ type: 'world_state', payload: { full: true, state: { agents_md: 'private instruction projection' } } }) +
    line({ type: 'token_usage_record', payload: { thread_id: id, usage: { total_tokens: 100 } } }) +
    line({ type: 'event_msg', payload: { type: 'item_completed', thread_id: id, turn_id: 'turn', item: { type: 'AgentMessage', content: [{ type: 'text', text: 'UI mirror is not another execution' }] } } }) +
    line({ type: 'event_msg', payload: { type: 'thread_settings_applied', thread_id: id, thread_settings: { cwd: f.workspace, model: 'gpt-6-sol', reasoning_effort: 'medium' } } });
  appendFileSync(h.file, additions); h.candidate.sourceRevision = historyRevision(h.file);
  const reader = new NativeReader(), evidence = await reader.inspect(h.target, h.candidate);
  assert.equal(evidence.unknownEvents, false);
  assert.equal(evidence.page.messages.some(message => message.text.includes('private instruction') || message.text.includes('UI mirror')), false);
  await new ResumeVerifier(reader, { check: async () => 'idle' }).verify(h.target, h.candidate, 'profile');
  appendFileSync(h.file, line({ type: 'event_msg', payload: { type: 'thread_settings_applied', thread_id: id, thread_settings: { cwd: f.root, model: 'gpt-6-sol', reasoning_effort: 'medium' } } }));
  h.candidate.sourceRevision = historyRevision(h.file);
  await assert.rejects(reader.inspect(h.target, h.candidate), /HISTORY_SCOPE/);
});
