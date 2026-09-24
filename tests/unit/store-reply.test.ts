import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { Store } from '../../src/store.ts';
import { normalize } from '../../src/local.ts';
import { OutboxPump } from '../../src/reply.ts';
import { DeliveryError } from '../../src/errors.ts';
import { setup,fixture,FakeChannel } from '../helpers.ts';
function rows(store:Store) {return store.db.prepare('SELECT * FROM outbox').all() as Array<{state:string;attempts:number}>;}
function ready(h:ReturnType<typeof setup>,s:Store,text='hello',session='default') {const job=s.reserve(normalize(fixture(text,session),h.c,'local:codex'),'agent').job;s.prepared(job.task_id,[]);return job;}
for (const version of [1, 2]) test(`schema: v${version} database is refused without changing its version or data`,t=>{
 const h=setup(t),file=path.join(h.c.stateRoot,'old.sqlite'),old=new DatabaseSync(file);old.exec(`PRAGMA user_version=${version}; CREATE TABLE sentinel(value TEXT); INSERT INTO sentinel VALUES ('kept');`);old.close();
 assert.throws(()=>new Store(file,h.c),/LEGACY_STATE_REQUIRES_NEW_ROOT/);
 const check=new DatabaseSync(file);assert.equal(check.prepare('PRAGMA user_version').get()!.user_version,version);assert.equal(check.prepare('SELECT value FROM sentinel').get()!.value,'kept');check.close();
});
test('state: workspace identity and backend home cannot silently change',t=>{
 const h=setup(t),s=h.store(),file=path.join(h.c.stateRoot,'bridge.sqlite');
 assert.throws(()=>new Store(file,{...h.c,local:{...h.c.local,actorId:'other'}}),/STATE_IDENTITY/);
 assert.throws(()=>new Store(file,{...h.c,codex:{...h.c.codex,home:path.join(h.root,'other')}}),/BACKEND_HOME/);
 assert.equal((s.summary() as {blocked:boolean}).blocked,false);
});
test('Q01: duplicate IDs are durable; ID reuse with different content/session is rejected',t=>{
 const h=setup(t),s=h.store(),f=fixture(),n=normalize(f,h.c,'local:codex');const a=s.reserve(n,'agent');
 for(let i=0;i<10;i++)assert.equal(s.reserve(n,'agent').job.task_id,a.job.task_id);
 assert.throws(()=>s.reserve(normalize({...f,text:'changed'},h.c,'local:codex'),'agent'),/REQUEST_ID_CONFLICT/);
 assert.throws(()=>s.reserve(normalize({...f,session:'different'},h.c,'local:codex'),'agent'),/REQUEST_ID_CONFLICT/);
 assert.equal(s.db.prepare('SELECT count(*) n FROM jobs').get()!.n,1);
});
test('Q02/Q03: one active task; preparing blocks only later tasks in its own conversation',t=>{
 const h=setup(t),s=h.store(),first=s.reserve(normalize(fixture('first'),h.c,'local:codex'),'agent').job;
 const later=ready(h,s,'later'),other=ready(h,s,'other','other');
 assert.equal(s.claim()!.task_id,other.task_id);assert.equal(s.claim(),undefined);
 s.complete(other.task_id,'succeeded','other');assert.equal(s.claim(),undefined);
 s.prepared(first.task_id,[]);assert.equal(s.claim()!.task_id,first.task_id);s.complete(first.task_id,'succeeded','first');assert.equal(s.claim()!.task_id,later.task_id);
});
test('Q06: result/cancel ownership never crosses local conversation boundaries',t=>{
 const h=setup(t),s=h.store(),a=ready(h,s,'a','one'),b=s.reserve(normalize(fixture('/status','two'),h.c,'local:codex'),'command').job;
 assert.throws(()=>s.owned(b,a.task_id),/TASK_NOT_FOUND/);assert.throws(()=>s.owned(b,'../../etc'),/TASK_ID_INVALID/);
});
test('Q07: cancellation/success race has one terminal status and one outbox set',t=>{
 const h=setup(t),s=h.store(),a=ready(h,s);s.claim();s.cancel(a.task_id);assert(s.complete(a.task_id,'succeeded','answer'));
 assert.equal(s.get(a.task_id).status,'cancelled');assert(!s.complete(a.task_id,'succeeded','duplicate'));assert.equal(rows(s).length,1);
});
test('R04: outbox insertion failure rolls back result and terminal status',t=>{
 const h=setup(t),s=h.store(),a=ready(h,s);s.claim();
 s.db.exec("CREATE TRIGGER fail_delivery BEFORE INSERT ON outbox BEGIN SELECT RAISE(ABORT,'injected'); END;");
 assert.throws(()=>s.complete(a.task_id,'succeeded','answer'));
 assert.equal(s.get(a.task_id).status,'running');assert.equal(s.get(a.task_id).result_text,null);assert.equal(rows(s).length,0);
});
test('D03/D05: disconnected delivery remains pending; later success sends exactly once',async t=>{
 const h=setup(t),s=h.store(),a=ready(h,s);s.claim();s.complete(a.task_id,'succeeded','answer');const channel=new FakeChannel(),pump=new OutboxPump(s,channel,h.c.reply);
 channel.ready=false;assert.equal(await pump.tick(),false);assert.equal(rows(s)[0]!.state,'pending');channel.ready=true;
 assert(await pump.tick());assert.equal(rows(s)[0]!.state,'sent');assert.equal(await pump.tick(),false);assert.equal(channel.sent.length,1);
});
test('D04: ACK/output uncertainty is never automatically retried',async t=>{
 const h=setup(t),s=h.store(),a=ready(h,s);s.claim();s.complete(a.task_id,'succeeded','answer');const channel=new FakeChannel();let count=0;
 channel.send=async()=>{count++;throw new DeliveryError('ACK_UNKNOWN','unknown');};const pump=new OutboxPump(s,channel,h.c.reply);
 await pump.tick();assert.equal(rows(s)[0]!.state,'unknown');await pump.tick(Date.now()+100000);assert.equal(count,1);assert.equal(s.get(a.task_id).status,'succeeded');
});
test('D06: retryable failures are finite; permanent failures are never retried',async t=>{
 for(const disposition of ['retryable','permanent'] as const) {
  const h=setup(t),s=h.store(),a=ready(h,s);s.claim();s.complete(a.task_id,'succeeded','answer');const channel=new FakeChannel();let count=0;
  channel.send=async()=>{count++;throw new DeliveryError('TEST_FAILURE',disposition);};const pump=new OutboxPump(s,channel,h.c.reply);
  for(let i=0;i<6;i++)await pump.tick(Date.now()+i*100000);
  assert.equal(count,disposition==='retryable'?3:1);assert.equal(rows(s)[0]!.state,'failed');
 }
});
test('D07: bounded auto-parts retain the complete bounded result for explicit retrieval',t=>{
 const h=setup(t);h.c.reply.chunkBytes=180;h.c.reply.maxAutoParts=1;const s=h.store(),a=ready(h,s),text='中文'.repeat(500);s.claim();s.complete(a.task_id,'succeeded',text);
 assert.equal(rows(s).length,1);assert.equal(s.get(a.task_id).result_text,text);
});
