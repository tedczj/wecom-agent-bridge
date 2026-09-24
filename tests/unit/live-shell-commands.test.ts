import test from 'node:test';
import assert from 'node:assert/strict';
import { shellCommands } from '../live/shell-commands.ts';

test('OFFLINE shell inventory: literal commands, both conditional branches, pipelines and bounded quoted loop values', () => {
  assert.deepEqual(shellCommands('git add -- one.txt && git commit -m "one"'), [{ argv: ['git', 'add', '--', 'one.txt'] }, { argv: ['git', 'commit', '-m', 'one'] }]);
  const calls = shellCommands('for f in one.txt two.txt; do if test -e "$f"; then cat "$f"; else echo missing; fi; done')!;
  assert.deepEqual(calls.map(call => call.argv), [['test', '-e', 'one.txt'], ['cat', 'one.txt'], ['echo', 'missing'], ['test', '-e', 'two.txt'], ['cat', 'two.txt'], ['echo', 'missing']]);
  assert.equal(shellCommands("rg --files -g 'README*' | head -30")?.length, 2);
  assert.deepEqual(shellCommands('ls -la missing.txt 2>&1'), [{ argv: ['ls', '-la', 'missing.txt'] }]);
  assert.deepEqual(shellCommands('rg -n "test\\(|assert\\." README.md'), [{ argv: ['rg', '-n', 'test\\(|assert\\.', 'README.md'] }]);
  assert.deepEqual(shellCommands('git status > file'), [{ argv: ['git', 'status'], stdout: 'file' }]);
  assert.deepEqual(shellCommands('git show --name-only HEAD~1'), [{ argv: ['git', 'show', '--name-only', 'HEAD~1'] }]);
});
test('OFFLINE shell inventory: quoted heredoc is captured as data, never interpreted as shell or Python', () => {
  const body = "from pathlib import Path\nprint(Path('one').read_text())\n";
  assert.deepEqual(shellCommands("python3 - <<'PY'\n" + body + 'PY\ngit status --short'), [{ argv: ['python3', '-'], stdin: body }, { argv: ['git', 'status', '--short'] }]);
});
test('OFFLINE shell inventory: dynamic substitution, redirection, background, functions and environment assignment stay unknown', () => {
  for (const source of ['echo $(curl example.com)', 'echo `curl example.com`', 'cat "$HOME/file"', 'git status >> file', 'git status &',
    'X=1 git status', 'echo x 2>file', 'echo x 2>&3', 'f(){ curl example.com; }; f', 'for f in one; do cat $f; done', 'for f; do cat "$f"; done', 'select f in one; do cat "$f"; done',
    'for f in one; do cat "$f[1]"; done', "python3 - <<PY\nprint('x')\nPY", 'cat *', 'cat ~', 'echo ${x:-default}'])
    assert.equal(shellCommands(source), undefined, source);
});
