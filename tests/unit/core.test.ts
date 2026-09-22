import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { normalize,baseKey } from '../../src/local.ts';
import { parseConfig,agentEnvironment } from '../../src/config.ts';
import { JsonlFramer } from '../../src/rpc-jsonl.ts';
import { splitText,boundedResult,resultParts } from '../../src/reply.ts';
import { codexArgs } from '../../src/codex.ts';
import { setup,fixture } from '../helpers.ts';
test('N01/N04: local identity is operator-bound; request IDs must be supplied',t=>{
  const {c}=setup(t), n=normalize(fixture(),c,'local:codex');
  assert.equal(n.route.senderId,'operator'); assert.equal(n.route.targetId,'default');
  assert.throws(()=>normalize({text:'hello'},c,'local:codex'),/INPUT_ID/);
});
test('N03/N06: remote identities and quote/mixed fields cannot be injected',t=>{
  const {c}=setup(t);
  for(const field of ['senderId','route','quote','mixed','url']) assert.throws(()=>normalize({...fixture(),[field]:'bad'},c,'local:codex'),/INPUT_UNKNOWN_KEY/);
});
test('N05/N07: local conversations are isolated; images preserve order',t=>{
  const {c}=setup(t),a=normalize(fixture('hi','a',randomUUID(),['/a.png','/b.png']),c,'local:codex'),b=normalize(fixture('hi','b'),c,'local:codex');
  assert.deepEqual(a.media.map(x=>x.path),['/a.png','/b.png']);
  assert.notEqual(baseKey(a.route,'test','codex'),baseKey(b.route,'test','codex'));
  assert.notEqual(baseKey(a.route,'test','codex'),baseKey(a.route,'test','pi'));
});
test('M04: URL images and command attachments are rejected, with no downloader',t=>{
  const {c}=setup(t);
  assert.throws(()=>normalize(fixture('a','b',randomUUID(),['https://example.org/a.png']),c,'local'),/MEDIA_PATH/);
  assert.throws(()=>normalize(fixture('/new','b',randomUUID(),['/a.png']),c,'local'),/COMMAND_IMAGES/);
});
test('P01/P02: bytewise UTF-8, CRLF and embedded U+2028/U+2029 preserve frames',()=>{
  const frames:unknown[]=[],f=new JsonlFramer(4096,v=>frames.push(v));
  const value={text:'中文🛰️\u2028\u2029'},bytes=Buffer.from(JSON.stringify(value)+'\r\n');
  for(const b of bytes) f.push(Buffer.from([b])); f.end(); assert.deepEqual(frames,[value]);
});
test('P08: invalid UTF-8/JSON, oversized and truncated frames fail closed',()=>{
  assert.throws(()=>new JsonlFramer(20,()=>{}).push(Buffer.alloc(21,97)),/FRAME_TOO_LARGE/);
  assert.throws(()=>new JsonlFramer(100,()=>{}).push(Buffer.from('{bad}\n')),/INVALID_JSON/);
  assert.throws(()=>new JsonlFramer(100,()=>{}).push(Buffer.from([0xff,10])),/INVALID_JSON/);
  const f=new JsonlFramer(100,()=>{});f.push(Buffer.from('{}'));assert.throws(()=>f.end(),/TRUNCATED/);
});
test('P11: inherited process credentials and injection environments are excluded',t=>{
  const {c}=setup(t); const env=agentEnvironment(c,{PATH:'/bin',BRIDGE_SECRET:'secret',OPENAI_API_KEY:'key'});
  assert.equal(env.BRIDGE_SECRET,undefined);assert.equal(env.OPENAI_API_KEY,undefined);assert.equal(env.CODEX_HOME,c.codex.home);
  c.agent.passEnv=['OPENAI_API_KEY'];assert.equal(agentEnvironment(c,{OPENAI_API_KEY:'key'}).OPENAI_API_KEY,'key');
  for(const k of ['NODE_OPTIONS','LD_PRELOAD','BASH_ENV','CODEX_HOME']) assert.throws(()=>parseConfig({...c,agent:{...c.agent,env:{[k]:'bad'}}}),/UNSAFE_AGENT_ENV/);
});
test('config: removed transport keys and unsafe Codex options cannot silently activate',t=>{
  const {c}=setup(t);
  assert.throws(()=>parseConfig({...c,wecom:{}}),/CONFIG_UNKNOWN_KEY/);
  assert.throws(()=>parseConfig({...c,codex:{...c.codex,sandbox:'danger-full-access'}}),/UNSAFE_SANDBOX/);
  assert.throws(()=>parseConfig({...c,agent:{...c.agent,args:['--yolo']}}),/CODEX_ARGS/);
});
test('config: paths, overlap, ranges, backend and concurrency are validated',t=>{
  const {c}=setup(t);
  assert.throws(()=>parseConfig({...c,stateRoot:c.workspace.path}),/OVERLAP/);
  assert.throws(()=>parseConfig({...c,queue:{maxActive:2}}),/CONCURRENCY/);
  assert.throws(()=>parseConfig({...c,media:{maxImages:5}}),/CONFIG_NUMBER/);
  assert.throws(()=>parseConfig({...c,backend:'other'}),/BACKEND_NOT/);
});
test('D01/D07: UTF-8 budget, pagination and explicit truncation',()=>{
  const text='中文👩🏽‍💻e\u0301'.repeat(500), parts=splitText(text,31);
  assert.equal(parts.join(''),text);assert(parts.every(p=>Buffer.byteLength(p)<=31));
  const bounded=boundedResult(text,256);assert(bounded.truncated);assert(Buffer.byteLength(bounded.text)<=256);
  const rendered=resultParts(randomUUID(),text,200);assert(rendered.length>1);assert(rendered.every(p=>Buffer.byteLength(p)<=200));assert.match(rendered[0]!,/下一段/);
});
test('Codex argv: explicit resume ID, images after resume, restrictive flags, stdin prompt',t=>{
  const {c}=setup(t),id=randomUUID();
  const args=codexArgs(c,[],{kind:'codex',threadId:id});
  assert.deepEqual(args.slice(-3),['resume',id,'-']);assert(args.includes('approval_policy="never"'));
  assert(args.includes('sandbox_workspace_write.network_access=false'));assert(!args.includes('--last'));assert(!args.includes('--skip-git-repo-check'));
  assert.throws(()=>codexArgs(c,[],{kind:'codex',threadId:'--last'}),/SESSION_BACKEND/);
});
