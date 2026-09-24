import { existsSync, lstatSync, realpathSync } from 'node:fs';
import path from 'node:path';
import type { Config } from './config.ts';

/** A host-owned workspace profile; only an in-place physical .git directory gets the metadata exception. */
export function workspacePermissionArgs(c: Config): string[] {
  const cwd = c.workspace.path, git = path.join(cwd, '.git');
  const writableGit = existsSync(git) && lstatSync(git).isDirectory() && !lstatSync(git).isSymbolicLink() && realpathSync(git) === git;
  const entries: Array<[string, string]> = [[':project_roots', 'read'], [cwd, 'write'], [git, writableGit ? 'write' : 'read'],
    [path.join(cwd, '.codex'), 'read'], [path.join(cwd, '.agents'), 'read']];
  const filesystem = entries.map(([file, access]) => `${JSON.stringify(file)}=${JSON.stringify(access)}`).join(',');
  return ['--config', 'default_permissions="bridge_workspace"', '--config',
    `permissions={bridge_workspace={extends=":workspace",filesystem={${filesystem}},network={enabled=${c.codex.networkAccess}}}}`];
}
