import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { setup } from '../helpers.ts';
import { codexArgs } from '../../src/codex.ts';
import { workspacePermissionArgs } from '../../src/codex-permissions.ts';

test('OFFLINE workspace permission args: scoped Git metadata write does not expose parent paths or approvals', t => {
  const f = setup(t), git = path.join(f.workspace, '.git'); mkdirSync(git);
  f.c.codex.sandbox = 'workspace-write';
  const args = codexArgs(f.c, [], undefined, undefined, true), profile = args.find(arg => arg.startsWith('permissions='))!;
  assert.ok(profile.includes(`${JSON.stringify(git)}="write"`)); assert.ok(profile.includes(`${JSON.stringify(f.workspace)}="write"`));
  assert.ok(profile.includes('":project_roots"="read"')); assert.ok(profile.includes(`${JSON.stringify(path.join(f.workspace, '.codex'))}="read"`));
  assert.ok(profile.includes(`${JSON.stringify(path.join(f.workspace, '.agents'))}="read"`)); assert.ok(profile.includes('network={enabled=false}'));
  assert.ok(args.includes('approval_policy="never"')); assert.equal(args.includes('--sandbox'), false);
  assert.equal(args.some(arg => /danger-full-access|auto_review/.test(arg)), false);
  assert.ok(codexArgs(f.c, []).includes('--sandbox')); // Legacy invocation keeps its existing native sandbox semantics.
});
test('OFFLINE workspace permission args: missing, file and symlink Git metadata never get a write exception', t => {
  for (const kind of ['missing', 'file', 'symlink']) {
    const f = setup(t), git = path.join(f.workspace, '.git');
    if (kind === 'file') writeFileSync(git, 'gitdir: ../outside\n');
    if (kind === 'symlink') { const outside = path.join(f.root, 'outside'); mkdirSync(outside); symlinkSync(outside, git); }
    assert.ok(workspacePermissionArgs(f.c).at(-1)!.includes(`${JSON.stringify(git)}="read"`));
  }
});
