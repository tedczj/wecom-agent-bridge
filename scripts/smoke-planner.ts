import { mkdtempSync, mkdirSync, realpathSync, readFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { Writable } from 'node:stream';
import sharp from 'sharp';
import { parseConfig, preparePaths } from '../src/config.ts';
import { openService } from '../src/main.ts';
import { Catalog } from '../src/routing/catalog.ts';
import { interpret } from '../src/routing/intent.ts';
import { invariant, errorCode } from '../src/errors.ts';
import type { NormalizedInput } from '../src/types.ts';

/** Real model opt-in; isolated local conversation, synthetic image, read-only workers, no Weixin. */
async function main():Promise<void> {
  const args=process.argv.slice(2);
  invariant(args[0]==='--live','LIVE_OPT_IN_REQUIRED');
  invariant(args.length===5 && args[1]==='--codex' && args[3]==='--home','SMOKE_ARGUMENT');
  const root=mkdtempSync(path.join(realpathSync(tmpdir()),'bridge-planner-live-'));
  const projects=path.join(root,'projects'),workspace=path.join(projects,'wecom-agent-bridge'),ocr=path.join(projects,'doc-ocr-service');
  mkdirSync(workspace,{recursive:true});mkdirSync(ocr);
  for(const dir of [workspace,ocr])execFileSync('git',['init','--quiet',dir]);
  const networkEnv=Object.fromEntries(['HTTP_PROXY','HTTPS_PROXY','NO_PROXY'].flatMap(key=>{const value=process.env[key]??process.env[key.toLowerCase()];return value?[[key,value]]:[];}));
  const c=parseConfig({backend:'codex',workspace:{id:'bridge',path:workspace},stateRoot:path.join(root,'state'),
    agent:{command:args[2],env:{HOME:homedir(),...networkEnv},startupTimeoutMs:60000,taskTimeoutMs:180000},
    codex:{home:args[4],model:'gpt-5.6-terra',reasoning:'high',sandbox:'read-only'},
    routing:{roots:[{id:'projects',path:projects,profile:'default'}],profiles:[{id:'default',version:'1'}],workspaces:[{id:'bridge',path:workspace,profile:'default',aliases:['wecom bridge']}],history:false,
      interpreter:{provider:'codex',model:'gpt-5.6-terra',reasoning:'high',timeoutMs:90000}}});
  preparePaths(c);const catalog=new Catalog(c);
  const context={current:'bridge',catalog:catalog.configured,roots:[projects],capabilities:catalog.capabilities(),recent:[],observations:[]};
  const samples=[
    {text:'图片显示：微信机器人连续三次查询会话，都回复了未找到历史会话。用户用 ID、ocr service、doc-ocr-service 都没找到。请排查这个问题。',actions:['work']},
    {text:'看下 doc-ocr-service 最后更新的 session 进度',actions:['list','find','inspect']},
    {text:'切换到 wecom bridge 目录',actions:['switch']},
  ];
  for(const sample of samples) {
    const plan=await interpret(sample.text,c.routing!.interpreter,context,c);
    invariant(sample.actions.includes(plan.action),'SMOKE_INTENT_MISMATCH');
    if(plan.action==='switch')invariant(plan.query,'SMOKE_SWITCH_TARGET');
    console.log(JSON.stringify({check:'live-planning',sample:samples.indexOf(sample)+1,action:plan.action,passed:true}));
  }
  const image=path.join(root,'red.png');await sharp({create:{width:96,height:96,channels:3,background:'#ff0000'}}).png().toFile(image);
  const service=await openService(c,new Writable({write(_chunk,_enc,done){done();}}));
  try {
    const first=await service.accept({id:randomUUID(),session:'smoke',text:'只说明这张图片的颜色，不执行其他任务。',images:[image]});
    invariant(first.taskId,'SMOKE_ACCEPT');await service.settle();
    const a=service.store.get(first.taskId);invariant(a.status==='succeeded','SMOKE_IMAGE_TURN');
    console.log(JSON.stringify({check:'live-first-image',passed:true}));
    const next=await service.accept({id:randomUUID(),session:'smoke',text:'找到 doc-ocr-service 目录，用 Codex 的 terra high 新起 session，结合刚才图片，只报告实际工作目录绝对路径和图片的颜色。不要修改文件。',images:[]});
    invariant(next.taskId,'SMOKE_ACCEPT');await service.settle();
    const b=service.store.get(next.taskId),input:NormalizedInput=JSON.parse(b.input_json),prior:NormalizedInput=JSON.parse(a.input_json);
    invariant(b.status==='succeeded','SMOKE_COMPOUND_TURN');
    invariant(input.routing?.directory.path===ocr && input.routing.execution?.model==='gpt-5.6-terra' && input.routing.execution.reasoning==='high','SMOKE_EXECUTION_TARGET');
    invariant(a.session_key!==b.session_key && input.images[0]?.sha256===prior.images[0]?.sha256,'SMOKE_HANDOFF');
    invariant(b.result_text?.includes(ocr) && /红|red/i.test(b.result_text),'SMOKE_VISUAL_REPLY');
    // Inspect actual persisted turn metadata, not just the requested CLI arguments.
    const ref=JSON.parse(service.store.session(b.session_key).agent_ref_json!);
    const {DatabaseSync}=await import('node:sqlite');const db=new DatabaseSync(path.join(c.codex.home,'state_5.sqlite'),{readOnly:true});
    let native:any;
    try {const row=db.prepare('SELECT rollout_path FROM threads WHERE id=?').get(ref.threadId) as {rollout_path:string}|undefined;
      invariant(row,'SMOKE_NATIVE_THREAD');const lines=readFileSync(row.rollout_path,'utf8').trim().split('\n').map(line=>JSON.parse(line));native=lines.filter(x=>x.type==='turn_context').at(-1)?.payload;
    } finally {db.close();}
    invariant(native?.cwd===ocr && native?.model==='gpt-5.6-terra' && (native?.effort==='high' || native?.effort?.effort==='high'),'SMOKE_NATIVE_SETTINGS');
    console.log(JSON.stringify({check:'live-compound-handoff',passed:true,unconfiguredDirectory:true,newSession:true,imageHashPreserved:true,nativeModel:native.model,nativeReasoning:'high',visualReply:'red',weixinSent:false,finalServerModel:'not-verified'}));
  } finally {await service.stop();}
}
main().catch(e=>{console.error(JSON.stringify({event:'planner.smoke_failed',code:errorCode(e)}));process.exitCode=1;});
