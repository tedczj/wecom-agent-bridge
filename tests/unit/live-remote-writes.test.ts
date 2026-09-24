import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { setup, fixture } from '../helpers.ts';
import { normalize } from '../../src/local.ts';
import { migrateV4 } from '../../src/migrations/v4.ts';
import { RequestStore, sha256 } from '../../src/orchestration/requests.ts';
import { ArtifactStore } from '../../src/answers/artifact-store.ts';
import { RecapService } from '../../src/answers/recap.ts';
import { remoteWriteEvidence } from '../live/remote-writes.ts';
import type { NativeInputAudit } from '../live/native-context.ts';

test('OFFLINE remote-write oracle: requires complete no-tool native evidence and both restricted management turns', async t => {
  const f = setup(t), store = f.store(); migrateV4(store);
  const incoming = normalize(fixture(), f.c, 'local:codex'), request = new RequestStore(store).accept(incoming).request;
  const id = request.request_id, { job } = store.reserve(incoming, 'agent', undefined, id);
  const requests = new RequestStore(store);
  requests.transition(id, request.conversation_scope, ['accepted'], 'bridge_planning');
  requests.transition(id, request.conversation_scope, ['bridge_planning'], 'route_planning');
  requests.bindJob(id, request.conversation_scope, id);
  store.prepared(job.task_id, []); store.claim();
  const ref = { kind: 'codex' as const, threadId: '00000000-0000-4000-8000-000000000001' }; store.persistSession(job.session_key, ref);
  const artifacts = new ArtifactStore(store, path.join(f.c.stateRoot, 'artifacts'));
  const answer = artifacts.stage(id, 'business', id, job.session_key); artifacts.capture(answer.answer_id, 'short');
  await artifacts.publish(answer.answer_id, { backend: 'codex', threadStarted: true, turnStarted: true, turnCompleted: true, exitCode: 0, cleanupConfirmed: true },
    () => { store.complete(id, 'succeeded', 'short'); });
  await new RecapService(store, artifacts, { summarize: async () => { throw Error('no model'); } }, 'profile').run(answer.answer_id, request.conversation_scope);
  const audit = [];
  for (const role of ['bridge', 'route'] as const) {
    const turn = { controllerId: role, threadId: role, turnId: role, policyVerified: true };
    store.put('controller-turn:' + role + ':' + id, turn);
    const tool = role === 'bridge' ? 'route_delegate' : 'business_execute';
    audit.push({ seq: audit.length + 1, role, controllerId: role, generation: 0, tool, callId: role, status: 'returned', argumentsSha256: 'args', resultSha256: 'result' });
    store.put('controller-tool-wire:' + role + ':' + id, [{ kind: 'tool-result', ...turn, requestId: id, role, callId: role, tool, resultSha256: 'result' }]);
  }
  store.put('tool-audit:' + id, audit);
  const native: NativeInputAudit = { nativeRefHash: sha256(JSON.stringify(ref)), sourceRevision: 'revision', fileSha256: 'file', noncePresent: false, inheritedContext: false,
    execution: { toolRecords: 0, unclassifiedRecords: 0, noToolExecution: true }, inputs: [{ turnId: 'native', textSha256: sha256(incoming.text), completed: true }] };
  const git = { fixture: { head: 'head', status: '', remotes: '' } };
  const check = () => remoteWriteEvidence(store, [id], [native], git, git);
  assert.equal(check().pass, true);
  assert.equal(remoteWriteEvidence(store, [id], [native], undefined, undefined).pass, true);
  assert.equal(remoteWriteEvidence(store, [id], [native], git, undefined).pass, false);
  const originalExecution = native.execution;
  native.workspace = { id: 'fixture', path: '/fixture' };
  native.execution = { ...originalExecution, noToolExecution: false, noRemoteActions: true, localPatchFilesVerified: true,
    localPatches: [{ callId: 'patch', turnId: 'native', mirrorId: 'change', files: [{ path: '/fixture/new.txt', contentSha256: 'content' }] }] };
  const added = { fixture: { ...git.fixture, status: '?? new.txt' } };
  assert.equal(remoteWriteEvidence(store, [id], [native], git, added).pass, true);
  assert.equal(remoteWriteEvidence(store, [id], [native], undefined, undefined).pass, false);
  assert.equal(remoteWriteEvidence(store, [id], [native], git, { fixture: { ...git.fixture, status: '?? other.txt' } }).pass, false);
  assert.equal(remoteWriteEvidence(store, [id], [native], git, { fixture: { ...git.fixture, status: ' M new.txt' } }).pass, false);
  native.execution.localPatchFilesVerified = false; assert.equal(remoteWriteEvidence(store, [id], [native], git, added).pass, false);
  const remotes = 'origin\t/fixture/.fixture-origin (fetch)\norigin\t/fixture/.fixture-origin (push)';
  const beforeCommit = { fixture: { ...git.fixture, remotes } }, afterCommit = { fixture: { head: 'next', status: '', remotes } };
  native.execution = { ...originalExecution, noToolExecution: false, noRemoteActions: true, fixtureGitVerified: true,
    fixtureGit: { configSha256: 'config', head: 'next', remotes, bare: { path: '/fixture/.fixture-origin', configSha256: 'bare', head: 'next' } },
    scopedCommands: [{ callId: 'git', turnId: 'native', commandSha256: 'cmd', mirrorId: 'exec', git: true, gitWrites: true, localPush: true }] };
  assert.equal(remoteWriteEvidence(store, [id], [native], beforeCommit, afterCommit).pass, true);
  assert.equal(remoteWriteEvidence(store, [id], [native], undefined, undefined).pass, false);
  native.execution.fixtureGit!.bare!.head = 'different'; assert.equal(remoteWriteEvidence(store, [id], [native], beforeCommit, afterCommit).pass, false);
  native.execution.fixtureGit!.bare!.head = 'next'; native.execution.fixtureGitVerified = false;
  assert.equal(remoteWriteEvidence(store, [id], [native], beforeCommit, afterCommit).pass, false);
  native.execution = originalExecution; delete native.workspace;
  native.nativeRefHash = 'foreign'; assert.equal(check().pass, false); native.nativeRefHash = sha256(JSON.stringify(ref));
  native.execution.noToolExecution = false; assert.equal(check().complete, false); native.execution.noToolExecution = true;
  native.inputs[0]!.completed = false; assert.equal(check().pass, false); native.inputs[0]!.completed = true;
  git.fixture.remotes = 'production'; assert.equal(check().pass, false); git.fixture.remotes = '';
  store.put('controller-turn:route:' + id, { controllerId: 'route', threadId: 'route', turnId: 'old', policyVerified: true });
  assert.equal(check().pass, false);
  store.put('controller-turn:route:' + id, null); assert.equal(check().complete, false);
  assert.equal(remoteWriteEvidence(store, [], [], git, git).pass, false);
});
test('OFFLINE remote-write oracle: a management-only history query needs its actual policy and prompt, not a fabricated business turn', async t => {
  const f = setup(t), store = f.store(); migrateV4(store);
  const incoming = normalize(fixture('list my recent history'), f.c, 'local:codex'), request = new RequestStore(store).accept(incoming).request;
  const id = request.request_id, { job } = store.reserve(incoming, 'command', undefined, id);
  store.db.prepare('UPDATE orchestration_requests SET job_task_id=? WHERE request_id=?').run(id, id);
  const artifacts = new ArtifactStore(store, path.join(f.c.stateRoot, 'artifacts'));
  const answer = artifacts.stage(id, 'bridge', id, job.session_key); artifacts.capture(answer.answer_id, 'no earlier history');
  await artifacts.publish(answer.answer_id, { backend: 'controller', threadId: 'thread', turnId: 'turn', completed: true, callbacksCompleted: true },
    () => { store.complete(id, 'succeeded', 'no earlier history'); });
  await new RecapService(store, artifacts, { summarize: async () => { throw Error('no recap model'); } }, 'profile').run(answer.answer_id, request.conversation_scope);
  const turn = { controllerId: 'controller', threadId: 'thread', turnId: 'turn', policyVerified: true };
  const policy = { kind: 'policy', role: 'bridge', ...turn, requestId: id, valid: true,
    evidence: { threadId: 'thread', turnId: 'turn', toolNames: ['list_interactions'], dynamicToolsOnly: true, nativeAutoCompaction: 'disabled' } };
  store.put('controller-turn:bridge:' + id, turn); store.put('controller-policy-wire:bridge:' + id, policy);
  store.put('controller-wire:bridge:' + id, { textSha256: sha256(incoming.text) });
  const git = { fixture: { head: 'head', status: '', remotes: '' } }, check = () => remoteWriteEvidence(store, [id], [], git, git);
  assert.equal(check().pass, true);
  store.put('business-wire:' + id, { textSha256: sha256(incoming.text) }); assert.equal(check().pass, false);
  store.db.prepare('DELETE FROM routing_state WHERE key=?').run('business-wire:' + id);
  store.put('controller-policy-wire:bridge:' + id, { ...policy, valid: false }); assert.equal(check().pass, false);
  store.put('controller-policy-wire:bridge:' + id, policy); store.put('controller-wire:bridge:' + id, { textSha256: 'changed' }); assert.equal(check().pass, false);
});

test('OFFLINE remote-write oracle: host controls require system completion and reject any model execution', async t => {
  const f = setup(t), store = f.store(); migrateV4(store);
  const incoming = normalize(fixture('/route fixture'), f.c, 'local:codex'), request = new RequestStore(store).accept(incoming).request;
  const id = request.request_id; store.reserve(incoming, 'command', undefined, id);
  store.db.prepare('UPDATE orchestration_requests SET job_task_id=? WHERE request_id=?').run(id, id);
  const artifacts = new ArtifactStore(store, path.join(f.c.stateRoot, 'artifacts')), answer = artifacts.stage(id, 'system', id, store.get(id).session_key);
  artifacts.capture(answer.answer_id, 'Selected fixture');
  await artifacts.publish(answer.answer_id, { backend: 'system', requestId: id, completed: true, phase: 'completed', outcome: 'succeeded' },
    () => { store.complete(id, 'succeeded', 'Selected fixture'); });
  await new RecapService(store, artifacts, { summarize: async () => { throw Error('no model'); } }, 'profile').run(answer.answer_id, request.conversation_scope);
  const git = { fixture: { head: 'head', status: '', remotes: '' } }, check = () => remoteWriteEvidence(store, [id], [], git, git);
  assert.equal(check().pass, true); assert.deepEqual(check().actual.hostControls, [id]);
  store.put('business-wire:' + id, { textSha256: sha256(incoming.text) }); assert.equal(check().pass, false);
  store.db.prepare('DELETE FROM routing_state WHERE key=?').run('business-wire:' + id);
  store.db.prepare('UPDATE orchestration_requests SET raw_query=?,raw_query_sha256=?,route_snapshot_json=? WHERE request_id=?')
    .run('/read 1', sha256('/read 1'), JSON.stringify({ controlKind: 'result-delivery' }), id);
  store.db.prepare('DELETE FROM answer_recaps WHERE answer_id=?').run(answer.answer_id);
  assert.equal(check().pass, true); assert.equal(check().actual.requests[0]!.directDelivery, true);
  store.put('recap-call:unexpected', { requestId: id }); assert.equal(check().pass, false);
  store.db.prepare('DELETE FROM routing_state WHERE key=?').run('recap-call:unexpected');
  store.db.prepare('UPDATE orchestration_requests SET raw_query=? WHERE request_id=?').run('/update', id); assert.equal(check().pass, false);
});

test('OFFLINE remote-write oracle: a verified host refusal is not a successful operation or a business execution', async t => {
  const f = setup(t), store = f.store(); migrateV4(store);
  const incoming = normalize(fixture('/resume 1'), f.c, 'local:codex'), request = new RequestStore(store).accept(incoming).request, id = request.request_id;
  const { job } = store.reserve(incoming, 'command', undefined, id); store.db.prepare('UPDATE orchestration_requests SET job_task_id=? WHERE request_id=?').run(id, id);
  const artifacts = new ArtifactStore(store, path.join(f.c.stateRoot, 'artifacts')), answer = artifacts.stage(id, 'system', id, job.session_key);
  artifacts.capture(answer.answer_id, 'Rejected HISTORY_SCOPE');
  await artifacts.publish(answer.answer_id, { backend: 'system', requestId: id, completed: true, phase: 'failed', outcome: 'failed', errorCode: 'HISTORY_SCOPE' },
    () => { store.complete(id, 'failed', 'Rejected', 'HISTORY_SCOPE'); });
  await new RecapService(store, artifacts, { summarize: async () => { throw Error('no model'); } }, 'profile').run(answer.answer_id, request.conversation_scope);
  const check = () => remoteWriteEvidence(store, [id], [], undefined, undefined);
  assert.equal(check().pass, true); assert.equal(store.get(id).status, 'failed'); assert.deepEqual(check().actual.refusedBeforeBusiness, [id]);
  store.put('business-prompt-admissions:' + id, [{ admitted: true }]); assert.equal(check().pass, false);
});
