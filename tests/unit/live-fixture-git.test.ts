import test from 'node:test';
import assert from 'node:assert/strict';
import { fixtureGitConfig } from '../live/fixture-git.ts';

test('OFFLINE fixture Git policy refuses hook/config/transport overrides and accepts only the exact local remote', () => {
  const base = 'core.hookspath\n/dev/null\0commit.gpgsign\nfalse\0core.bare\nfalse\0user.name\nFixture\0';
  assert.equal(fixtureGitConfig(base), true);
  const remote = base + 'remote.origin.url\n/fixture/.fixture-origin\0remote.origin.fetch\n+refs/heads/*:refs/remotes/origin/*\0';
  assert.equal(fixtureGitConfig(remote, '/fixture/.fixture-origin'), true);
  for (const extra of ['core.hookspath\n/tmp/hooks\0', 'core.fsmonitor\ncommand\0', 'diff.external\ncommand\0', 'include.path\n/file\0',
    'url.https://example.com.insteadof\n/fixture\0', 'remote.origin.pushurl\nhttps://example.com\0', 'alias.push\n!command\0',
    'filter.fixture.clean\ncommand\0', 'commit.gpgsign\ntrue\0', 'core.sshcommand\ncommand\0']) assert.equal(fixtureGitConfig(base + extra), false, extra);
  assert.equal(fixtureGitConfig(remote, '/other'), false);
  assert.equal(fixtureGitConfig(base, '/fixture/.fixture-origin'), false);
  assert.equal(fixtureGitConfig(base.replace('core.hookspath\n/dev/null\0', '')), false);
});
