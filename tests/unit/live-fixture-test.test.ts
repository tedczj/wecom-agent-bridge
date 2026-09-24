import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, unlinkSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { inspectFixtureTest } from '../live/fixture-test.ts';
import { commandEffects } from '../live/command-effects.ts';

test('OFFLINE fixture test audit accepts only the literal arithmetic script and package with no lifecycle hooks', t => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'fixture-test-'))), cwd = path.join(root, 'projects', 'term4u');
  t.after(() => rmSync(root, { recursive: true, force: true })); mkdirSync(cwd, { recursive: true });
  writeFileSync(path.join(root, 'fixture-owner.json'), JSON.stringify({ synthetic: true, id: path.basename(root) }));
  const file = path.join(cwd, 'fixture.test.cjs'), packageFile = path.join(cwd, 'package.json');
  const script = 'const test=require(\'node:test\'),assert=require(\'node:assert/strict\');\ntest(\'fixture arithmetic\',()=>{assert.equal(2+2,4);console.log("TEST_RUN_00000000-0000-0000-0000-000000000000");});\n';
  const pkg = { name: 'synthetic-acceptance-fixture', private: true, scripts: { test: 'node --test fixture.test.cjs' } };
  writeFileSync(file, script); writeFileSync(packageFile, JSON.stringify(pkg));
  assert.ok(inspectFixtureTest(cwd)); assert.equal(commandEffects({ cmd: 'npm test' }, cwd)?.fixtureTest, true);
  writeFileSync(file, script + 'require("node:http");'); assert.equal(inspectFixtureTest(cwd), undefined);
  writeFileSync(file, script); writeFileSync(packageFile, JSON.stringify({ ...pkg, scripts: { ...pkg.scripts, pretest: 'curl remote' } }));
  assert.equal(inspectFixtureTest(cwd), undefined);
  writeFileSync(packageFile, JSON.stringify(pkg)); unlinkSync(file); symlinkSync(packageFile, file); assert.equal(inspectFixtureTest(cwd), undefined);
});
