import path from 'node:path';
import { isPythonRead } from './python-read.ts';
import { sha256 } from '../../src/orchestration/requests.ts';
import type { AddedFile } from './patch-effects.ts';
import type { FifoScript } from './fifo-script.ts';
import { shellCommands, type ShellCommand } from './shell-commands.ts';

export interface CommandEffects { command: string; git: boolean; gitWrites: boolean; localPush: boolean; fixtureTest?: boolean; files?: AddedFile[]; fifoScripts?: FifoScript[] }
const file = (value: string) => /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value) && !value.split('/').includes('..') && !path.isAbsolute(value) &&
  !value.split('/').some(part => ['.git', '.agents', '.codex', '.fixture-origin'].includes(part));
const readable = (value: string) => file(value) || /^\/Users\/[^/]+\/\.codex\/memories\/MEMORY\.md$/.test(value);
const markerRead = (value: string) => file(value) || ['.first-task-started', '.second-task-started', '.first-release', '.second-release'].includes(value);
/** Analyze the observed synthetic byte-check programs; never execute their source. */
function pythonRead(call: ShellCommand): boolean {
  const source = call.argv.length === 2 && call.argv[1] === '-' ? call.stdin : call.argv.length === 3 && call.argv[1] === '-c' && call.stdin === undefined ? call.argv[2] : undefined;
  return typeof source === 'string' && (source === 'import secrets; print(secrets.token_hex(16))' || isPythonRead(source));
}
/** Closed observed command grammar. Git effects require separate repository/config/remote evidence. */
export function commandEffects(args: unknown, cwd: string): CommandEffects | undefined {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return;
  const fields = args as Record<string, unknown>;
  for (const [key, value] of Object.entries(fields)) {
    if (key === 'cmd') { if (typeof value !== 'string') return; }
    else if (key === 'workdir') { if (value !== cwd) return; }
    else if (['max_output_tokens', 'yield_time_ms'].includes(key)) { if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > 30000) return; }
    else return;
  }
  if (typeof fields.cmd !== 'string') return;
  if (fields.cmd === "sed -n '1,200p' second-task && ls -la .first-task-started .first-release .second* 2>/dev/null")
    return { command: fields.cmd, git: false, gitWrites: false, localPush: false };
  const compared = fields.cmd.match(/^printf '%s' '([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})' > once\.txt && cmp -s once\.txt <\(printf '%s' '\1'\) && wc -c once\.txt$/);
  if (compared) return { command: fields.cmd, git: false, gitWrites: false, localPush: false,
    files: [{ path: path.join(cwd, 'once.txt'), contentSha256: sha256(compared[1]!) }] };
  const calls = shellCommands(fields.cmd); if (!calls?.length) return;
  const effects: CommandEffects = { command: fields.cmd, git: false, gitWrites: false, localPush: false };
  for (const call of calls) {
    const [program, ...a] = call.argv;
    if (call.stdout !== undefined) {
      if (call.stdin !== undefined || program !== 'printf' || a.length !== 2 || !['%s', '%s\\n'].includes(a[0]!) ||
        !['once.txt', 'feature-one.txt', 'feature-two.txt', 'pending-b.txt'].includes(call.stdout) ||
        !/^(?:ALPHA_|BETA_)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(a[1]!)) return;
      (effects.files ??= []).push({ path: path.join(cwd, call.stdout), contentSha256: sha256(a[1]! + (a[0] === '%s\\n' ? '\n' : '')) });
      continue;
    }
    if (program === 'python3') { if (!pythonRead(call)) return; continue; }
    if (call.stdin !== undefined) return;
    const fifoScript = program === 'node' && a.length === 1 ? a[0] : a.length === 0 && program?.startsWith('./') ? program.slice(2) : undefined;
    if (fifoScript === 'first-task' || fifoScript === 'second-task') { (effects.fifoScripts ??= []).push(fifoScript); continue; }
    if (program === 'git') {
      effects.git = true; const [op, ...rest] = a;
      if (op === 'status' && rest.every(x => ['--short', '--branch', '--porcelain', '--porcelain=v1', '--untracked-files=all', '-uall', '-sb'].includes(x))) continue;
      if (op === 'branch' && rest.length === 1 && ['-vv', '-avv', '--show-current'].includes(rest[0]!)) continue;
      if (op === 'remote' && ['[]', '["-v"]', '["get-url","origin"]'].includes(JSON.stringify(rest))) continue;
      if (op === 'config' && (rest.length === 1 && ['user.name', 'user.email'].includes(rest[0]!) || JSON.stringify(rest) === '["--local","--list"]')) continue;
      if (op === 'log' && rest.every(x => /^-[1-9]\d{0,2}$/.test(x) || ['--oneline', '--decorate', '--name-only', '--date=iso-strict', '--date=short'].includes(x) ||
        /^--(?:format=|pretty=format:)(?:[^%]*%(?:h|H|s|n|ad|aI|cI|cs))*[^%]*$/.test(x))) continue;
      if (op === 'rev-parse' && rest.length > 0 && rest.every(x => ['HEAD', 'origin/fixture', 'refs/remotes/origin/fixture', '--show-toplevel', '--short'].includes(x))) continue;
      if (op === 'ls-tree' && rest[0] === '-r' && rest.at(-1) === 'HEAD' && rest.slice(1, -1).every(value => ['--name-only', '-l'].includes(value))) continue;
      if (op === 'show' && ['["--stat","--oneline","HEAD"]', '["--format=fuller","--no-patch","HEAD"]', '["--stat","--format=fuller","HEAD"]'].includes(JSON.stringify(rest))) continue;
      if (op === 'show' && rest.length === 3 && rest[0] === '--format=' && rest[1] === '--name-only' && ['HEAD', 'HEAD~1'].includes(rest[2]!)) continue;
      if (op === 'show' && JSON.stringify(rest) === '["--format=%h %s","--stat","--oneline","HEAD"]') continue;
      if (op === 'count-objects' && JSON.stringify(rest) === '["-v"]') continue;
      if (op === 'cat-file' && JSON.stringify(rest) === '["-p","HEAD"]') continue;
      if (op === 'ls-files' && ['[]', '["-s"]', '["--stage"]', '["--others","--exclude-standard"]'].includes(JSON.stringify(rest))) continue;
      if (op === 'diff' && rest.every((x, i) => ['--cached', '--check', '--stat', '--name-status', '--name-only', '--exit-code', '--'].includes(x) || rest.slice(0, i).includes('--') && file(x))) continue;
      if (op === 'diff' && rest[0] === '--no-index') {
        const files = rest[1] === '--' ? rest.slice(2) : rest.slice(1);
        if (files.length === 2 && files[0] === '/dev/null' && file(files[1]!)) continue;
      }
      if (op === 'add' && rest[0] === '--' && rest.length > 1 && rest.slice(1).every(file)) { effects.gitWrites = true; continue; }
      if (op === 'commit' && rest.length === 2 && rest[0] === '-m' && /^[A-Za-z0-9 ._-]{1,200}$/.test(rest[1]!)) { effects.gitWrites = true; continue; }
      if (op === 'push' && ['["origin","fixture"]', '["-u","origin","fixture"]'].includes(JSON.stringify(rest))) { effects.gitWrites = true; effects.localPush = true; continue; }
      if (op === 'ls-remote' && ['["origin","refs/heads/fixture"]', '["--heads","origin","fixture"]'].includes(JSON.stringify(rest))) { effects.localPush = true; continue; }
      return;
    }
    if (program === 'rg') {
      if (a[0] === '--files') {
        let i = ['-uu', '-uuu'].includes(a[1]!) ? 2 : 1;
        while (a[i] === '-g' && a[i + 1] && !a[i + 1]!.startsWith('-')) i += 2;
        if (a.slice(i).every(value => ['.', '..'].includes(value))) continue;
      }
      let i = 0;
      while (i < a.length && ['-n', '-i', '-m'].includes(a[i]!)) {
        if (a[i++] === '-m') { if (!/^[1-9]\d{0,3}$/.test(a[i++] ?? '')) return; }
      }
      if (i > 0 && a[i] && !a[i]!.startsWith('-') && a.length > i + 1) {
        let valid = true, paths = 0;
        for (let j = i + 1; j < a.length; j++) {
          if (['--glob', '-g'].includes(a[j]!)) { if (!a[++j] || a[j]!.startsWith('-')) valid = false; }
          else if (['.', '..'].includes(a[j]!) || readable(a[j]!)) paths++;
          else valid = false;
        }
        if (valid && paths > 0) continue;
      }
      return;
    }
    if (program === 'sed' && [2, 3].includes(a.length) && a[0] === '-n' && /^\d+(,\d+)?p$/.test(a[1]!) && (a.length === 2 || readable(a[2]!))) continue;
    if (program === 'find' && ['["..","-name","AGENTS.md","-print"]', '[".","-name","AGENTS.md","-print"]', '[".","-maxdepth","2","-type","f"]',
      '[".","-maxdepth","2","-type","f","-print"]', '[".","-maxdepth","3","-type","f","-print"]'].includes(JSON.stringify(a))) continue;
    if (program === 'find' && (['[".","-maxdepth","2","-type","d","-print"]', '[".","-maxdepth","3","-type","d","-print"]',
      '[".","-maxdepth","1","-type","l","-print"]', '[".","-maxdepth","1","-type","f","-print"]', '[".","-maxdepth","2","-type","d"]',
      '[".","-path","./.git","-prune","-o","-type","f","-print"]', '[".","-path","./.git","-prune","-o","-type","l","-print"]'].includes(JSON.stringify(a)))) continue;
    if (['head', 'tail'].includes(program!) && (a.length === 1 && /^-\d{1,3}$/.test(a[0]!) || a.length === 3 && a[0] === '-n' && /^\d{1,3}$/.test(a[1]!) && readable(a[2]!))) continue;
    if (program === 'test' && a.length === 2 && a[0] === '-e' && file(a[1]!)) continue;
    if (program === 'test' && a.length === 3 && a[0] === '!' && a[1] === '-e' && file(a[2]!)) continue;
    if (program === '[' && a.length === 3 && a[0] === '-e' && file(a[1]!) && a[2] === ']') continue;
    if (program === 'ls' && (a.length === 0 || ['-l', '-la'].includes(a[0]!) && a.slice(1).every(markerRead))) continue;
    if (program === 'wc' && a.length > 0 && a.every(x => ['-l', '-c', '-m', '-lc'].includes(x) || file(x))) continue;
    if (program === 'cat' && a.length > 0 && a.every(markerRead)) continue;
    if (program === 'file' && a.length > 0 && a.every(file)) continue;
    if (program === 'nl' && a.length === 2 && a[0] === '-ba' && readable(a[1]!)) continue;
    if (program === 'pwd' && a.length === 0) continue;
    if (program === 'openssl' && a.length === 3 && a[0] === 'rand' && a[1] === '-hex' && ['16', '32', '48', '64'].includes(a[2]!)) continue;
    if (program === 'shasum' && a.length >= 3 && a[0] === '-a' && a[1] === '256' && a.slice(2).every(file)) continue;
    if (program === 'od' && a.length === 3 && a[0] === '-An' && a[1] === '-tx1' && file(a[2]!)) continue;
    if (program === 'du' && a.length > 1 && ['-sh', '-ah'].includes(a[0]!) && a.slice(1).every(value => ['.', '.git'].includes(value) || file(value))) continue;
    if (program === 'sort' && JSON.stringify(a) === '["-h"]') continue;
    if (['node', 'npm'].includes(program!) && JSON.stringify(a) === '["--version"]') continue;
    if (program === 'npm' && JSON.stringify(a) === '["test"]' || program === 'node' && JSON.stringify(a) === '["--test","fixture.test.cjs"]') { effects.fixtureTest = true; continue; }
    if (program === 'printf' && a.length > 0 && !a[0]!.startsWith('-') && !a[0]!.includes('%n') && a.slice(1).every(file)) continue;
    return;
  }
  return effects;
}
