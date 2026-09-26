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
import { parseConfig } from '../../src/config.ts';
import { createBackend } from '../../src/main.ts';
import { controllerPolicy } from '../../src/controllers/codex-app-server.ts';

test('OFFLINE Codex networking: business search follows network access on new and resumed turns, management stays disabled', async t => {
  const h = setup(t);
  for (const networkAccess of [true, false]) {
    h.c.codex.networkAccess = networkAccess; h.c.codex.sandbox = 'workspace-write';
    for (const saved of [undefined, { kind: 'codex' as const, threadId: randomUUID() }]) {
      const args = codexArgs(h.c, [], saved, undefined, true);
      const search = `web_search="${networkAccess ? 'live' : 'disabled'}"`;
      assert.equal(args.filter(arg => arg.startsWith('web_search=')).length, 1);
      assert.ok(args.includes(search));
      assert.ok(args.find(arg => arg.startsWith('permissions='))!.includes(`network={enabled=${networkAccess}}`));
      if (saved) assert.ok(args.indexOf(search) < args.indexOf('resume'));
    }
  }
  h.c.codex.networkAccess = true;
  const backend = createBackend(h.c, new MediaStore(h.c), true);
  const first = await backend.run(input(), undefined, hooks().value, new AbortController().signal);
  assert.equal(first.outcome, 'success');
  const second = await backend.run(input(), first.sessionRef, hooks().value, new AbortController().signal);
  assert.equal(second.outcome, 'success'); await backend.stop();
  const captured = JSON.parse(readFileSync(path.join(h.c.codex.home, 'capture.json'), 'utf8'));
  assert.ok(captured.args.includes('web_search="live"')); assert.ok(captured.args.includes('resume'));
  h.c.codex.sandbox = 'read-only';
  assert.ok(codexArgs(h.c, [], undefined, { schemaPath: 'schema.json', instructionsPath: 'instructions.md' }).includes('web_search="disabled"'));
  assert.equal(controllerPolicy.web_search, 'disabled');
});

test('OFFLINE Codex model window: validated config reaches exec and explicit resume arguments', t => {
  const h = setup(t), c = parseConfig({ ...h.c, codex: { ...h.c.codex, contextWindowTokens: 828400 } });
  for (const saved of [undefined, { kind: 'codex' as const, threadId: randomUUID() }]) {
    const args = codexArgs(c, [], saved);
    assert.ok(args.includes('model_context_window=828400'));
    if (saved) assert.ok(args.indexOf('model_context_window=828400') < args.indexOf('resume'));
  }
  for (const value of [0, -1, 1.5, '1000000', Number.MAX_SAFE_INTEGER + 1])
    assert.throws(() => parseConfig({ ...h.c, codex: { ...h.c.codex, contextWindowTokens: value } }), /CONFIG_NUMBER/);
});
test('OFFLINE hierarchical window: real adapter metadata protocol maps usable capacity without mutating configuration or prompt', async t => {
  const h = setup(t), c = parseConfig({ ...h.c, codex: { ...h.c.codex, model: 'model', contextWindowTokens: 828400 } });
  writeFileSync(path.join(c.codex.home, 'models_cache.json'), JSON.stringify({ models: [{ slug: 'model', max_context_window: 872000, effective_context_window_percent: 95 }] }));
  const k = hooks(), windows: unknown[] = []; k.value.contextWindowResolved = value => windows.push(value);
  const work = input(); work.text = 'unchanged original';
  const result = await new CodexBackend(c, undefined, undefined, true).run(work, undefined, k.value, new AbortController().signal);
  assert.equal(result.outcome, 'success'); assert.equal(c.codex.contextWindowTokens, 828400); assert.equal(windows.length, 1);
  const capture = JSON.parse(readFileSync(path.join(c.codex.home, 'capture.json'), 'utf8'));
  assert.ok(capture.args.includes('model_context_window=872000')); assert.equal(capture.prompt, work.text);
  assert.ok(JSON.parse(readFileSync(path.join(c.codex.home, 'metadata-args.json'), 'utf8')).includes(`projects={${JSON.stringify(h.workspace)}={trust_level="untrusted"}}`));
  assert.equal(existsSync(path.join(c.stateRoot, 'agent-process.json')), false);
});
test('OFFLINE hierarchical window: oversized capacity fails before exec; metadata cancellation closes its process', async t => {
  for (const mode of ['capacity', 'cancel', 'timeout']) {
    const h = setup(t, 'codex', mode === 'capacity' ? 'normal' : 'metadata-hang'), c = parseConfig({ ...h.c,
      agent: { ...h.c.agent, ...(mode === 'timeout' ? { taskTimeoutMs: 100 } : {}) }, codex: { ...h.c.codex, model: 'model', contextWindowTokens: 1000000 } });
    writeFileSync(path.join(c.codex.home, 'models_cache.json'), JSON.stringify({ models: [{ slug: 'model', max_context_window: 872000, effective_context_window_percent: 95 }] }));
    const abort = new AbortController(), k = hooks(); let submitted = false; k.value.promptSubmitted = () => { submitted = true; };
    const running = new CodexBackend(c, undefined, undefined, true).run(input(), undefined, k.value, abort.signal);
    if (mode === 'cancel') { await eventually(() => existsSync(path.join(c.stateRoot, 'agent-process.json'))); abort.abort(); }
    const result = await running;
    assert.equal(result.outcome, mode === 'cancel' ? 'cancelled' : 'failed');
    if (mode !== 'cancel') assert.equal(result.errorCode, mode === 'capacity' ? 'CONTEXT_WINDOW_MISMATCH' : 'CODEX_TASK_TIMEOUT');
    assert.equal(submitted, false); assert.equal(k.refs.length, 0); assert.equal(existsSync(path.join(c.codex.home, 'capture.json')), false);
    assert.equal(existsSync(path.join(c.stateRoot, 'agent-process.json')), false);
  }
});
test('OFFLINE hierarchical Codex policy: transient untrusted project prevents implicit trust persistence and uses one TOML argument', t => {
  const h = setup(t), c = h.c;
  assert.equal(codexArgs(c, []).some(arg => arg.startsWith('projects=')), false);
  // Only presence of the already validated hierarchical configuration affects CLI policy.
  c.orchestration = {} as NonNullable<typeof c.orchestration>;
  c.workspace.path = '/private/fixture/with "quotes" and spaces';
  for (const saved of [undefined, { kind: 'codex' as const, threadId: randomUUID() }]) {
    const args = codexArgs(c, [], saved), policy = `projects={${JSON.stringify(c.workspace.path)}={trust_level="untrusted"}}`;
    assert.equal(args.filter(arg => arg === policy).length, 1); assert.equal(args[args.indexOf(policy) - 1], '--config');
    if (saved) assert.ok(args.indexOf(policy) < args.indexOf('resume'));
    assert.ok(args.includes('approval_policy="never"')); assert.equal(args.includes('--dangerously-bypass-approvals-and-sandbox'), false);
  }
});
test('OFFLINE hierarchical backend factory: project policy reaches the child after management configuration is stripped', async t => {
  const h = setup(t), backend = createBackend(h.c, new MediaStore(h.c), true);
  assert.equal(h.c.orchestration, undefined);
  const result = await backend.run(input(), undefined, hooks().value, new AbortController().signal);
  assert.equal(result.outcome, 'success'); await backend.stop();
  const captured = JSON.parse(readFileSync(path.join(h.c.codex.home, 'capture.json'), 'utf8'));
  assert.ok(captured.args.includes(`projects={${JSON.stringify(h.workspace)}={trust_level="untrusted"}}`));
});
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
test('OFFLINE image-only Codex: blank text remains exact on new and resumed turns without required stdin', async t => {
  const h = setup(t), source = path.join(h.root, 'blank-image.png');
  writeFileSync(source, await sharp({ create: { width: 4, height: 4, channels: 3, background: 'red' } }).png().toBuffer());
  const media = new MediaStore(h.c), images = await media.prepare(randomUUID(), [{ path: source, source: 'message' }]);
  const backend = new CodexBackend(h.c, image => media.read(image));
  let saved: SessionRef | undefined;
  for (const text of ['', ' \t\r\n']) {
    const request = { ...input(images), text };
    const result = await backend.run(request, saved, hooks().value, new AbortController().signal);
    assert.equal(result.outcome, 'success');
    const captured = JSON.parse(readFileSync(path.join(h.c.codex.home, 'capture.json'), 'utf8'));
    assert.deepEqual(captured.args.slice(-2), ['--', text]); assert.equal(captured.prompt, text);
    assert.deepEqual(JSON.parse(result.finalText).imageHashes, [images[0]!.sha256]);
    if (saved) assert.deepEqual(result.sessionRef, saved);
    saved = result.sessionRef;
  }
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
for (const mode of ['reconnecting','startup-warning']) test(`OFFLINE exec compatibility: ${mode} still requires full same-process completion`, async t => {
  const h = setup(t, 'codex', mode), k = hooks();
  const result = await new CodexBackend(h.c).run(input(), undefined, k.value, new AbortController().signal);
  assert.equal(result.outcome, 'success'); assert.equal(k.refs.length, 1);
  assert.deepEqual(JSON.parse(result.finalText).history, ['hello']);
  assert.equal(JSON.stringify(result).includes('FAKE_SECRET'), false);
  assert.ok(k.events.includes(mode === 'reconnecting' ? 'codex.transport_retry' : 'codex.warning'));
});
for (const [mode, code] of [['reconnect-incomplete','CODEX_INCOMPLETE_TURN'],['fatal-midturn','CODEX_EVENT_ORDER'],['rerouted','CODEX_MODEL_REROUTED']])
test(`OFFLINE exec compatibility: ${mode} cannot become successful`, async t => {
  const h = setup(t, 'codex', mode);
  const result = await new CodexBackend(h.c).run(input(), undefined, hooks().value, new AbortController().signal);
  assert.equal(result.outcome, 'interrupted'); assert.equal(result.errorCode, code);
  assert.equal(result.finalText.includes('FAKE_SECRET'), false);
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
for (const disappears of [true,false]) test(`C19: denied cleanup signal requires confirmed group disappearance (${disappears})`,async t=>{
  const h=setup(t,'codex','truncated-late-exit');h.c.agent.killGraceMs=disappears?500:20;
  const kill=process.kill.bind(process);let deniedPid:number|undefined;
  t.mock.method(process,'kill',(pid:number,signal?:string|number)=>{
    if(pid<0&&signal==='SIGTERM'){
      deniedPid=-pid;
      throw Object.assign(new Error('synthetic permission denial'),{code:'EPERM'});
    }
    return kill(pid,signal);
  });
  const r=await new CodexBackend(h.c).run(input(),undefined,hooks().value,new AbortController().signal);
  assert(deniedPid);assert.equal(r.outcome,'interrupted');
  assert.equal(r.errorCode,disappears?'RPC_TRUNCATED_FRAME':'BACKEND_STATE_UNKNOWN');
  assert.equal(existsSync(path.join(h.c.stateRoot,'agent-process.json')),!disappears);
  // The fake exits naturally even when cleanup was denied; leave no live child.
  await eventually(()=>{try{kill(-deniedPid!,0);return false;}catch(e){return (e as NodeJS.ErrnoException).code==='ESRCH';}});
});
