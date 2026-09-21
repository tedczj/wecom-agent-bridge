// Fault-injection writer. Parent SIGKILLs this actual process after READY.
import {readFileSync,writeFileSync,mkdirSync,utimesSync} from 'node:fs';
import path from 'node:path';
import {Store} from '../../dist/src/store.js';
import {normalize} from '../../dist/src/wecom.js';
const [configFile,stage]=process.argv.slice(2);const c=JSON.parse(readFileSync(configFile,'utf8'));
const store=new Store(path.join(c.stateRoot,'bridge.sqlite'),c);
const frame={cmd:'aibot_msg_callback',headers:{req_id:'crash-req'},body:{msgid:'crash-message',aibotid:'fixture-bot',chattype:'single',from:{userid:'owner'},msgtype:'text',text:{content:'crash task'}}};
const job=store.reserve(normalize(frame,c,'fixture-bot'),'agent').job;
writeFileSync(path.join(c.stateRoot,'crash-info.json'),JSON.stringify({id:job.task_id,frame}));
if(stage==='preparing'){
 const dir=path.join(c.stateRoot,'media',job.task_id);mkdirSync(dir,{recursive:true});writeFileSync(path.join(dir,'input.part'),'unfinished');utimesSync(dir,new Date(0),new Date(0));
}else{
 store.prepared(job.task_id,[]);
 if(stage!=='queued'){
  store.claim();writeFileSync(path.join(c.workspace.path,'changed.txt'),'SIDE EFFECT ALREADY HAPPENED');
  if(stage==='transaction'){
   // Deliberately crash halfway through the same result/outbox transaction boundary.
   store.db.exec('BEGIN IMMEDIATE');
   store.db.prepare("UPDATE jobs SET status='succeeded',result_text='uncommitted answer' WHERE task_id=?").run(job.task_id);
  }else if(stage==='pending'||stage==='sending'){
   store.complete(job.task_id,'succeeded','durable answer');
   if(stage==='sending')store.claimDelivery(Date.now());
  }
 }
}
process.stdout.write('READY\n');setInterval(()=>{},1000);
