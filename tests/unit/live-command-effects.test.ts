import test from 'node:test';
import assert from 'node:assert/strict';
import { commandEffects } from '../live/command-effects.ts';
import { sha256 } from '../../src/orchestration/requests.ts';

test('OFFLINE literal once-file effect records exact bytes and refuses arbitrary redirections', () => {
  const nonce = '00000000-0000-0000-0000-000000000000', cmd = `printf '%s\\n' '${nonce}' > once.txt && cat once.txt`;
  assert.deepEqual(commandEffects({ cmd }, '/fixture')?.files, [{ path: '/fixture/once.txt', contentSha256: sha256(nonce + '\n') }]);
  const compared = `printf '%s' '${nonce}' > once.txt && cmp -s once.txt <(printf '%s' '${nonce}') && wc -c once.txt`;
  assert.equal(commandEffects({ cmd: compared }, '/fixture')?.files?.[0]?.contentSha256, sha256(nonce));
  assert.equal(commandEffects({ cmd: compared.replace("<(printf '%s'", "<(curl '%s'") }, '/fixture'), undefined);
  assert.ok(commandEffects({ cmd: "pwd && if [ -e once.txt ]; then cat once.txt; else printf 'MISSING\\n'; fi" }, '/fixture'));
  const features = `printf '%s\\n' 'ALPHA_${nonce}' > feature-one.txt\nprintf '%s\\n' 'BETA_${nonce}' > feature-two.txt`;
  assert.equal(commandEffects({ cmd: features }, '/fixture')?.files?.length, 2);
  assert.equal(commandEffects({ cmd: features.replace('feature-one.txt', 'pathlib.py') }, '/fixture'), undefined);
  assert.equal(commandEffects({ cmd: 'git status > once.txt' }, '/fixture'), undefined);
  for (const changed of [cmd.replace('> once.txt', '>> once.txt'), cmd.replaceAll('once.txt', '../outside'), cmd + '; curl remote', cmd.replace(nonce, '$(curl remote)')])
    assert.equal(commandEffects({ cmd: changed }, '/fixture'), undefined);
});

test('OFFLINE command effects: bounded read commands and local Git operations require separate Git proof', () => {
  const audit = (cmd: string) => commandEffects({ cmd, max_output_tokens: 1000 }, '/fixture');
  assert.deepEqual(audit('git add -- feature-one.txt && git commit -m "Add one" && git push origin fixture'), {
    command: 'git add -- feature-one.txt && git commit -m "Add one" && git push origin fixture', git: true, gitWrites: true, localPush: true,
  });
  assert.equal(audit('git status --short && for f in feature-one.txt feature-two.txt; do if test -e "$f"; then ls -l "$f"; else printf "%s absent" "$f"; fi; done')?.gitWrites, false);
  assert.equal(audit("rg --files -g 'README*' | head -30")?.git, false);
  assert.ok(audit("rg -n -i 'first-task|first_task' . --glob '!target/**' --glob '!.git/**'"));
  assert.ok(audit('cat .first-task-started; ls -l .first-release; file first-task'));
  const listing = "sed -n '1,200p' second-task && ls -la .first-task-started .first-release .second* 2>/dev/null";
  assert.ok(audit(listing)); assert.equal(audit(listing.replace('/dev/null', '/tmp/log')), undefined);
  for (const cmd of ['git push https://example.com fixture', 'git -c alias.x=push x', 'git push --force origin fixture',
    'git config remote.origin.url /production', 'git diff --ext-diff', 'git log --format=%G?', 'git log --show-signature', 'git add -- ../file', 'git add -- .git/config',
    'git commit --amend -m msg', 'sed -n "1e curl example.com" README.md', 'find . -exec curl example.com ;',
    'printf -v variable x', 'rg --files -g --pre=curl', 'rg -n pattern . --glob --pre=curl', 'file -z first-task',
    'python3 -c "import os; os.system(\'curl remote\')"', 'curl example.com', 'cat /dev/tcp/host/443']) assert.equal(audit(cmd), undefined, cmd);
  assert.equal(commandEffects({ cmd: 'git status', shell: '/tmp/shell' }, '/fixture'), undefined);
  assert.equal(commandEffects({ cmd: 'git status', workdir: '/other' }, '/fixture'), undefined);
});

test('OFFLINE Python byte-check grammar accepts only the observed literal synthetic files', () => {
  const source = 'from pathlib import Path; expected={"feature-one.txt":b"ALPHA_00000000-0000-0000-0000-000000000000\\n","feature-two.txt":b"BETA_00000000-0000-0000-0000-000000000000\\n"}; [(print(name, "OK" if Path(name).read_bytes()==data else "MISMATCH")) for name,data in expected.items()]';
  const args = (value: string) => ({ cmd: "python3 -c '" + value + "'" });
  assert.equal(commandEffects(args(source), '/fixture')?.git, false);
  for (const changed of [source + '; import socket', source.replace('read_bytes', 'write_bytes'), source.replace('feature-one.txt', '../production')])
    assert.equal(commandEffects(args(changed), '/fixture'), undefined);
});
