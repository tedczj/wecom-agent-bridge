import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, renameSync } from 'node:fs';
import path from 'node:path';
import { setup, fixture } from '../helpers.ts';
import { parseConfig } from '../../src/config.ts';
import { normalize } from '../../src/local.ts';
import { Store } from '../../src/store.ts';
import { migrateV4 } from '../../src/migrations/v4.ts';
import { RequestStore } from '../../src/orchestration/requests.ts';
import { Directories } from '../../src/orchestration/directories.ts';

function harness(t: Parameters<typeof setup>[0]) {
  const f = setup(t), outside = path.join(f.root, 'outside'); mkdirSync(outside);
  const c = parseConfig({ ...f.c, routing: { roots: [{ id: 'root', path: f.workspace, profile: 'read' }],
    profiles: [{ id: 'read', version: '1' }], workspaces: [{ id: 'test', path: f.workspace, profile: 'read', aliases: ['configured'] }] } });
  const store = new Store(path.join(c.stateRoot, 'bridge.sqlite'), c); migrateV4(store); f.cleanups.push(() => store.close());
  const requests = new RequestStore(store), directories = new Directories(c, store);
  const request = (text: string, conversation = 'default') => requests.accept(normalize(fixture(text, conversation), c, 'local:codex')).request;
  const propose = () => {
    const source = request('work in outside'); requests.transition(source.request_id, source.conversation_scope, ['accepted'], 'bridge_planning');
    const consent = directories.propose(source.conversation_scope, source.request_id, outside);
    requests.transition(source.request_id, source.conversation_scope, ['bridge_planning'], 'completed'); return { source, consent };
  };
  return { ...f, c, outside, store, requests, directories, request, propose };
}
test('OFFLINE directory consent: proposal grants nothing; explicit same-scope approval binds the untouched source once', t => {
  const h = harness(t), { source, consent } = h.propose();
  assert.throws(() => h.directories.resolve(source.conversation_scope, h.outside), /DIRECTORY_UNAUTHORIZED/);
  assert.match(consent.permissions, /read-only/);
  const foreign = h.request('/approve', 'another');
  assert.throws(() => h.directories.approve(foreign.conversation_scope, foreign.request_id), /AUTHORIZATION_EXPIRED/);
  const reply = h.request('/approve'), approved = h.directories.approve(reply.conversation_scope, reply.request_id);
  assert.equal(approved.sourceRequestId, source.request_id);
  assert.equal(h.requests.get(reply.request_id, reply.conversation_scope).raw_query, '/approve');
  assert.equal(h.requests.get(reply.request_id, reply.conversation_scope).source_request_id, source.request_id);
  assert.equal(h.directories.resolve(reply.conversation_scope, approved.directory.id).path, h.outside);
  assert.throws(() => h.directories.resolve(foreign.conversation_scope, h.outside), /DIRECTORY_UNAUTHORIZED/);
  assert.throws(() => h.directories.approve(reply.conversation_scope, reply.request_id), /AUTHORIZATION_EXPIRED/);
  assert.equal(h.store.db.prepare('SELECT count(*) n FROM jobs').get()!.n, 0);
});
test('OFFLINE directory consent: replaced directory and changed profile invalidate approval', t => {
  const h = harness(t), { source } = h.propose(), reply = h.request('/approve');
  renameSync(h.outside, h.outside + '-old'); mkdirSync(h.outside);
  assert.throws(() => h.directories.approve(reply.conversation_scope, reply.request_id), /DIRECTORY_CHANGED/);
  assert.equal(h.requests.get(reply.request_id, reply.conversation_scope).source_request_id, null);
  assert.throws(() => h.directories.propose(source.conversation_scope, source.request_id, h.c.codex.home), /AUTHORIZATION_REQUEST_STATE/);
});
test('OFFLINE aliases: scope, configured names and deletion tombstones remain authoritative', t => {
  const h = harness(t), source = h.request('call it demo'), target = h.directories.resolve(source.conversation_scope, 'test');
  h.directories.alias(source.conversation_scope, source.request_id, 'demo', target);
  assert.equal(h.directories.resolve(source.conversation_scope, 'demo').id, 'test');
  const other = h.request('demo', 'other'); assert.throws(() => h.directories.resolve(other.conversation_scope, 'demo'), /DIRECTORY_AMBIGUOUS/);
  assert.throws(() => h.directories.alias(other.conversation_scope, source.request_id, 'demo', target), /REQUEST_NOT_FOUND/);
  assert.throws(() => h.directories.alias(source.conversation_scope, source.request_id, 'configured', undefined), /ALIAS_CONFIGURED/);
  h.directories.alias(source.conversation_scope, source.request_id, 'demo', undefined);
  assert.throws(() => h.directories.resolve(source.conversation_scope, 'demo'), /DIRECTORY_AMBIGUOUS/);
  const child = path.join(h.workspace, 'child'); mkdirSync(child);
  const discovered = h.directories.catalog(source.conversation_scope).describe(child);
  h.directories.alias(source.conversation_scope, source.request_id, 'child alias', discovered);
  const reopened = new Directories(h.c, h.store);
  assert.equal(reopened.resolve(source.conversation_scope, 'child alias').path, child);
  assert.equal(reopened.resolve(source.conversation_scope, discovered.id).path, child);
});
