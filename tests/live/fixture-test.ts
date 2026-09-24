import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { sha256 } from '../../src/orchestration/requests.ts';

/** Exact existing synthetic arithmetic test; this does not approve arbitrary package scripts. */
export function inspectFixtureTest(cwd: string): { scriptSha256: string; packageSha256: string } | undefined {
  try {
    const root = path.dirname(path.dirname(cwd)), owner = JSON.parse(readFileSync(path.join(root, 'fixture-owner.json'), 'utf8'));
    if (owner.synthetic !== true || owner.id !== path.basename(root) || path.basename(path.dirname(cwd)) !== 'projects') return;
    const contents = ['fixture.test.cjs', 'package.json'].map(name => {
      const file = path.join(cwd, name), stat = lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096 || realpathSync(file) !== file) throw Error('unverified fixture');
      return readFileSync(file, 'utf8');
    });
    const [script, json] = contents as [string, string];
    if (!/^const test=require\('node:test'\),assert=require\('node:assert\/strict'\);\ntest\('fixture arithmetic',\(\)=>\{assert.equal\(2\+2,4\);console.log\("TEST_RUN_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"\);\}\);\n$/.test(script)) return;
    if (json !== JSON.stringify({ name: 'synthetic-acceptance-fixture', private: true, scripts: { test: 'node --test fixture.test.cjs' } })) return;
    return { scriptSha256: sha256(script), packageSha256: sha256(json) };
  } catch { return; }
}
