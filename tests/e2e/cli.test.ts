import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { setupService as setup, eventually } from '../helpers.ts';
import { deadline } from '../../src/async.ts';
function start(args: string[]) {
 const child=spawn(process.execPath,['dist/src/cli.js',...args],{stdio:'pipe'});
 let stdout='',stderr='';child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);
 const closed=once(child,'close').then(([code,signal])=>({code,signal,stdout,stderr,rows:()=>stdout.trim().split('\n').filter(Boolean).map(s=>JSON.parse(s))}));
 return {child,closed,stdout:()=>stdout};
}
function config(h: ReturnType<typeof setup>) {const file=path.join(h.root,'config.json');writeFileSync(file,JSON.stringify(h.c));return file;}
async function invoke(args:string[],stdin='') {const p=start(args);p.child.stdin.end(stdin);return deadline(p.closed,5000,'CLI_TEST_TIMEOUT');}
test('CLI01: run, resume, duplicate id, status and result work without network credentials',async t=>{
 const h=setup(t),cfg=config(h),args=['run','--config',cfg,'--message','first','--id','cli-1'];
 const first=await invoke(args);assert.equal(first.code,0,first.stderr);const task=first.rows().find(x=>x.type==='status').taskId;
 assert.equal((await invoke(args)).code,0);
 const second=await invoke(['run','--config',cfg,'--stdin','--id','cli-2'],'second\n');assert.equal(second.code,0,second.stderr);
 const capture=JSON.parse(readFileSync(path.join(h.c.codex.home,'capture.json'),'utf8'));assert(capture.args.includes('resume'));
 const status=await invoke(['status','--config',cfg]);assert.equal(status.code,0);assert(status.rows()[0].jobs.length>=2);
 const result=await invoke(['result','--config',cfg,'--task',task]);assert.equal(result.code,0);assert.match(result.rows()[0].text,/first/);
 assert(!existsSync(path.join(h.c.stateRoot,'instance.lock')));
});
test('CLI02: local image-only input reaches selected Codex executable',async t=>{
 const h=setup(t),cfg=config(h),image=path.join(h.root,'picture.png');await sharp({create:{width:3,height:2,channels:3,background:'blue'}}).png().toFile(image);
 const r=await invoke(['run','--config',cfg,'--image',image]);assert.equal(r.code,0,r.stderr);
 assert.equal(JSON.parse(readFileSync(path.join(h.c.codex.home,'capture.json'),'utf8')).images.length,1);
});
test('CLI03: serve consumes JSONL and routes results to correct local sessions',async t=>{
 const h=setup(t),cfg=config(h);const r=await invoke(['serve','--config',cfg],[{id:'a',session:'one',text:'A'},{id:'b',session:'two',text:'B'}].map(x=>JSON.stringify(x)).join('\n')+'\n');
 assert.equal(r.code,0,r.stderr);const results=r.rows().filter(x=>x.type==='result');assert.deepEqual(new Set(results.map(x=>x.session)),new Set(['one','two']));
});
test('CLI04: malformed/truncated JSONL, duplicate flags, and missing configuration fail',async t=>{
 const h=setup(t),cfg=config(h);
 for(const [args,stdin] of [
  [['serve','--config',cfg],'{"id":"x"}'],
  [['run','--config',cfg,'--message','a','--message','b'],''],
  [['run','--message','a'],''],
 ] as Array<[string[],string]>)assert.equal((await invoke(args,stdin)).code,1);
});
test('CLI05: SIGINT stops actual writes, exits 130, persists interrupted, requires manual review',async t=>{
 const h=setup(t,'codex','hang'),cfg=config(h),p=start(['run','--config',cfg,'--message','work']);p.child.stdin.end();
 t.after(()=>{if(p.child.exitCode===null)p.child.kill('SIGKILL');});
 const sentinel=path.join(h.workspace,'side-effect.txt');await eventually(()=>existsSync(sentinel));p.child.kill('SIGINT');
 const r=await deadline(p.closed,5000,'CLI_TEST_TIMEOUT');assert.equal(r.code,130,r.stderr);
 const before=readFileSync(sentinel,'utf8');await new Promise(r=>setTimeout(r,100));assert.equal(readFileSync(sentinel,'utf8'),before);
 const status=await invoke(['status','--config',cfg]);assert.equal(status.rows()[0].blocked,true);
 assert.equal((await invoke(['review','--config',cfg])).code,1);
 assert.equal((await invoke(['review','--config',cfg,'--acknowledge-side-effects'])).code,0);
 assert.equal((await invoke(['status','--config',cfg])).rows()[0].blocked,false);
});
test('CLI06: Pi selection uses RPC, without any Codex executable',async t=>{
 const h=setup(t,'pi'),cfg=config(h),r=await invoke(['run','--config',cfg,'--message','hello pi']);
 assert.equal(r.code,0,r.stderr);assert(r.rows().some(x=>x.type==='result'&&x.text.includes('answer:hello pi')));
});
