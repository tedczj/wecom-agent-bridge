import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, symlinkSync, renameSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { setup, output } from '../helpers.ts';
import { parseConfig } from '../../src/config.ts';
import { parseRouting } from '../../src/routing/config.ts';
import { Catalog } from '../../src/routing/catalog.ts';
import { Directories } from '../../src/orchestration/directories.ts';
import { openService } from '../../src/main.ts';
import { initializeHierarchy } from '../../src/orchestration/schema.ts';

function catalogFixture(t: Parameters<typeof setup>[0]) {
  const h = setup(t), term = path.join(h.workspace, 'term4u'), outside = path.join(h.root, 'outside');
  mkdirSync(term); mkdirSync(outside);
  t.mock.method(os, 'homedir', () => h.root);
  h.c.routing = parseRouting({ roots: [{ id: 'all', path: h.root, profile: 'read' }],
    profiles: [{ id: 'read', version: '1' }], workspaces: [{ id: 'test', path: h.workspace, profile: 'read' },
      { id: 'term4u', path: term, aliases: ['终端'], profile: 'read' }] });
  const store = h.store(); initializeHierarchy(store);
  return { ...h, term, outside, store, catalog: new Catalog(h.c), directories: new Directories(h.c, store) };
}
test('BR-03/04: project name and alias resolve before any recursive history or metadata scan', async t => {
  const h = catalogFixture(t);
  h.catalog.metadata = async () => { throw Error('must not scan'); };
  for (const name of ['term4u', '终端']) {
    const found = await h.catalog.search(name);
    assert.equal(found.partial, false); assert.deepEqual(found.scan.matches.map(d => d.id), ['term4u']);
    assert.equal(h.directories.resolve('scope', name).path, h.term);
  }
});
test('BR-05: directory continuation survives a new authority instance and cannot cross conversations', async t => {
  const h = catalogFixture(t);
  for (let i = 0; i < 6; i++) mkdirSync(path.join(h.workspace, 'candidate-' + i));
  const first = await h.directories.search('one', 'candidate', 1); assert.equal(first.partial, true);
  const second = await new Directories(h.c, h.store).search('one', 'candidate', 1);
  assert.equal(second.scan.matches.length, 2);
  const foreign = await h.directories.search('two', 'candidate', 1); assert.equal(foreign.scan.matches.length, 1);
  let next = second, pages = 0;
  while (next.partial) { next = await h.directories.search('one', 'candidate', 1); assert(++pages < 20); }
  assert.equal(next.scan.matches.length, 6);
});
test('BR-04/21: ordinary discovery stays inside workspace; explicit external path retains authorization checks', async t => {
  const h = catalogFixture(t); mkdirSync(path.join(h.outside, 'external-secret'));
  const result = await h.catalog.search('external-secret'); assert.equal(result.partial, false); assert.equal(result.scan.matches.length, 0);
  assert.equal(h.directories.resolve('scope', h.outside).path, h.outside); // explicitly authorized root
  const unauthorized = path.dirname(h.root);
  assert.throws(() => h.directories.resolve('scope', unauthorized), /DIRECTORY_UNAUTHORIZED/);
  await assert.rejects(h.catalog.search('x', { queue: [{ path: h.outside, depth: 0 }], deferred: [], matches: [] }), /DIRECTORY_DISCOVERY_SCOPE/);
});
test('BR-08: private paths, symlinks, and physical replacements cannot bypass directory authority', t => {
  const h = catalogFixture(t), target = h.catalog.describe(h.term);
  const link = path.join(h.workspace, 'link'); symlinkSync(h.outside, link);
  assert.throws(() => h.catalog.describe(link), /DIRECTORY_SYMLINK/);
  assert.throws(() => h.catalog.describe(h.c.stateRoot), /DIRECTORY_PRIVATE/);
  renameSync(h.term, h.term + '-old'); mkdirSync(h.term);
  assert.throws(() => h.catalog.validate(target), /DIRECTORY_CHANGED/);
});
test('configuration: legacy interpreter rejected and missing hierarchy never falls back to a business backend', async t => {
  const h = setup(t);
  await assert.rejects(openService(h.c, output().stream), /HIERARCHICAL_CONFIG_REQUIRED/);
  assert.throws(() => parseRouting({ interpreter: {} }), /ROUTING_INTERPRETER_REMOVED/);
});
test('fallback directory: configuration must name a configured workspace and preserves its authority checks', t => {
  const h = catalogFixture(t), routing = h.c.routing!;
  assert.equal(parseRouting({ ...routing, fallbackWorkspace: 'term4u' }).fallbackWorkspace, 'term4u');
  assert.throws(() => parseRouting({ ...routing, fallbackWorkspace: 'missing' }), /ROUTING_FALLBACK_MISSING/);
  assert.throws(() => parseRouting({ ...routing, fallbackWorkspace: h.outside }), /ROUTING_CONFIG_ID/);
  h.c.routing = parseRouting({ ...routing, fallbackWorkspace: 'term4u', workspaces: routing.workspaces.map(w =>
    w.id === 'term4u' ? { ...w, path: h.c.stateRoot } : w) });
  assert.throws(() => new Catalog(h.c), /DIRECTORY_PRIVATE/);
});
test('model defaults: business, Bridge, Route and recap share Sol/high; window remains explicit', t => {
  const h = setup(t), example = JSON.parse(readFileSync('docs/plans/three-layer-agent-bridge/config.hierarchical.example.json', 'utf8'));
  delete example.orchestration.bridge.modelProfile; delete example.orchestration.business.defaultModelProfile; delete example.orchestration.answers.recapModelProfile;
  const c = parseConfig({ ...h.c, models: { daily: { contextWindowTokens: 828400 } }, orchestration: example.orchestration });
  assert.equal(c.codex.model, 'gpt-6-sol'); assert.equal(c.codex.reasoning, 'high');
  assert.deepEqual(c.models!.daily, { model: 'gpt-6-sol', reasoning: 'high', contextWindowTokens: 828400 });
  assert.equal(c.orchestration!.bridge.modelProfile, 'daily'); assert.equal(c.orchestration!.route.inheritModelFrom, 'bridge');
  assert.equal(c.orchestration!.business.defaultModelProfile, 'daily'); assert.equal(c.orchestration!.answers.recapModelProfile, 'daily');
  assert.throws(() => parseConfig({ ...h.c, models: { daily: {} } }), /CONFIG_NUMBER/);
});
