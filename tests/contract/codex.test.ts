import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync,readFileSync,writeFileSync,mkdirSync,chmodSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { CodexBackend,codexArgs } from '../../src/codex.ts';
import { MediaStore } from '../../src/media.ts';
import type { RunHooks,SessionRef } from '../../src/types.ts';
import { setup,input,eventually } from '../helpers.ts';
function hooks() {
  const refs:SessionRef[]=[],events:string[]=[];
  const value:RunHooks={persistSession:async ref=>{refs.push(ref);},progress:e=>events.push(e.type)};
  return {value,refs,events};
}
test('C01/B02: actual exec child, final result, persistent thread and explicit resume',async t=>{
  const h=setup(t),b=new CodexBackend(h.c),first=hooks(),i=input();i.text='unique nonce 9d0b';
  const a=await b.run(i,undefined,first.value,new AbortController().signal);
  assert.equal(a.outcome,'success');assert.equal(first.refs.length,1);assert(a.sessionRef?.kind==='codex');
  const second=input();second.text='second turn';const out=await b.run(second,a.sessionRef,hooks().value,new AbortController().signal);
  assert.equal(out.outcome,'success');assert.deepEqual(out.sessionRef,a.sessionRef);
  assert.deepEqual(JSON.parse(out.finalText).history,['unique nonce 9d0b','second turn']);
  const capture=JSON.parse(readFileSync(path.join(h.c.codex.home,'capture.json'),'utf8'));
  assert(capture.args.includes('resume'));assert(!capture.args.includes('--last'));
  assert(!existsSync(path.join(h.c.stateRoot,'agent-process.json')));
});
test('C02/B01: real image bytes reach the exec child through --image',async t=>{
  const h=setup(t),source=path.join(h.root,'source.png');writeFileSync(source,await sharp({create:{width:7,height:5,channels:3,background:{r:240,g:0,b:0}}}).png().toBuffer());
  const media=new MediaStore(h.c),images=await media.prepare(randomUUID(),[{path:source,source:'message'}]);
  const result=await new CodexBackend(h.c,img=>media.read(img)).run(input(images),undefined,hooks().value,new AbortController().signal);
  assert.equal(result.outcome,'success');assert.deepEqual(JSON.parse(result.finalText).imageHashes,[images[0]!.sha256]);
  const args=codexArgs(h.c,images,{kind:'codex',threadId:randomUUID()});assert(args.indexOf('--image')>args.indexOf('resume'));
});
test('C03: stored-image tampering fails before process creation',async t=>{
  const h=setup(t),source=path.join(h.root,'source.png');writeFileSync(source,await sharp({create:{width:2,height:2,channels:3,background:{r:0,g:0,b:0}}}).png().toBuffer());
  const media=new MediaStore(h.c),images=await media.prepare(randomUUID(),[{path:source,source:'message'}]);writeFileSync(images[0]!.localPath,'tampered');
  const r=await new CodexBackend(h.c,img=>media.read(img)).run(input(images),undefined,hooks().value,new AbortController().signal);
  assert.equal(r.outcome,'failed');assert.equal(r.errorCode,'MEDIA_HASH');assert(!existsSync(path.join(h.c.codex.home,'capture.json')));
});
test('C04/B03: no saved reference creates a distinct thread',async t=>{
  const h=setup(t),b=new CodexBackend(h.c);
  const a=await b.run(input(),undefined,hooks().value,new AbortController().signal),z=await b.run(input(),undefined,hooks().value,new AbortController().signal);
  assert.notDeepEqual(a.sessionRef,z.sessionRef);assert.deepEqual(JSON.parse(z.finalText).history,['hello']);
});
test('C05: final event alone does not settle before the child exits',async t=>{
  const h=setup(t,'codex','late-exit'),begin=Date.now();
  const r=await new CodexBackend(h.c).run(input(),undefined,hooks().value,new AbortController().signal);
  assert.equal(r.outcome,'success');assert(Date.now()-begin>=140);
});
for(const [mode,code] of [
  ['ack-only','CODEX_INCOMPLETE_TURN'],['exit-error','CODEX_INCOMPLETE_TURN'],
  ['malformed','RPC_INVALID_JSON'],['truncated','RPC_TRUNCATED_FRAME'],
  ['bad-order','CODEX_EVENT_ORDER'],['duplicate-terminal','CODEX_EVENT_ORDER'],
] as const) test(`C06: ${mode} cannot be reported as successful`,async t=>{
  const h=setup(t,'codex',mode),r=await new CodexBackend(h.c).run(input(),undefined,hooks().value,new AbortController().signal);
  assert.equal(r.outcome,'interrupted');assert.equal(r.errorCode,code);
});
test('C07/P08: oversized output is bounded and the process is cleaned up',async t=>{
  const h=setup(t,'codex','oversized');h.c.agent.maxFrameBytes=256;
  const r=await new CodexBackend(h.c).run(input(),undefined,hooks().value,new AbortController().signal);
  assert.equal(r.outcome,'interrupted');assert.equal(r.errorCode,'RPC_FRAME_TOO_LARGE');
});
test('C08/B04/D08: failed turn and auth failure return codes, never raw error/secret',async t=>{
  for(const mode of ['fail','auth-error']) {
    const h=setup(t,'codex',mode),r=await new CodexBackend(h.c).run(input(),undefined,hooks().value,new AbortController().signal);
    assert.equal(r.outcome,'failed');assert.equal(r.errorCode,'CODEX_TURN_FAILED');assert(!JSON.stringify(r).includes('FAKE_SECRET'));
  }
});
test('C09/B04: empty final is a failure; reasoning/tool outputs are not answers',async t=>{
  const h=setup(t,'codex','empty'),r=await new CodexBackend(h.c).run(input(),undefined,hooks().value,new AbortController().signal);
  assert.equal(r.outcome,'failed');assert.equal(r.errorCode,'EMPTY_FINAL');assert(!r.finalText.includes('PRIVATE_CHAIN'));
});
test('C10: resume mismatch blocks, without saving the wrong reference',async t=>{
  const h=setup(t,'codex','wrong-thread'),k=hooks(),saved:SessionRef={kind:'codex',threadId:randomUUID()};
  const r=await new CodexBackend(h.c).run(input(),saved,k.value,new AbortController().signal);
  assert.equal(r.outcome,'interrupted');assert.equal(r.errorCode,'SESSION_RESTORE_MISMATCH');assert.equal(k.refs.length,0);
});
test('C11/B06: thread persistence failure is uncertain, not an automatic retry',async t=>{
  const h=setup(t),k=hooks();let count=0;k.value.persistSession=async()=>{count++;throw new Error('disk failure SECRET');};
  const r=await new CodexBackend(h.c).run(input(),undefined,k.value,new AbortController().signal);
  assert.equal(count,1);assert.equal(r.outcome,'interrupted');assert.equal(r.errorCode,'SESSION_PERSISTENCE_AFTER_PROMPT');assert(!r.finalText.includes('SECRET'));
});
test('C12/B05: cancellation stops real writes and conservatively blocks uncertain work',async t=>{
  const h=setup(t,'codex','hang'),b=new CodexBackend(h.c),abort=new AbortController(),file=path.join(h.workspace,'side-effect.txt');
  const running=b.run(input(),undefined,hooks().value,abort.signal);await eventually(()=>existsSync(file));abort.abort();
  const r=await running;assert.equal(r.outcome,'interrupted');const before=readFileSync(file,'utf8');await new Promise(r=>setTimeout(r,100));assert.equal(readFileSync(file,'utf8'),before);
});
test('C13/B05: SIGTERM-ignoring child is escalated; stop() waits for cleanup',async t=>{
  const h=setup(t,'codex','ignore-term'),b=new CodexBackend(h.c),file=path.join(h.workspace,'side-effect.txt');
  const running=b.run(input(),undefined,hooks().value,new AbortController().signal);await eventually(()=>existsSync(file));await b.stop();const r=await running;
  assert.equal(r.outcome,'interrupted');const before=readFileSync(file,'utf8');await new Promise(r=>setTimeout(r,80));assert.equal(readFileSync(file,'utf8'),before);
});
test('C14/B05: owned grandchild writer stops or cleanup remains explicitly unknown',async t=>{
  const h=setup(t,'codex','child'),abort=new AbortController(),file=path.join(h.workspace,'side-effect.txt');
  const running=new CodexBackend(h.c).run(input(),undefined,hooks().value,abort.signal);await eventually(()=>existsSync(path.join(h.c.codex.home,'child.pid')));await new Promise(r=>setTimeout(r,80));abort.abort();
  const r=await running;assert.equal(r.outcome,'interrupted');const before=readFileSync(file,'utf8');await new Promise(r=>setTimeout(r,100));assert.equal(readFileSync(file,'utf8'),before);
});
test('C15: startup and task timeouts are finite and never pretend the task succeeded',async t=>{
  const h=setup(t,'codex','startup-hang');h.c.agent.startupTimeoutMs=80;
  const r=await new CodexBackend(h.c).run(input(),undefined,hooks().value,new AbortController().signal);
  assert.equal(r.outcome,'interrupted');assert.equal(r.errorCode,'CODEX_START_TIMEOUT');
});
test('C16: pre-cancelled input and unavailable executable do not launch a child',async t=>{
  const h=setup(t),abort=new AbortController();abort.abort();
  const r=await new CodexBackend(h.c).run(input(),undefined,hooks().value,abort.signal);assert.equal(r.outcome,'cancelled');
  h.c.agent.command='/definitely/not/installed/codex';const r2=await new CodexBackend(h.c).run(input(),undefined,hooks().value,new AbortController().signal);assert.equal(r2.errorCode,'CODEX_EXECUTABLE_MISSING');
  assert(!existsSync(path.join(h.c.codex.home,'capture.json')));
});
test('C17: prompt injection stays stdin data; no shell interpolation, no parent secret',async t=>{
  const h=setup(t),i=input();i.text='$(touch SHOULD_NOT_EXIST); hello "quoted"';
  const previous=process.env.BRIDGE_SECRET;process.env.BRIDGE_SECRET='DO_NOT_INHERIT';t.after(()=>{if(previous===undefined)delete process.env.BRIDGE_SECRET;else process.env.BRIDGE_SECRET=previous;});
  const r=await new CodexBackend(h.c).run(i,undefined,hooks().value,new AbortController().signal);assert.equal(r.outcome,'success');
  const captured=JSON.parse(readFileSync(path.join(h.c.codex.home,'capture.json'),'utf8'));assert.equal(captured.prompt,i.text);assert(!captured.args.includes(i.text));assert.equal(captured.env.BRIDGE_SECRET,undefined);assert(!existsSync(path.join(h.workspace,'SHOULD_NOT_EXIST')));
});
test('C18: overlapping run calls are rejected rather than corrupting ownership',async t=>{
  const h=setup(t,'codex','hang'),b=new CodexBackend(h.c),abort=new AbortController();const first=b.run(input(),undefined,hooks().value,abort.signal);
  await assert.rejects(b.run(input(),undefined,hooks().value,new AbortController().signal),/BACKEND_BUSY/);abort.abort();await first;
});
