import { loadConfig,preparePaths } from '../src/config.ts';
import { interpret } from '../src/routing/intent.ts';
import { Catalog } from '../src/routing/catalog.ts';
import { NativeHistory } from '../src/routing/history.ts';
import { invariant,errorCode } from '../src/errors.ts';
/** Opt-in classifier + read-only native history probe. Never dispatches or sends a chat reply. */
async function main():Promise<void> {
  const args=process.argv.slice(2);invariant(args.includes('--live'),'LIVE_OPT_IN_REQUIRED');
  invariant(args.length===3 && args[0]==='--live' && args[1]==='--config','SMOKE_ARGUMENT');
  const c=loadConfig(args[2]!);preparePaths(c);invariant(c.routing?.interpreter,'ROUTER_CONFIG_REQUIRED');
  const catalog=new Catalog(c),target=catalog.configured.find(d=>d.id==='doc-ocr-service');invariant(target,'SMOKE_DIRECTORY_REQUIRED');
  const intent=await interpret('查询 ocr service 的 GPT session 当前状态',c.routing.interpreter,{current:c.workspace.id,catalog:catalog.configured.map(d=>({id:d.id,aliases:d.aliases,description:d.description}))},c);
  invariant(['list','find'].includes(intent.action) && intent.query==='doc-ocr-service' && !intent.execute,'SMOKE_INTENT_MISMATCH');
  const reader=new NativeHistory();let result=await reader.scan(catalog.target(target)),pages=1;
  while(result.partial && pages<30){result=await reader.scan(catalog.target(target),result.scan);pages++;}
  invariant(!result.partial && result.scan.entries.length>0,'SMOKE_HISTORY_MISSING');
  console.log(JSON.stringify({requestedModel:c.routing.interpreter.model,requestedReasoning:c.routing.interpreter.reasoning,intent:'history-query',directory:'doc-ocr-service',historySource:result.scan.source,historyEntries:result.scan.entries.length,activeEntries:result.scan.entries.filter(e=>e.activity==='active').length,historyIssues:result.scan.issues,historyPages:pages,workerInvoked:false,weixinMessageSent:false,finalServerModel:'not-verified'}));
}
main().catch(e=>{console.error(JSON.stringify({event:'routing.smoke_failed',code:errorCode(e)}));process.exitCode=1;});
