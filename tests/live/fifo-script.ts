import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { sha256 } from '../../src/orchestration/requests.ts';
import type { AddedFile } from './patch-effects.ts';

export type FifoScript = 'first-task' | 'second-task';
export function fifoScriptSource(name: FifoScript, token: string): string {
  return '#!/usr/bin/env node\n' + `const fs=require('node:fs'); const path=require('node:path'); const root=__dirname;
const record={pid:process.pid,token:${JSON.stringify(token)},script:fs.realpathSync(__filename),at:Date.now()};
fs.writeFileSync(path.join(root,${JSON.stringify('.' + name + '-started')}),JSON.stringify(record),{flag:'wx',mode:0o600});
${name === 'first-task' ? `const end=Date.now()+120000;
const timer=setInterval(()=>{if(fs.existsSync(path.join(root,'.first-release'))){clearInterval(timer);process.stdout.write('first-task completed\\n');}
else if(Date.now()>end){clearInterval(timer);process.exitCode=2;}},100);` : "process.stdout.write('second-task completed\\n');"}
`;
}
/** Verify the reviewed fixture program and its bounded local outputs, not arbitrary Node code. */
export function inspectFifoScript(cwd: string, name: FifoScript): { name: FifoScript; scriptSha256: string; files: AddedFile[]; runnerFiles: AddedFile[] } | undefined {
  try {
    const root = path.dirname(path.dirname(cwd)), owner = JSON.parse(readFileSync(path.join(root, 'fixture-owner.json'), 'utf8'));
    if (owner.synthetic !== true || owner.id !== path.basename(root) || path.basename(path.dirname(cwd)) !== 'projects') return;
    const read = (name: string, limit: number) => {
      const file = path.join(cwd, name), stat = lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > limit || realpathSync(file) !== file) throw Error('unverified fixture');
      return readFileSync(file, 'utf8');
    };
    const source = read(name, 4096), token = source.match(/token:"([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})"/)?.[1];
    if (!token || source !== fifoScriptSource(name, token) || read('package.json', 4096) !== JSON.stringify({ private: true, type: 'commonjs' })) return;
    const markerName = '.' + name + '-started', bytes = read(markerName, 4096), marker = JSON.parse(bytes);
    if (Object.keys(marker).sort().join(',') !== 'at,pid,script,token' || marker.token !== token || marker.script !== path.join(cwd, name) ||
      !Number.isSafeInteger(marker.pid) || marker.pid < 2 || !Number.isSafeInteger(marker.at) || marker.at < 1) return;
    const runnerFiles: AddedFile[] = [];
    if (name === 'first-task' && existsSync(path.join(cwd, '.first-release'))) {
      const release = read('.first-release', 128); if (release !== token) return;
      runnerFiles.push({ path: path.join(cwd, '.first-release'), contentSha256: sha256(release) });
    }
    return { name, scriptSha256: sha256(source), files: [{ path: path.join(cwd, markerName), contentSha256: sha256(bytes) }], runnerFiles };
  } catch { return; }
}
