import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { agentEnvironment, type Config } from '../../src/config.ts';
import { sha256 } from '../../src/orchestration/requests.ts';

export interface FixtureGitEvidence { configSha256: string; head: string; remotes: string; bare?: { path: string; configSha256: string; head: string } }
/** Reject effective hooks, helpers, includes, URL rewriting and custom Git execution settings. */
export function fixtureGitConfig(text: string, barePath?: string): boolean {
  const fields = text.split('\0'); if (fields.pop() !== '') return false;
  let hooks = false, sign = false, remote = false;
  for (const field of fields) {
    const offset = field.indexOf('\n'); if (offset < 1) return false;
    const key = field.slice(0, offset), value = field.slice(offset + 1);
    if (key === 'core.hookspath' && value === '/dev/null') { hooks = true; continue; }
    if (key === 'commit.gpgsign' && value === 'false') { sign = true; continue; }
    if (['core.filemode', 'core.bare', 'core.logallrefupdates', 'core.ignorecase', 'core.precomposeunicode'].includes(key) && ['true', 'false'].includes(value)) continue;
    if (key === 'core.repositoryformatversion' && value === '0') continue;
    if (['user.name', 'user.email', 'init.defaultbranch'].includes(key) && value.length > 0 && value.length < 256 && !/[\r\n\0]/.test(value)) continue;
    if (key === 'credential.helper' && value === 'osxkeychain') continue; // Not used by local-path transport.
    if (barePath && key === 'remote.origin.url' && value === barePath && !remote) { remote = true; continue; }
    if (barePath && key === 'remote.origin.fetch' && value === '+refs/heads/*:refs/remotes/origin/*') continue;
    if (barePath && key === 'branch.fixture.remote' && value === 'origin') continue;
    if (barePath && key === 'branch.fixture.merge' && value === 'refs/heads/fixture') continue;
    return false;
  }
  return hooks && sign && (!!barePath === remote);
}
/** Current physical fixture evidence; callers also require a complete native action inventory. */
export function inspectFixtureGit(c: Config, cwd: string, needsRemote: boolean): FixtureGitEvidence | undefined {
  try {
    const root = path.dirname(path.dirname(cwd)), owner = JSON.parse(readFileSync(path.join(root, 'fixture-owner.json'), 'utf8'));
    if (owner.synthetic !== true || owner.id !== path.basename(root) || path.basename(path.dirname(cwd)) !== 'projects') return;
    const physical = (file: string, directory: boolean) => {
      const stat = lstatSync(file); return !stat.isSymbolicLink() && (directory ? stat.isDirectory() : stat.isFile()) && realpathSync(file) === file;
    };
    if (![cwd, path.join(cwd, '.git')].every(file => physical(file, true)) || !physical(path.join(cwd, '.git/config'), false)) return;
    const env = { HOME: c.agent.env.HOME ?? homedir(), ...agentEnvironment(c) };
    const git = (directory: string, args: string[]) => execFileSync('git', ['-C', directory, ...args], { env, encoding: 'utf8', timeout: 30000,
      maxBuffer: 131072, stdio: ['ignore', 'pipe', 'pipe'] });
    const bare = path.join(cwd, '.fixture-origin'), remotes = git(cwd, ['remote', '-v']).trim();
    const remoteExpected = `origin\t${bare} (fetch)\norigin\t${bare} (push)`;
    if (remotes !== '' && remotes !== remoteExpected || needsRemote && remotes !== remoteExpected) return;
    const config = git(cwd, ['config', '--null', '--list']);
    if (!fixtureGitConfig(config, remotes ? bare : undefined)) return;
    const result: FixtureGitEvidence = { configSha256: sha256(config), head: git(cwd, ['rev-parse', 'HEAD']).trim(), remotes };
    if (remotes) {
      if (!physical(bare, true) || !physical(path.join(bare, 'config'), false)) return;
      const bareConfig = git(bare, ['config', '--null', '--list']);
      // Bare fixtures do not commit; disable signing only in the inspected representation.
      if (!fixtureGitConfig(bareConfig + 'commit.gpgsign\nfalse\0')) return;
      result.bare = { path: bare, configSha256: sha256(bareConfig), head: git(bare, ['rev-parse', 'refs/heads/fixture']).trim() };
    }
    return result;
  } catch { return; }
}
