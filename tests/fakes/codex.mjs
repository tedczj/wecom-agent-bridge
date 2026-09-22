#!/usr/bin/env node
// OFFLINE TEST DOUBLE ONLY. It does not call a model and does not provide an OS sandbox.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
const args = process.argv.slice(2), mode = process.env.FAKE_MODE ?? 'normal';
const emit = value => process.stdout.write(JSON.stringify(value) + '\n');
if (args[0] === '--version') { console.log('codex-cli TEST-DOUBLE'); process.exit(0); }
if (args[0] !== 'exec' || !args.includes('--json') || !args.includes('approval_policy="never"') || args.at(-1) !== '-') process.exit(92);
const home = process.env.CODEX_HOME;
fs.mkdirSync(home, {recursive:true});
const resume = args.indexOf('resume');
let id = resume < 0 ? randomUUID() : args[resume+1];
if (mode === 'wrong-thread') id = randomUUID();
let chunks = [];
for await (const b of process.stdin) chunks.push(b);
const prompt = Buffer.concat(chunks).toString('utf8');
const images = args.flatMap((arg,i) => arg === '--image' ? [args[i+1]] : []);
const imageHashes = images.map(file => createHash('sha256').update(fs.readFileSync(file)).digest('hex'));
const sessionFile = path.join(home, id + '.json');
let history = [];
if (resume >= 0 && mode !== 'wrong-thread') {
  if (!fs.existsSync(sessionFile)) { emit({type:'error',message:'missing thread'}); process.exit(1); }
  history = JSON.parse(fs.readFileSync(sessionFile));
}
fs.writeFileSync(path.join(home, 'capture.json'), JSON.stringify({args,prompt,images,imageHashes,env:process.env,cwd:process.cwd()}));
if (mode === 'auth-error') { process.stderr.write('FAKE_SECRET_NEVER_LOG_ME'); emit({type:'error',message:'FAKE_SECRET_NEVER_LOG_ME'}); process.exit(1); }
if (mode === 'startup-hang') { setInterval(() => {}, 1000); }
else if (mode === 'malformed') { process.stdout.write('{bad\n'); }
else if (mode === 'oversized') { process.stdout.write('x'.repeat(1024*1024)); }
else if (mode === 'truncated') { process.stdout.write('{"type":"thread.started"'); }
else if (mode === 'truncated-late-exit') { process.stdout.end('{"type":"thread.started"'); setTimeout(() => {}, 150); }
else if (mode === 'bad-order') { emit({type:'turn.completed',usage:{}}); }
else {
  emit({type:'thread.started',thread_id:id});
  emit({type:'turn.started'});
  history.push(prompt); fs.writeFileSync(sessionFile, JSON.stringify(history));
  if (mode === 'hang' || mode === 'ignore-term' || mode === 'child') {
    const effect = path.join(process.cwd(), 'side-effect.txt');
    fs.writeFileSync(effect, 'started');
    setInterval(() => fs.appendFileSync(effect, '.'), 20);
    if (mode === 'ignore-term') process.on('SIGTERM', () => {});
    if (mode === 'child') {
      const kid = spawn(process.execPath, ['-e', `setInterval(()=>require('fs').appendFileSync(${JSON.stringify(effect)},'c'),20)`], {stdio:'ignore'});
      fs.writeFileSync(path.join(home,'child.pid'), String(kid.pid));
    }
  } else if (mode === 'ack-only') { /* exit without terminal event */ }
  else if (mode === 'fail') { emit({type:'turn.failed',error:{message:'FAKE_SECRET_NEVER_LOG_ME'}}); process.exitCode = 1; }
  else if(mode==='router') {
    const result={action:process.env.FAKE_ROUTER_ACTION??'list',query:process.env.FAKE_ROUTER_QUERY??'second',selector:null,alias:null,execute:null};
    emit({type:'item.completed',item:{id:'answer',type:'agent_message',text:JSON.stringify(result)}});
    emit({type:'turn.completed',usage:{input_tokens:1,output_tokens:1}});
  }
  else {
    emit({type:'item.completed',item:{id:'reasoning',type:'reasoning',text:'PRIVATE_CHAIN_NOT_A_RESULT'}});
    emit({type:'item.completed',item:{id:'tool',type:'command_execution',command:'FAKE_SECRET_NEVER_LOG_ME',aggregated_output:'TOOL_OUTPUT_NOT_A_RESULT',status:'completed',exit_code:0}});
    if (mode !== 'empty') {
      const text = mode === 'long' ? '中文🛰️'.repeat(10000) : JSON.stringify({reply:prompt,history,imageHashes});
      emit({type:'item.completed',item:{id:'answer',type:'agent_message',text}});
    }
    emit({type:'turn.completed',usage:{input_tokens:1,cached_input_tokens:0,output_tokens:1}});
    if (mode === 'exit-error') process.exitCode = 7;
    if (mode === 'late-exit') setTimeout(() => {}, 150);
    if (mode === 'duplicate-terminal') emit({type:'turn.completed',usage:{}});
  }
}
