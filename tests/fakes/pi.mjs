// Deterministic subprocess fixture. No network, credentials or model access.
import {createInterface} from 'node:readline';
import {randomUUID} from 'node:crypto';
import {appendFileSync,writeFileSync,readFileSync,mkdirSync} from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
const arg=(key,fallback='')=>{const n=process.argv.indexOf(key);return n<0?fallback:process.argv[n+1];};
const scenario=arg('--scenario','normal'), log=arg('--record'), sentinel=arg('--sentinel');
const root=arg('--session-dir');mkdirSync(root,{recursive:true});
let sessionId=randomUUID(),sessionFile=path.join(root,sessionId+'.jsonl'),streaming=false, timers=[],child;
function out(x){process.stdout.write(JSON.stringify(x)+'\n');}
function record(x){if(log)appendFileSync(log,JSON.stringify(x)+'\n');}
record({envKeys:Object.keys(process.env)});
function respond(cmd,data){out({type:'response',id:cmd.id,command:cmd.type,success:true,...(data===undefined?{}:{data})});}
function message(text,reason='stop'){
 out({type:'message_end',message:{role:'assistant',content:[{type:'thinking',thinking:'DO_NOT_LEAK_THINKING'},{type:'text',text}],stopReason:reason}});
}
function settled(text='final answer',reason='stop'){message(text,reason);streaming=false;out({type:'agent_end'});out({type:'agent_settled'});}
function schedule(fn,ms){timers.push(setTimeout(fn,ms));}
function clear(){for(const timer of timers)clearTimeout(timer);timers=[];}
async function shutdown(){clear();if(child&&child.exitCode===null){child.kill('SIGTERM');await new Promise(r=>child.once('exit',r));}process.exit(0);}
process.on('SIGTERM',()=>void shutdown());
createInterface({input:process.stdin,crlfDelay:Infinity}).on('line',line=>{
 const cmd=JSON.parse(line);record(cmd);
 if(cmd.type==='get_state')respond(cmd,{model:{id:'fake',input:scenario==='no-images'?['text']:['text','image']},isStreaming:streaming,isCompacting:false,pendingMessageCount:0,sessionId,sessionFile,messageCount:0});
 else if(cmd.type==='new_session'){
  if(scenario==='new-cancel')return respond(cmd,{cancelled:true});
  sessionId=randomUUID();sessionFile=path.join(root,sessionId+'.jsonl');respond(cmd,{cancelled:false});
 }else if(cmd.type==='switch_session'){
  if(scenario==='switch-cancel')return respond(cmd,{cancelled:true});
  sessionFile=cmd.sessionPath;sessionId=JSON.parse(readFileSync(sessionFile,'utf8').split('\n')[0]).id;respond(cmd,{cancelled:false});
 }else if(cmd.type==='prompt'){
  if(scenario==='reject'){out({type:'response',id:cmd.id,command:cmd.type,success:false,error:'sensitive-token-and-body'});return;}
  writeFileSync(sessionFile,JSON.stringify({id:sessionId})+'\n');streaming=true;respond(cmd);out({type:'agent_start'});
  if(scenario==='invalid'){process.stdout.write('NOT_JSON_SECRET\n');return;}
  if(scenario==='huge'){process.stdout.write('x'.repeat(2048));return;}
  if(scenario==='exit'){process.exit(7);return;}
  if(scenario==='ui'){out({type:'extension_ui_request',id:'ui-1',method:arg('--ui-method','confirm'),title:'approve?'});return;}
  if(scenario==='hang'||scenario==='writer'){
   if(scenario==='writer'){
    // Pi child -> intermediate tool -> writer grandchild; both share the managed group.
    const writer=`const fs=require('node:fs');setInterval(()=>fs.appendFileSync(process.argv[1],'x'),10);`;
    const tool=`const {spawn}=require('node:child_process');const p=spawn(process.execPath,['-e',${JSON.stringify(writer)},${JSON.stringify(sentinel)}],{stdio:'ignore'});process.on('SIGTERM',()=>{p.kill();p.once('exit',()=>process.exit(0));});setInterval(()=>{},1000);`;
    child=spawn(process.execPath,['-e',tool],{stdio:'ignore'});
   }return;
  }
  if(scenario==='retry'){
   message('temporary failure','error');out({type:'agent_end'});out({type:'auto_retry_start'});schedule(()=>settled('retry succeeded'),80);return;
  }
  if(scenario==='delayed'){out({type:'agent_end'});schedule(()=>settled('delayed answer'),100);return;}
  if(scenario==='model-error')return settled('','error');
  if(scenario==='empty')return settled('');
  if(scenario==='refusal')return settled('I cannot help with that request.');
  if(scenario==='tool-error'){out({type:'tool_execution_end',isError:true,result:{content:[{type:'text',text:'TOOL_SECRET'}]}});return settled('The test command failed.');}
  if(scenario==='early'){settled('immediate answer');return;}
  settled('final answer');
 }else if(cmd.type==='abort'){
  respond(cmd);clear();if(scenario!=='writer'&&scenario!=='hang'){streaming=false;out({type:'agent_settled'});}
 }else if(cmd.type==='extension_ui_response'){record({uiResponse:cmd});}
 else respond(cmd);
});
