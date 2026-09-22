import { mkdtempSync,mkdirSync,realpathSync,readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Writable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { loadConfig,parseConfig } from '../src/config.ts';
import { openService } from '../src/main.ts';
import { invariant,errorCode } from '../src/errors.ts';
import type { NormalizedInput } from '../src/types.ts';
import { Catalog } from '../src/routing/catalog.ts';

/** Opt-in real planner/worker, temporary directories and local delivery; never authorizes a production path. */
async function main():Promise<void> {
  const args=process.argv.slice(2);invariant(args[0]==='--live','LIVE_OPT_IN_REQUIRED');
  invariant(args.length===3 && args[1]==='--config','SMOKE_ARGUMENT');
  const base=loadConfig(args[2]!);invariant(base.backend==='codex' && base.routing?.interpreter,'SMOKE_CODEX_REQUIRED');
  const fallbackId=new Catalog(base).authorizationProfile(),fallback=base.routing.profiles.find(p=>p.id===fallbackId)!;
  invariant((fallback.backend??base.backend)==='codex','SMOKE_CODEX_REQUIRED');
  const root=mkdtempSync(path.join(realpathSync(tmpdir()),'bridge-authorization-live-'));
  const workspace=path.join(root,'initial'),directory=path.join(root,'candidate');
  for(const d of [workspace,directory]) {mkdirSync(d);execFileSync('git',['init','--quiet',d]);}
  const c=parseConfig({...base,transport:'local',workspace:{id:'initial',path:workspace},stateRoot:path.join(root,'state'),
    agent:{...base.agent,sessionRoot:path.join(root,'sessions')},codex:{...base.codex,sandbox:'read-only'},
    routing:{roots:[{id:'initial',path:workspace,profile:'fallback'}],profiles:[{id:'default',version:'1'},
      {...fallback,id:'fallback',agent:{...fallback.agent,sessionRoot:path.join(root,'sessions')},codex:{...fallback.codex,sandbox:'read-only'}}],
      workspaces:[{id:'initial',path:workspace,profile:'default'}],history:false,interpreter:base.routing.interpreter}});
  const service=await openService(c,new Writable({write(_chunk,_enc,done){done();}}));
  try {
    const request=`切换到 ${directory}，只读检查：执行 pwd 并回复当前工作目录的绝对路径。不要修改文件。`;
    const first=await service.accept({id:randomUUID(),session:'probe',text:request});await service.settle();
    invariant(first.taskId,'SMOKE_ACCEPT');const question=service.store.get(first.taskId);
    invariant(question.kind==='command' && question.status==='succeeded' && question.result_text?.includes(directory) && question.result_text.includes('同意授权'),'SMOKE_AUTHORIZATION_QUESTION');
    invariant(!service.store.db.prepare("SELECT 1 FROM jobs WHERE kind='agent'").get(),'SMOKE_EXECUTED_BEFORE_CONSENT');
    console.log(JSON.stringify({check:'live-authorization-question',passed:true,workerInvoked:false,weixinSent:false}));
    const reply={id:randomUUID(),session:'probe',text:'同意授权'};
    const next=await service.accept(reply);await service.settle();invariant(next.taskId,'SMOKE_ACCEPT');
    const task=service.store.get(next.taskId),input:NormalizedInput=JSON.parse(task.input_json);
    invariant(task.kind==='agent' && task.status==='succeeded' && input.routing?.directory.path===directory,'SMOKE_APPROVED_EXECUTION');
    invariant(input.text===request && input.originalText===reply.text && input.messageId===reply.id && input.routing.authorizedRequestTaskId===question.task_id,'SMOKE_REQUEST_IDENTITY');
    invariant(task.result_text?.includes(directory),'SMOKE_WORKING_DIRECTORY');
    invariant(input.routing.directory.profile==='fallback','SMOKE_FALLBACK_PROFILE');
    const ref=JSON.parse(service.store.session(task.session_key).agent_ref_json!);
    const db=new DatabaseSync(path.join(fallback.codex?.home??c.codex.home,'state_5.sqlite'),{readOnly:true});
    let native:any;
    try {
      const row=db.prepare('SELECT rollout_path FROM threads WHERE id=?').get(ref.threadId) as {rollout_path:string}|undefined;
      invariant(row,'SMOKE_NATIVE_THREAD');
      native=readFileSync(row.rollout_path,'utf8').trim().split('\n').map(line=>JSON.parse(line)).filter(x=>x.type==='turn_context').at(-1)?.payload;
    } finally {db.close();}
    const model=fallback.codex?.model??base.codex.model,reasoning=fallback.codex?.reasoning??base.codex.reasoning;
    invariant(native?.cwd===directory && native.model===model && (native.effort===reasoning || native.effort?.effort===reasoning),'SMOKE_NATIVE_FALLBACK');
    invariant((await service.accept(reply)).duplicate,'SMOKE_DEDUPLICATION');
    invariant((service.store.db.prepare("SELECT count(*) n FROM jobs WHERE kind='agent'").get() as {n:number}).n===1,'SMOKE_DUPLICATE_EXECUTION');
    console.log(JSON.stringify({check:'live-authorized-local-work',passed:true,originalRequestPreserved:true,duplicateExecuted:false,nativeModel:model,nativeReasoning:reasoning,finalServerModel:'not-verified',weixinSent:false,productionDirectoryGranted:false,osIsolation:'not-verified'}));
  } finally {await service.stop();}
}
main().catch(e=>{console.error(JSON.stringify({event:'authorization.smoke_failed',code:errorCode(e)}));process.exitCode=1;});
