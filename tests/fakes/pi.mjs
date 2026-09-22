#!/usr/bin/env node
// Deterministic offline Pi RPC contract double. No model calls or sandbox claims.
import readline from 'node:readline';
import { randomUUID, createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
const args = process.argv.slice(2), root = args[args.indexOf('--session-dir') + 1];
const mode = process.env.FAKE_MODE ?? 'normal';
let id = randomUUID(), file = path.join(root,id+'.json'), history = [], streaming = false, timer;
const emit = value => process.stdout.write(JSON.stringify(value)+'\n');
const reply = (q,data={},success=true) => emit({type:'response',id:q.id,command:q.type,success,data});
const capture = data => writeFileSync(path.join(root,'capture.json'),JSON.stringify(data));
const finish = (text,reason='stop') => {
  streaming = false; emit({type:'message_end',message:{role:'assistant',content:[{type:'text',text}],stopReason:reason}});
  emit({type:'agent_end'}); emit({type:'agent_settled'});
};
readline.createInterface({input:process.stdin}).on('line',line => {
  const q = JSON.parse(line);
  if(q.type === 'get_state') return reply(q,{model:{input:mode==='no-images'?['text']:['text','image']},isStreaming:streaming,isCompacting:false,pendingMessageCount:0,sessionId:id,sessionFile:file});
  if(q.type === 'new_session' || q.type === 'switch_session') {
    if(mode==='session-cancel') return reply(q,{cancelled:true});
    if(q.type==='new_session') {id=randomUUID();file=path.join(root,id+'.json');history=[];}
    else {file=q.sessionPath; const saved=JSON.parse(readFileSync(file,'utf8'));id=saved.id;history=saved.history;}
    // Events before the prompt must not complete the next turn.
    if(mode==='stale') finish('STALE ANSWER');
    return reply(q,{cancelled:false});
  }
  if(q.type==='extension_ui_response') {capture(q); return;}
  if(q.type==='abort') {reply(q);if(mode==='ignore-abort')return;clearTimeout(timer);finish('cancelled','aborted');return;}
  if(q.type!=='prompt') return reply(q);
  if(mode==='reject') return reply(q,{},false);
  const images=(q.images??[]).map(x=>({type:x.type,sha256:createHash('sha256').update(Buffer.from(x.data,'base64')).digest('hex')}));
  capture({prompt:q.message,images,env:process.env}); history.push(q.message);writeFileSync(file,JSON.stringify({id,history}));streaming=true;reply(q);
  if(mode==='malformed') {process.stdout.write('not-json\n');return;}
  if(mode==='exit') {process.exit(2);return;}
  if(mode==='ui') {emit({type:'extension_ui_request',id:'ui-1',method:'confirm'});return;}
  if(mode==='hang' || mode==='ignore-abort')return;
  if(mode==='retry') {emit({type:'message_end',message:{role:'assistant',content:[{type:'text',text:'temporary failure'}],stopReason:'error'}});emit({type:'agent_end'});}
  // Unknown epoch responses must never resolve a current request.
  emit({type:'response',id:'old-epoch',command:'prompt',success:true,data:{}});
  timer=setTimeout(()=>finish(mode==='error'?'model error':mode==='empty'?'':'answer:'+history.join('|'),mode==='error'?'error':'stop'),mode==='delayed'||mode==='retry'?120:10);
});
