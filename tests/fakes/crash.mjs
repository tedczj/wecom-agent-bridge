// Tests kill this process at an explicitly committed/transactional boundary.
import fs from 'node:fs';
import path from 'node:path';
import { Store } from '../../dist/src/store.js';
import { loadConfig } from '../../dist/src/config.js';
import { normalize } from '../../dist/src/local.js';
const [configFile,stage]=process.argv.slice(2),c=loadConfig(configFile);
const s=new Store(path.join(c.stateRoot,'bridge.sqlite'),c);
const frame={id:'crash-request',session:'default',text:'crash task',images:[]};
const job=s.reserve(normalize(frame,c,'local:codex'),'agent').job;
fs.writeFileSync(path.join(c.stateRoot,'crash-info.json'),JSON.stringify({id:job.task_id,frame}));
if(stage==='preparing') {const dir=path.join(c.stateRoot,'media',job.task_id);fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,'orphan.part'),'partial');}
else {s.prepared(job.task_id,[]);if(stage!=='queued')s.claim();}
if(stage==='running')fs.writeFileSync(path.join(c.workspace.path,'changed.txt'),'SIDE EFFECT ALREADY HAPPENED');
if(stage==='pending'||stage==='sending')s.complete(job.task_id,'succeeded','durable answer');
if(stage==='sending')s.claimDelivery(Date.now());
if(stage==='transaction') {s.db.exec('BEGIN IMMEDIATE');s.db.prepare("UPDATE jobs SET status='succeeded',result_text='not committed' WHERE task_id=?").run(job.task_id);}
process.stdout.write('READY\n');setInterval(()=>{},1000);
