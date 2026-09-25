import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync, symlinkSync,mkdirSync,writeFileSync } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { setupService as setup, output, eventually } from '../helpers.ts';
import { apiBase, WeixinApi, type Fetch, type WeixinAuth } from '../../src/weixin-api.ts';
import { loadOrLogin, saveAuth, weixinLogin } from '../../src/weixin-login.ts';
import { decryptImage, downloadImage, imageUrl } from '../../src/weixin-media.ts';
import { normalizeWeixin, runWeixin, WeixinChannel, WeixinReceiver } from '../../src/weixin.ts';
import { openService } from '../../src/main.ts';
import { OutboxPump } from '../../src/reply.ts';
import type { Incoming } from '../../src/types.ts';
import type { Maintenance } from '../../src/maintenance.ts';

const auth: WeixinAuth = {token:'SYNTHETIC_BOT_TOKEN',botId:'bot@test',userId:'owner@test',baseUrl:'https://ilinkai.weixin.qq.com'};
const frame = (id='1', text='hello') => ({message_id:id,from_user_id:auth.userId,to_user_id:auth.botId,
  message_type:1,message_state:2,context_token:'SYNTHETIC_CONTEXT',item_list:[{type:1,text_item:{text}}]});
const response = (body: unknown) => new Response(JSON.stringify(body),{status:200});

test('W01: only paired personal user and matching bot can execute, with stable conversation identity', t => {
  const h=setup(t), first=normalizeWeixin(frame(),auth,h.c), second=normalizeWeixin(frame('2','next'),auth,h.c);
  assert.deepEqual(first.incoming.route,second.incoming.route);
  for (const changes of [{from_user_id:'stranger'},{to_user_id:'other-bot'},{group_id:'group'},{message_type:2},{message_state:1}])
    assert.throws(()=>normalizeWeixin({...frame(),...changes},auth,h.c));
  assert.throws(()=>normalizeWeixin({...frame(),context_token:undefined},auth,h.c));
  assert(!JSON.stringify(first.incoming).includes('SYNTHETIC_CONTEXT'));
});
test('W02: voice transcription is accepted; missing transcript, files and quoted context are explicit unsupported cases', t => {
  const h=setup(t);
  const voice={...frame(),item_list:[{type:3,voice_item:{text:'transcribed speech'}}]};
  assert.equal(normalizeWeixin(voice,auth,h.c).incoming.text,'transcribed speech');
  assert.equal(normalizeWeixin({...voice,item_list:[{type:3,voice_item:{}}]},auth,h.c).unsupported,'WEIXIN_VOICE_TRANSCRIPT_MISSING');
  assert.equal(normalizeWeixin({...frame(),item_list:[{type:4}]},auth,h.c).unsupported,'WEIXIN_MEDIA_UNSUPPORTED');
  assert.equal(normalizeWeixin({...frame(),item_list:[{...frame().item_list[0],ref_msg:{svr_id:'1'}}]},auth,h.c).unsupported,'WEIXIN_QUOTE_UNSUPPORTED');
});
test('W03: API headers, lossless uint64 message IDs, business errors and bounded responses', async () => {
  const calls: {url:string;init?:RequestInit}[]=[];
  const fetcher: Fetch = async (url,init) => {
    calls.push({url:String(url),init});
    return new Response('{"ret":0,"msgs":[{"message_id":18446744073709551615}]}');
  };
  const api=new WeixinApi(fetcher), data=await api.bot('getupdates',{get_updates_buf:''},auth);
  assert.equal((data.msgs as {message_id:string}[])[0]!.message_id,'18446744073709551615');
  assert.equal((calls[0]!.init!.headers as Record<string,string>).Authorization,`Bearer ${auth.token}`);
  assert.equal(calls[0]!.init!.redirect,'error');
  assert.equal(JSON.parse(calls[0]!.init!.body as string).base_info.bot_agent,'LocalAgentBridge/0.2.0');
  await api.request('ilink/bot/get_qrcode_status?qrcode=synthetic',undefined);
  assert.equal((calls[1]!.init!.headers as Record<string,string>).Authorization,undefined);
  assert.equal((calls[1]!.init!.headers as Record<string,string>).AuthorizationType,undefined);
  await assert.rejects(new WeixinApi(async()=>response({ret:-14})).bot('getupdates',{},auth),/WEIXIN_AUTH_EXPIRED/);
  await assert.rejects(new WeixinApi(async()=>response({ret:5})).bot('sendmessage',{},auth),/WEIXIN_API_REJECTED/);
  await assert.rejects(new WeixinApi(async()=>new Response('x'.repeat(4*1024*1024+1))).request('x',{}),/WEIXIN_RESPONSE_TOO_LARGE/);
  for(const url of ['http://ilinkai.weixin.qq.com','https://weixin.qq.com.evil.test','https://127.0.0.1','https://user@ilinkai.weixin.qq.com']) assert.throws(()=>apiBase(url));
});
test('W04: QR verification/redirect then confirmed login; credentials stay private and are reused', async t => {
  const h=setup(t), calls:string[]=[], queries:string[]=[];
  const api=new WeixinApi(async (url,init)=>{
    const u=new URL(String(url)); calls.push(u.hostname); queries.push(u.search);
    if(u.pathname.endsWith('get_bot_qrcode')) { assert.deepEqual(JSON.parse(init!.body as string),{local_token_list:[]}); return response({qrcode:'synthetic-qr',qrcode_img_content:'synthetic-qr-content'}); }
    if(calls.length===2) return response({status:'need_verifycode'});
    if(calls.length===3) return response({status:'scaned_but_redirect',redirect_host:'ilinkai.weixin.qq.com'});
    return response({status:'confirmed',bot_token:auth.token,ilink_bot_id:auth.botId,ilink_user_id:auth.userId,baseurl:auth.baseUrl});
  });
  const result=await weixinLogin(api,new AbortController().signal,{showQr:value=>assert.equal(value,'synthetic-qr-content'),verify:async()=> '123456'});
  assert.deepEqual(result,auth); assert(queries.some(q=>q.includes('verify_code=123456')));
  const file=path.join(h.c.stateRoot,'weixin-auth.json'); saveAuth(file,auth);
  assert.equal(statSync(file).mode&0o777,0o600);
  assert.deepEqual(await loadOrLogin(h.c.stateRoot,new WeixinApi(async()=>{throw new Error('must not log in again');}),new AbortController().signal),auth);
  const link=path.join(h.c.stateRoot,'auth-link');symlinkSync(file,link);assert.throws(()=>saveAuth(link,auth),/UNSAFE_AUTH_FILE/);
});
test('W05: image decrypt supports raw/base64 hex keys; downloads are bounded and host restricted', async () => {
  const key=Buffer.alloc(16,7), plain=Buffer.from('synthetic image bytes');
  const cipher=createCipheriv('aes-128-ecb',key,null), encrypted=Buffer.concat([cipher.update(plain),cipher.final()]);
  for(const image of [{aeskey:key.toString('hex'),media:{}},{media:{aes_key:key.toString('base64')}},{media:{aes_key:Buffer.from(key.toString('hex')).toString('base64')}}]) assert.deepEqual(decryptImage(encrypted,image),plain);
  assert.throws(()=>imageUrl({media:{full_url:'http://127.0.0.1/secret'}}),/WEIXIN_CDN_HOST/);
  assert.throws(()=>decryptImage(encrypted,{aeskey:'bad',media:{}}),/WEIXIN_MEDIA_KEY/);
  const image={aeskey:key.toString('hex'),media:{encrypt_query_param:'opaque'}};
  const bytes=await downloadImage(image,plain.length,new AbortController().signal,async (url,init)=>{
    assert.match(String(url),/^https:\/\/novac2c\.cdn\.weixin\.qq\.com/);assert.equal(init!.redirect,'error');assert.equal(init!.headers,undefined);return new Response(encrypted);
  });assert.deepEqual(bytes,plain);
  await assert.rejects(downloadImage(image,4,new AbortController().signal,async()=>new Response(encrypted)),/WEIXIN_RESPONSE_TOO_LARGE|MEDIA_SIZE/);
});

async function channelService(t: Parameters<typeof setup>[0], api: WeixinApi) {
  const h=setup(t);h.c.transport='weixin';h.c.reply.minIntervalMs=0;
  const channel=new WeixinChannel(api);
  const service=await openService(h.c,output().stream,{channel,normalize:frame=>frame as Incoming,
    initialize:async store=>{channel.auth=auth;channel.store=store;channel.ready=true;}});
  h.cleanups.push(()=>service.stop());
  return {...h,channel,service,receiver:new WeixinReceiver(h.c,service,channel)};
}
test('W06: personal messages reach real child double, persist context, deduplicate and reply to owner', async t => {
  const sends:Record<string,unknown>[]=[];
  const h=await channelService(t,new WeixinApi(async (_url,init)=>{sends.push(JSON.parse(init!.body as string));return response({ret:0});}));
  const signal=new AbortController().signal;
  await h.receiver.accept(frame(),signal); await h.service.settle();
  await h.receiver.accept(frame(),signal); await h.service.settle();
  await h.receiver.accept({...frame('2','next'),context_token:'NEXT_CONTEXT'},signal);await h.service.settle();
  assert.equal(sends.length,2);
  const sent=sends[1]!.msg as {to_user_id:string;context_token:string;item_list:{text_item:{text:string}}[]};
  assert.equal(sent.to_user_id,auth.userId);assert.equal(sent.context_token,'NEXT_CONTEXT');
  assert.match(sent.item_list[0]!.text_item.text,/hello/);assert.match(sent.item_list[0]!.text_item.text,/next/);
  assert.equal(h.service.store.db.prepare('SELECT count(*) n FROM jobs').get()!.n,2);
  assert(!JSON.stringify(h.service.store.db.prepare('SELECT input_json FROM jobs').all()).includes('CONTEXT'));
});
test('W07: encrypted image reaches Agent as validated bytes; unauthorised media never downloads', async t => {
  const png=await sharp({create:{width:3,height:2,channels:3,background:'red'}}).png().toBuffer();
  const key=Buffer.alloc(16,9), cipher=createCipheriv('aes-128-ecb',key,null), encrypted=Buffer.concat([cipher.update(png),cipher.final()]);
  let downloads=0;t.mock.method(globalThis,'fetch',async()=>{downloads++;return new Response(encrypted);});
  const h=await channelService(t,new WeixinApi(async()=>response({ret:0})));
  const image={...frame(),item_list:[{type:2,image_item:{aeskey:key.toString('hex'),media:{encrypt_query_param:'synthetic'}}}]};
  await h.receiver.accept({...image,from_user_id:'stranger'},new AbortController().signal);assert.equal(downloads,0);
  await h.receiver.accept(image,new AbortController().signal);await h.service.settle();assert.equal(downloads,1);
  const capture=JSON.parse(readFileSync(path.join(h.c.codex.home,'capture.json'),'utf8'));
  assert.deepEqual(capture.imageHashes,[createHash('sha256').update(png).digest('hex')]);
  const inputs=JSON.stringify(h.service.store.db.prepare('SELECT input_json FROM jobs').all());
  assert(!inputs.includes('encrypt_query_param'));assert(!inputs.includes(key.toString('hex')));
});
test('W08: voice without transcript replies with limitation and never starts Agent', async t => {
  const messages:string[]=[];
  const h=await channelService(t,new WeixinApi(async (_url,init)=>{messages.push(String(init!.body));return response({ret:0});}));
  await h.receiver.accept({...frame(),item_list:[{type:3,voice_item:{}}]},new AbortController().signal);await h.service.settle();
  assert.equal(messages.length,1);assert.match(messages[0]!,/没有附带转写文本/);
  assert(!existsSync(path.join(h.c.codex.home,'capture.json')));
});
test('W09: send ACK uncertainty stays unknown without resend or Agent replay', async t => {
  let attempts=0;const h=await channelService(t,new WeixinApi(async()=>{attempts++;throw new Error('SYNTHETIC_SECRET');}));
  await h.receiver.accept(frame(),new AbortController().signal);await h.service.settle();
  assert.equal(attempts,1);
  assert.equal(h.service.store.db.prepare('SELECT state FROM outbox').get()!.state,'unknown');
  assert.equal(await new OutboxPump(h.service.store,h.channel,h.c.reply).tick(),false);
  assert.equal(attempts,1);
});
test('W10: long-poll saves cursor after acceptance, ignores bot echoes and aborts cleanly', async t => {
  const h=setup(t);h.c.transport='weixin';saveAuth(path.join(h.c.stateRoot,'weixin-auth.json'),auth);
  const controller=new AbortController();let polls=0,sends=0;
  const api=new WeixinApi(async (url,init)=>{
    if(String(url).endsWith('sendmessage')){sends++;return response({ret:0});}
    const body=JSON.parse(init!.body as string);polls++;
    if(polls===1){assert.equal(body.get_updates_buf,'');return response({ret:0,msgs:[{...frame(),message_type:2},frame('10','/help')],get_updates_buf:'cursor-1'});}
    assert.equal(body.get_updates_buf,'cursor-1');return response({ret:0,get_updates_buf:'cursor-1'});
  });
  const running=runWeixin(h.c,output().stream,controller.signal,api);void running.catch(()=>{});
  try {await eventually(()=>sends===1&&polls>=2);}
  finally {controller.abort();await running.catch(e=>{assert.equal(e.name,'AbortError');});}
  assert(!existsSync(path.join(h.c.stateRoot,'instance.lock')));
  assert(!existsSync(path.join(h.c.codex.home,'capture.json')));
});
test('W11: transport and bound account cannot be silently changed to deliver old results', async t => {
  const h=setup(t), local=await openService(h.c,output().stream);
  await local.accept({id:'old-local',text:'/help',images:[]});await local.settle();await local.stop();
  h.c.transport='weixin';
  await assert.rejects(openService(h.c,output().stream,{channel:new WeixinChannel(new WeixinApi()),normalize:f=>f as Incoming,initialize:async()=>{throw new Error('must not initialize');}}),/STATE_TRANSPORT_MISMATCH/);
  assert(!existsSync(path.join(h.c.stateRoot,'instance.lock')));
  const other=await channelService(t,new WeixinApi(async()=>response({ret:0})));
  other.service.store.db.prepare("INSERT INTO metadata(key,value) VALUES ('weixin:identity',?)").run(JSON.stringify(['another-bot',auth.userId]));
  await other.service.stop();saveAuth(path.join(other.c.stateRoot,'weixin-auth.json'),auth);
  await assert.rejects(runWeixin(other.c,output().stream,new AbortController().signal),/WEIXIN_ACCOUNT_MISMATCH/);
  assert(!existsSync(path.join(other.c.stateRoot,'instance.lock')));
});
test('W12: replay before cursor commit deduplicates without a second Agent execution', async t => {
  const h=await channelService(t,new WeixinApi(async(url)=>response(String(url).endsWith('getupdates')
    ? {ret:0,msgs:[frame('replayed','same task')],get_updates_buf:'cursor-next'} : {ret:0})));
  const signal=new AbortController().signal;
  await h.receiver.accept(frame('replayed','same task'),signal);await h.service.settle();
  // Simulate an update redelivery after durable acceptance but before cursor commit.
  await h.receiver.poll(signal);await h.service.settle();
  assert.equal(h.service.store.db.prepare('SELECT count(*) n FROM jobs').get()!.n,1);
  assert.equal(h.service.store.db.prepare('SELECT count(*) n FROM outbox').get()!.n,1);
  const capture=JSON.parse(readFileSync(path.join(h.c.codex.home,'capture.json'),'utf8'));
  assert.equal(capture.args.includes('resume'),false);
  assert.equal(h.service.store.db.prepare("SELECT value FROM metadata WHERE key='weixin:cursor'").get()!.value,'cursor-next');
});
test('W13: real iLink success envelopes omit ret; getupdates and sendmessage must accept them', async () => {
  const poll={msgs:[],sync_buf:'synthetic',get_updates_buf:'cursor'};
  assert.deepEqual(await new WeixinApi(async()=>response(poll)).bot('getupdates',{},auth),poll);
  assert.deepEqual(await new WeixinApi(async()=>response({})).bot('sendmessage',{},auth),{});
  for(const data of [{ret:null},{ret:'0'},{errcode:'0'},{ret:0.5}])
    await assert.rejects(new WeixinApi(async()=>response(data)).bot('getupdates',{},auth),/WEIXIN_API_PROTOCOL/);
  for(const data of [{ret:1},{errcode:7},{ret:0,errcode:9}])
    await assert.rejects(new WeixinApi(async()=>response(data)).bot('sendmessage',{},auth),/WEIXIN_API_REJECTED/);
});
test('W14: omitted success codes support complete intake, Agent execution, reply ACK and cursor persistence', async t => {
  let sends=0;
  const h=await channelService(t,new WeixinApi(async(url)=>{
    if(String(url).endsWith('getupdates')) return response({msgs:[frame('no-ret','hello from weixin')],get_updates_buf:'accepted-cursor'});
    sends++;return response({});
  }));
  await h.receiver.poll(new AbortController().signal);await h.service.settle();
  assert.equal(sends,1);assert.equal(h.service.store.db.prepare('SELECT status FROM jobs').get()!.status,'succeeded');
  assert.equal(h.service.store.db.prepare('SELECT state FROM outbox').get()!.state,'sent');
  assert.equal(h.service.store.db.prepare("SELECT value FROM metadata WHERE key='weixin:cursor'").get()!.value,'accepted-cursor');
});

test('W15: paired Weixin management approval and final delivery are durable and deduplicated (protocol doubles)',async t=>{
  const sends:any[]=[];
  const h=await channelService(t,new WeixinApi(async(_url,init)=>{sends.push(JSON.parse(init!.body as string).msg);return response({});}));
  // Synthetic manager identity only; real parent/worker replacement is exercised by MG01-MG08.
  const prior=process.env.BRIDGE_SUPERVISOR_TOKEN;process.env.BRIDGE_SUPERVISOR_TOKEN='synthetic-manager';
  t.after(()=>{if(prior===undefined)delete process.env.BRIDGE_SUPERVISOR_TOKEN;else process.env.BRIDGE_SUPERVISOR_TOKEN=prior;});
  const root=path.join(h.c.stateRoot,'supervisor');mkdirSync(root);writeFileSync(path.join(root,'instance.lock'),JSON.stringify({pid:process.ppid,token:'synthetic-manager',root:h.workspace}));
  const signal=new AbortController().signal;
  await h.receiver.accept(frame('management-request','/restart'),signal);await h.service.settle();
  assert.match(sends[0].item_list[0].text_item.text,/\/approve/);
  await h.receiver.accept({...frame('foreign-approve','/approve'),from_user_id:'stranger'},signal);await h.service.settle();assert.equal(sends.length,1);
  const approval={...frame('management-approval','/approve'),context_token:'FRESH_SYNTHETIC_CONTEXT'};
  await h.receiver.accept(approval,signal);await h.service.settle();const m=h.service.store.value<Maintenance>('maintenance')!;
  assert.equal(m.phase,'requested');assert.equal(h.service.store.get(m.taskId).status,'queued');assert.equal(sends.at(-1).context_token,'FRESH_SYNTHETIC_CONTEXT');
  await h.receiver.accept(approval,signal);await h.service.settle();assert.equal(h.service.store.value<Maintenance>('maintenance')!.taskId,m.taskId);assert.equal(sends.length,2);
  h.service.store.complete(m.taskId,'succeeded','重启完成',undefined,['queued'],undefined,'maintenance-final');await h.service.settle();
  assert.equal(sends.length,3);assert.equal(sends.at(-1).to_user_id,auth.userId);assert.match(sends.at(-1).item_list[0].text_item.text,/重启完成/);
  assert(!existsSync(path.join(h.c.codex.home,'capture.json')));
});

test('W16: paired Weixin debug delivers redacted report once without invoking an Agent (protocol double)',async t=>{
  const sends:any[]=[];
  const h=await channelService(t,new WeixinApi(async(_url,init)=>{sends.push(JSON.parse(init!.body as string).msg);return response({});}));
  const signal=new AbortController().signal;
  const request=frame('debug-request','/debug');
  await h.receiver.accept({...request,from_user_id:'stranger'},signal);await h.service.settle();assert.equal(sends.length,0);
  await h.receiver.accept(request,signal);await h.service.settle();const count=sends.length;assert(count>0);
  assert(sends.every(msg=>msg.to_user_id===auth.userId));
  const text=sends.map(msg=>msg.item_list[0].text_item.text).join('');assert.match(text,/"requests":/);
  assert(!text.includes(auth.token));assert(!text.includes(request.context_token));assert(!text.includes(h.root));
  await h.receiver.accept(request,signal);await h.service.settle();assert.equal(sends.length,count);
  assert.equal(h.service.store.db.prepare("SELECT count(*) n FROM jobs WHERE kind='agent'").get()!.n,0);
  assert(!existsSync(path.join(h.c.codex.home,'capture.json')));
});
