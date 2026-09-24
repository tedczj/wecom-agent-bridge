import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, symlinkSync } from 'node:fs';
import path from 'node:path';
import { setup } from '../helpers.ts';
import { candidateManifest } from '../live/candidate.ts';

test('OFFLINE live candidate: compiled code changes alter evidence identity; runtime secrets are excluded', t => {
  const f = setup(t);
  for (const directory of ['dist/src', 'dist/scripts', 'dist/tests/live']) mkdirSync(path.join(f.root, directory), { recursive: true });
  writeFileSync(path.join(f.root, 'package-lock.json'), '{}');
  const source = path.join(f.root, 'dist/src/app.js'); writeFileSync(source, 'export const version = 1;');
  const first = candidateManifest(f.root); assert.deepEqual(first, candidateManifest(f.root));
  writeFileSync(path.join(f.root, 'private-auth.json'), 'synthetic secret');
  assert.deepEqual(first, candidateManifest(f.root));
  writeFileSync(source, 'export const version = 2;'); assert.notEqual(first.sha256, candidateManifest(f.root).sha256);
  symlinkSync(source, path.join(f.root, 'dist/scripts/link.js'));
  assert.throws(() => candidateManifest(f.root), /LIVE_CANDIDATE_SYMLINK/);
});
