import test from 'node:test';
import assert from 'node:assert/strict';
import { extractCodeCalls, codeSyntaxRejected } from '../live/code-mode-calls.ts';
import { inspectContextRecords } from '../live/native-context.ts';

test('OFFLINE syntax rejection needs invalid JavaScript and the native empty pre-execution error', () => {
  const output = [{ type: 'input_text', text: 'Script failed\nWall time 0.0 seconds\nOutput:\n' }, { type: 'input_text', text: 'Script error:\nSyntaxError: missing ) after argument list' }];
  assert.equal(codeSyntaxRejected('text(JSON.stringify({x:1});', output), true);
  assert.equal(codeSyntaxRejected('throw new SyntaxError("missing ) after argument list")', output), false);
  assert.equal(codeSyntaxRejected('text(JSON.stringify({x:1});', [{ ...output[0], text: output[0]!.text + 'executed' }, output[1]]), false);
  assert.equal(codeSyntaxRejected('text(JSON.stringify({x:1});', 'SyntaxError'), false);
});

test('OFFLINE code-mode extraction handles literal calls and parallel result printing without executing code', () => {
  const calls = extractCodeCalls(`const r = await Promise.allSettled([
    tools.exec_command({cmd:"git status --short",max_output_tokens:1000}),
    tools.exec_command({cmd:"cat README.md",workdir:"/fixture"})]); for(const x of r) text(x);
    text(await tools.apply_patch("*** Begin Patch\\n*** End Patch"));`)!;
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [
    { tool: 'exec_command', arguments: { cmd: 'git status --short', max_output_tokens: 1000 } },
    { tool: 'exec_command', arguments: { cmd: 'cat README.md', workdir: '/fixture' } },
    { tool: 'apply_patch', arguments: '*** Begin Patch\n*** End Patch' },
  ]);
  assert.equal(extractCodeCalls('const r=await tools.exec_command({cmd:"pwd"});text(r.output);')?.length, 1);
});
test('OFFLINE code-mode inventory stores hashes only and does not promote extracted commands to remote safety', () => {
  const source = 'text(await tools.exec_command({cmd:"PRIVATE_COMMAND"}));';
  const audit = inspectContextRecords([
    { type: 'session_meta', payload: {} }, { type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn' } },
    { type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: 'call', input: source } },
    { type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'call', output: 'done' } },
    { type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn' } },
  ].map(row => JSON.stringify(row)).join('\n') + '\n', 'nonce');
  assert.equal(audit.codeCalls?.[0]?.parsed, true); assert.equal(audit.codeCalls?.[0]?.actions?.[0]?.tool, 'exec_command');
  assert.equal(JSON.stringify(audit).includes('PRIVATE_COMMAND'), false);
  assert.equal(audit.execution.noRemoteActions, false);
});
test('OFFLINE code-mode extraction handles observed display callbacks and fail-fast guards without accepting hidden calls', () => {
  assert.equal(extractCodeCalls('const r=await Promise.allSettled([tools.exec_command({cmd:"pwd"})]);r.forEach((x,i)=>text(JSON.stringify({i,result:x})));')?.length, 1);
  assert.equal(extractCodeCalls('const r=await Promise.allSettled([tools.exec_command({cmd:"pwd"})]);for(let i=0;i<r.length;i++)text(JSON.stringify({i,result:r[i]}));')?.length, 1);
  assert.equal(extractCodeCalls('const r=await Promise.allSettled([tools.exec_command({cmd:"pwd"})]);for(const x of r)text(x.status === "fulfilled" ? x.value.output : String(x.reason));')?.length, 1);
  assert.equal(extractCodeCalls('const a=await tools.exec_command({cmd:"git add -- one"});text(JSON.stringify({step:"add",...a}));if(a.exit_code!==0)exit();text(await tools.exec_command({cmd:"git commit -m one"}));')?.length, 2);
  for (const source of [
    'const r=await Promise.all([tools.exec_command({cmd:"pwd"})]);r.forEach(x=>text(JSON.stringify({x:tools.exec_command({cmd:"hidden"})})));',
    'const a=await tools.exec_command({cmd:"pwd"});text(await tools.exec_command({...a}));',
    'const a=await tools.exec_command({cmd:"pwd"});if(a.exit_code!==0)fetch("remote");',
    'const JSON={};text(JSON.stringify("x"));',
    'const String={};text(String("x"));',
    'text(JSON.stringify({get x(){return fetch("remote")}}));',
    'const r=await Promise.all([tools.exec_command({cmd:"pwd"})]);for(let i=0;i<r.length;i++)text(await tools.exec_command({cmd:"hidden"}));',
    'const r=await Promise.all([tools.exec_command({cmd:"pwd"})]);const i=0;text(await tools.exec_command({cmd:r[i]}));',
  ]) assert.equal(extractCodeCalls(source), undefined, source);
});
test('OFFLINE code-mode extraction rejects dynamic arguments, hidden side effects and partial extraction', () => {
  for (const source of [
    'text(await fetch("https://example.com"));', 'text(await tools.exec_command({cmd:process.env.COMMAND}));',
    'const r=await tools.exec_command({cmd:"pwd"});await tools.exec_command({cmd:r.output});',
    'const r=await tools.exec_command({cmd:"pwd"});eval("side effect");',
    'const tools={};text(await tools.exec_command({cmd:"pwd"}));',
    'text(await tools.exec_command({get cmd(){return "pwd"}}));',
    'text(await tools.exec_command({...options,cmd:"pwd"}));',
    'text(await tools.exec_command({__proto__:{cmd:"pwd"}}));',
    'const r=await Promise.all([tools.exec_command({cmd:"pwd"})]);for(const x of r)text(await tools.exec_command({cmd:"pwd"}));',
    'if (true) text(await tools.exec_command({cmd:"pwd"}));',
  ]) assert.equal(extractCodeCalls(source), undefined, source);
  // A parsed call is not a safety verdict; downstream effect audit must reject unknown tools/commands.
  assert.equal(extractCodeCalls('text(await tools.unknown_remote_write({target:"production"}));')?.[0]?.tool, 'unknown_remote_write');
});
