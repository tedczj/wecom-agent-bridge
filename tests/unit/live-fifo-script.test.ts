import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync, symlinkSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fifoScriptSource, inspectFifoScript } from '../live/fifo-script.ts';
import { commandEffects } from '../live/command-effects.ts';

test('OFFLINE FIFO script audit checks exact source/marker/runner-release bytes without executing the program', t => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'fifo-audit-'))), cwd = path.join(root, 'projects', 'term4u');
  t.after(() => rmSync(root, { recursive: true, force: true })); mkdirSync(cwd, { recursive: true });
  writeFileSync(path.join(root, 'fixture-owner.json'), JSON.stringify({ synthetic: true, id: path.basename(root) }));
  writeFileSync(path.join(cwd, 'package.json'), JSON.stringify({ private: true, type: 'commonjs' }));
  const token = '00000000-0000-0000-0000-000000000000', script = path.join(cwd, 'first-task'), source = fifoScriptSource('first-task', token);
  const marker = path.join(cwd, '.first-task-started');
  writeFileSync(script, source); writeFileSync(marker, JSON.stringify({ pid: 123, token, script, at: 1 }));
  writeFileSync(path.join(cwd, '.first-release'), token);
  assert.equal(inspectFifoScript(cwd, 'first-task')?.files.length, 1); assert.equal(inspectFifoScript(cwd, 'first-task')?.runnerFiles.length, 1);
  assert.deepEqual(commandEffects({ cmd: './first-task' }, cwd)?.fifoScripts, ['first-task']);
  assert.equal(commandEffects({ cmd: 'node first-task --eval malicious' }, cwd), undefined);
  writeFileSync(script, source + 'require("node:http");'); assert.equal(inspectFifoScript(cwd, 'first-task'), undefined);
  writeFileSync(script, source); writeFileSync(path.join(cwd, '.first-release'), 'foreign'); assert.equal(inspectFifoScript(cwd, 'first-task'), undefined);
  writeFileSync(path.join(cwd, '.first-release'), token); unlinkSync(marker); symlinkSync(script, marker); assert.equal(inspectFifoScript(cwd, 'first-task'), undefined);
});
