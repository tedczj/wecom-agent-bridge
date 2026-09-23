import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { Config } from './config.ts';
import type { Store } from './store.ts';
import type { Incoming, Job } from './types.ts';
import type { Router } from './routing/router.ts';
import { errorCode, invariant } from './errors.ts';

// Capture once at process startup, not after a later git pull changes the checkout.
const startupHead=(()=>{try {
  const value=execFileSync('git',['rev-parse','HEAD'],{cwd:fileURLToPath(new URL('../..',import.meta.url)),env:{PATH:process.env.PATH},encoding:'utf8',timeout:1000,stdio:['ignore','pipe','ignore']}).trim();
  return /^[a-f0-9]{40,64}$/.test(value)?value:'unknown';
}catch{return 'unknown';}})();

/** Same verified conversation only. Never include input, output, raw events, paths or transport identity. */
export async function debugReport(c:Config,store:Store,i:Incoming,router?:Router):Promise<string> {
  const args=i.text.trim().split(/\s+/).slice(1);
  invariant(args.length<=1 && (!args[0] || /^[a-f0-9-]{8,36}$/.test(args[0])),'COMMAND_ARGUMENTS');
  const route=JSON.stringify(i.route);
  const jobs=(args[0]
    ? store.db.prepare('SELECT * FROM jobs WHERE route_json=? AND task_id LIKE ? ORDER BY seq DESC LIMIT 2').all(route,args[0]+'%')
    : store.db.prepare('SELECT * FROM jobs WHERE route_json=? ORDER BY seq DESC LIMIT 6').all(route)) as unknown as Job[];
  if(args[0])invariant(jobs.length===1,jobs.length?'TASK_ID_AMBIGUOUS':'TASK_NOT_FOUND');
  const tasks=jobs.map(job=>{
    const input=JSON.parse(job.input_json);
    const deliveries=store.db.prepare('SELECT state,count(*) AS count FROM outbox WHERE task_id=? GROUP BY state').all(job.task_id);
    return {id:job.task_id.slice(0,8),kind:job.kind,status:job.status,error:job.error_code,createdAt:new Date(job.created_at).toISOString(),started:job.started_at!==null,
      // Failed routing reservations use the fallback config; do not label it the attempted directory.
      reservedWorkspace:input.workspaceId,selection:input.routing?.reason,
      routingAtRequest:input.routingDiagnostic??'unavailable (旧版本未记录，不推断当时目录或错误文件)',deliveries};
  });
  let current:unknown={active:c.workspace.id,routingEnabled:false};
  if(router)try {current=await router.debug(i);}catch(e){current={error:errorCode(e)};}
  return 'Bridge debug v1（脱敏，只读；不执行或重试任务）\n'+JSON.stringify({startupCheckout:startupHead,versionNote:'启动时 checkout SHA，不是构建产物证明',node:process.versions.node,backend:c.backend,current,tasks},null,2);
}
