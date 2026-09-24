import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { setup } from '../helpers.ts';
import { parseConfig } from '../../src/config.ts';
import { ControllerFactory, ControllerCapabilityError, binaryDigest, controllerConfigurationDigest } from '../../src/controllers/factory.ts';

test('OFFLINE production factory: missing, incomplete and changed capability evidence cannot enable management', async t => {
  const f = setup(t), example = JSON.parse(readFileSync('docs/plans/three-layer-agent-bridge/config.hierarchical.example.json', 'utf8'));
  const workRoot = path.join(f.c.stateRoot, 'controllers');
  example.orchestration.controllerRuntime = { ...example.orchestration.controllerRuntime, command: f.c.agent.command, home: f.c.codex.home, workRoot };
  example.orchestration.answers.root = path.join(f.c.stateRoot, 'artifacts');
  const c = parseConfig({ ...f.c, models: { daily: { model: 'gpt-6-sol', reasoning: 'medium', contextWindowTokens: 1000000 } }, orchestration: example.orchestration,
    routing: { roots: [{ id: 'all', path: f.root, profile: 'read' }], profiles: [{ id: 'read', version: '1' }],
      workspaces: [{ id: 'test', path: f.workspace, profile: 'read' }] } });
  await assert.rejects(ControllerFactory.open(c), /CONTROLLER_CAPABILITY_REQUIRED/);
  mkdirSync(workRoot, { mode: 0o700 });
  const model = c.models!.daily!, file = path.join(workRoot, 'runtime-lock.json');
  const proof = { capabilityReady: false, binarySha256: await binaryDigest(c.agent.command), model,
    configurationDigest: await controllerConfigurationDigest(c.codex.home, model), checks: {} };
  writeFileSync(file, JSON.stringify(proof), { mode: 0o600 });
  await assert.rejects(ControllerFactory.open(c), error => {
    assert.ok(error instanceof ControllerCapabilityError); assert.equal(error.code, 'CONTROLLER_CAPABILITY_INCOMPLETE');
    assert.ok(error.gaps.includes('capabilityReady') && error.gaps.includes('effectiveToolSurfaceVerified') && error.gaps.includes('nativeAutoCompactionDisabledVerified'));
    return true;
  });
  writeFileSync(file, JSON.stringify({ ...proof, capabilityReady: true }), { mode: 0o600 });
  await assert.rejects(ControllerFactory.open(c), /CONTROLLER_CAPABILITY_INCOMPLETE/);
  writeFileSync(path.join(c.codex.home, 'config.toml'), 'model = "changed"\n', { mode: 0o600 });
  await assert.rejects(ControllerFactory.open(c), error => {
    assert.ok(error instanceof ControllerCapabilityError); assert.equal(error.code, 'CONTROLLER_CAPABILITY_MISMATCH');
    assert.deepEqual(error.gaps, ['configurationDigest']); return true;
  });
  assert.equal(existsSync(path.join(workRoot, 'bridge')), false);
});
