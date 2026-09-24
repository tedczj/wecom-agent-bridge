import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { invariant } from '../../src/errors.ts';
import { sha256 } from '../../src/orchestration/requests.ts';

/** Identify the compiled candidate even when the checkout has uncommitted changes. */
export function candidateManifest(root: string): { sha256: string; files: Record<string, string> } {
  const files: Record<string, string> = {};
  const visit = (relative: string) => {
    const file = path.join(root, relative), stat = lstatSync(file);
    invariant(!stat.isSymbolicLink(), 'LIVE_CANDIDATE_SYMLINK');
    if (stat.isDirectory()) for (const name of readdirSync(file).sort()) visit(path.join(relative, name));
    else if (relative.endsWith('.js') || relative === 'package-lock.json') {
      invariant(stat.isFile() && Object.keys(files).length < 10000, 'LIVE_CANDIDATE_LIMIT'); files[relative] = sha256(readFileSync(file));
    }
  };
  for (const directory of ['dist/src', 'dist/scripts', 'dist/tests/live', 'package-lock.json']) visit(directory);
  return { sha256: sha256(JSON.stringify(files)), files };
}
