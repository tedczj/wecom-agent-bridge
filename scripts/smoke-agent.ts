import { randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';
import path from 'node:path';
import { loadConfig } from '../src/config.ts';
import { openService } from '../src/main.ts';
import { invariant, errorCode } from '../src/errors.ts';
/** Explicit opt-in only. This invokes a real installed Agent and can consume tokens. */
async function main(): Promise<void> {
  const [backend,...args]=process.argv.slice(2);
  invariant(backend==='codex'||backend==='pi','SMOKE_BACKEND');
  invariant(args.includes('--live'),'LIVE_OPT_IN_REQUIRED');
  const allowed=new Set(['--live','--config','--image']);
  let config:string|undefined,image:string|undefined;
  for(let i=0;i<args.length;i++){
    const key=args[i]!;invariant(allowed.has(key),'SMOKE_ARGUMENT');
    if(key==='--live')continue;
    const value=args[++i];invariant(value,'SMOKE_ARGUMENT');
    if(key==='--config'){invariant(!config,'SMOKE_ARGUMENT');config=value;}else{invariant(!image,'SMOKE_ARGUMENT');image=value;}
  }
  invariant(config,'CONFIG_ARGUMENT_REQUIRED');const c=loadConfig(config);invariant(c.backend===backend,'SMOKE_BACKEND');
  invariant(c.codex.sandbox==='read-only'||backend==='pi','SMOKE_READ_ONLY_REQUIRED');
  const nonce='nonce_'+randomUUID().replaceAll('-',''), session='smoke-'+randomUUID();
  // Discard live model text from normal logs; retain it only in the controlled local store.
  const output=new Writable({write(_chunk,_encoding,callback){callback();}});
  const run=async(text:string,images:string[]=[])=>{
    const service=await openService(c,output);
    try{
      const accepted=await service.accept({id:randomUUID(),session,text,images});
      invariant(accepted.taskId&&!accepted.rejected,'SMOKE_REJECTED');await service.settle();
      const job=service.store.get(accepted.taskId);invariant(job.status==='succeeded','SMOKE_TASK_FAILED');
      return {taskId:job.task_id,text:job.result_text??'',ref:service.store.session(job.session_key).agent_ref_json};
    }finally{await service.stop();}
  };
  const first=await run(`Do not use tools or write any files. Remember this exact nonce for this conversation: ${nonce}. Reply only OK.`);
  const second=await run('Do not use tools or read files. What exact nonce did I ask you to remember in the previous turn? Reply with the nonce only.');
  invariant(second.text.trim()===nonce,'SMOKE_CONTEXT_FAILED');
  invariant(first.ref&&first.ref===second.ref,'SMOKE_SESSION_REF_MISMATCH');
  const evidence:Record<string,unknown>={backend,liveText:'passed',crossProcessContext:'passed',sessionPersisted:!!second.ref,images:'not-tested',sideEffectIsolation:'not-tested',realModelCancellation:'not-tested'};
  if(image){
    const visual=await run('Describe the attached image without using tools or reading any other files. Do not modify files.',[path.resolve(image)]);
    evidence.images='transport-completed-human-verification-required';evidence.imageTaskId=visual.taskId;
  }
  process.stdout.write(JSON.stringify(evidence)+'\n');
}
main().catch(e=>{process.stderr.write(JSON.stringify({event:'smoke.failed',code:errorCode(e)})+'\n');process.exitCode=1;});
