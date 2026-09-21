import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { writeFileSync } from 'node:fs';
import { setup } from '../helpers.ts';
test('doctor offline is explicit; live readiness never invents authentication or vision evidence', t => { const h = setup(); t.after(h.cleanup); const file = path.join(h.root, 'config.json'); writeFileSync(file, JSON.stringify(h.c)); const run = (args: string[]) => spawnSync(process.execPath, ['dist/src/cli.js', ...args, '--config', file], { encoding: 'utf8', timeout: 5000 }); const offline = run(['doctor', '--offline', '--json']); assert.equal(offline.status, 0, offline.stderr); const data = JSON.parse(offline.stdout); assert.equal(data.checks.wecomAuthenticated, 'unverified'); assert.equal(data.checks.imagesNative, 'unverified'); assert.equal(run(['doctor']).status, 2); assert.equal(run(['recover', '--ack-workspace', 'fixture']).status, 1); assert.equal(run(['status']).status, 0); });
test('live smoke scripts require explicit --live before opening connections or running a model', () => { for (const name of ['wecom', 'pi']) {
    const r = spawnSync(process.execPath, [`dist/scripts/smoke-${name}.js`], { encoding: 'utf8', timeout: 5000 });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /EXPLICIT_LIVE_FLAG_REQUIRED/);
} });
