import { createHash, randomUUID } from 'node:crypto';
import { rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import type { Writable } from 'node:stream';
import type { Config } from './config.ts';
import type { Channel, Incoming, Route } from './types.ts';
import { BridgeError, DeliveryError, errorCode, invariant, log, record } from './errors.ts';
import { privateDirectory } from './fsutil.ts';
import { openService, type LocalService } from './main.ts';
import type { Store } from './store.ts';
import { WeixinApi, field, type WeixinAuth } from './weixin-api.ts';
import { loadOrLogin } from './weixin-login.ts';
import { downloadImage } from './weixin-media.ts';

export function normalizeWeixin(value: unknown, auth: WeixinAuth, c: Config): {incoming: Incoming; images: Record<string,unknown>[]; context: string; unsupported?: string} {
  const msg = record(value);
  invariant(msg.message_type === 1 && (msg.message_state === undefined || msg.message_state === 2), 'WEIXIN_NOT_USER_MESSAGE');
  invariant(!msg.group_id && msg.from_user_id === auth.userId, 'WEIXIN_UNAUTHORIZED');
  invariant(!msg.to_user_id || msg.to_user_id === auth.botId, 'WEIXIN_WRONG_BOT');
  const context = field(msg.context_token), messageId = field(msg.message_id,256);
  invariant(Array.isArray(msg.item_list) && msg.item_list.length > 0 && msg.item_list.length <= 64, 'WEIXIN_ITEMS');
  const texts: string[] = [], images: Record<string,unknown>[] = []; let unsupported: string | undefined;
  for (const value of msg.item_list) {
    const item = record(value);
    if (item.type === 1) texts.push(field(record(item.text_item).text,65536));
    else if (item.type === 2) images.push(record(item.image_item));
    else if (item.type === 3) {
      const text = record(item.voice_item).text;
      if (typeof text === 'string' && text.trim()) texts.push(field(text,65536));
      else unsupported = 'WEIXIN_VOICE_TRANSCRIPT_MISSING';
    } else unsupported = 'WEIXIN_MEDIA_UNSUPPORTED';
    // Do not silently act on a reply whose quoted context was omitted.
    if (item.ref_msg) unsupported = 'WEIXIN_QUOTE_UNSUPPORTED';
  }
  invariant(images.length <= c.media.maxImages, 'MEDIA_COUNT');
  const text = texts.join('\n').trim() || (images.length ? '请分析这张图片' : '[不支持的微信消息]');
  invariant(Buffer.byteLength(text) <= 65536, 'INPUT_TEXT');
  invariant(!text.startsWith('/') || images.length === 0, 'COMMAND_IMAGES');
  return {context, images, unsupported, incoming:{messageId,reqId:messageId,text,media:[],receivedAt:Date.now(),
    route:{channelId:`weixin:${auth.botId}`,kind:'weixin',targetId:auth.userId,senderId:auth.userId}}};
}
function getMeta(store: Store, key: string): string | undefined {
  return (store.db.prepare('SELECT value FROM metadata WHERE key=?').get(key) as {value:string} | undefined)?.value;
}
function setMeta(store: Store, key: string, value: string): void {
  store.db.prepare('INSERT INTO metadata(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key,value);
}
export class WeixinChannel implements Channel {
  ready = false;
  auth!: WeixinAuth;
  store!: Store;
  constructor(readonly api: WeixinApi) {}
  async receipt(): Promise<void> {} // Final/control replies use the durable outbox.
  async send(route: Route, text: string): Promise<void> {
    if (!this.ready) throw new DeliveryError('WEIXIN_OFFLINE','not-sent');
    if (route.kind !== 'weixin' || route.channelId !== `weixin:${this.auth.botId}` || route.targetId !== this.auth.userId || route.senderId !== this.auth.userId)
      throw new DeliveryError('WEIXIN_ROUTE_MISMATCH','permanent');
    const context = getMeta(this.store,'weixin:context');
    if (!context) throw new DeliveryError('WEIXIN_CONTEXT_MISSING','not-sent');
    try {
      await this.api.bot('sendmessage',{msg:{from_user_id:'',to_user_id:route.targetId,client_id:randomUUID(),
        message_type:2,message_state:2,context_token:context,item_list:[{type:1,text_item:{text}}]}},this.auth,undefined,10000);
    } catch (e) {
      const code = errorCode(e,'WEIXIN_SEND_UNKNOWN');
      throw new DeliveryError(code,['WEIXIN_AUTH_EXPIRED','WEIXIN_API_REJECTED'].includes(code) ? 'permanent' : 'unknown');
    }
  }
}
export class WeixinReceiver {
  constructor(private c: Config, private service: LocalService, private channel: WeixinChannel) {}
  async accept(value: unknown, signal: AbortSignal): Promise<void> {
    let message: ReturnType<typeof normalizeWeixin>;
    try { message = normalizeWeixin(value,this.channel.auth,this.c); }
    catch(e) { log('weixin.message_rejected',{code:errorCode(e)}); return; }
    const {incoming,images,context,unsupported} = message, store = this.service.store;
    setMeta(store,'weixin:context',context);
    const stage = path.join(this.c.stateRoot,'weixin-incoming',createHash('sha256').update(incoming.messageId).digest('hex'));
    incoming.media = images.map((_,i) => ({path:path.join(stage,`image-${i}`),source:'message'}));
    const previous = store.db.prepare('SELECT task_id FROM jobs WHERE channel_id=? AND message_id=?').get(incoming.route.channelId,incoming.messageId);
    if (previous) {
      // Validate duplicate input without redownloading or re-executing it.
      await this.service.bridge.accept(incoming); return;
    }
    const fail = (code: string) => {
      const {job,duplicate} = store.reserve(incoming,'command'); if (duplicate) return;
      const text = code === 'WEIXIN_VOICE_TRANSCRIPT_MISSING' ? '这条语音没有附带转写文本，当前未配置额外语音识别。请在微信转成文字后发送。'
        : code === 'WEIXIN_MEDIA_UNSUPPORTED' ? '当前支持文字、图片和带转写文本的语音；暂不支持文件或视频。'
        : code === 'WEIXIN_QUOTE_UNSUPPORTED' ? '当前暂不处理引用消息，请把需要分析的内容直接发送。'
        : `消息未执行（${code}），请检查本地 bridge。`;
      store.complete(job.task_id,'failed',text,code);
    };
    if (unsupported) { fail(unsupported); return; }
    try {
      if (images.length) {
        privateDirectory(stage); let total = 0;
        for (const [i,image] of images.entries()) {
          const bytes = await downloadImage(image,this.c.media.maxImageBytes,signal);
          total += bytes.length; invariant(total <= this.c.media.maxTotalBytes,'MEDIA_SIZE');
          writeFileSync(incoming.media[i]!.path,bytes,{mode:0o600,flag:'wx'});
        }
      }
      const result = await this.service.bridge.accept(incoming);
      if (result.rejected) { fail(result.rejected); return; }
      // MediaStore copies and fully validates input before staged files disappear.
      if (result.taskId) while (store.get(result.taskId).status === 'preparing') await sleep(10,undefined,{signal});
      log('weixin.accepted',{taskId:result.taskId});
    } catch(e) {
      if (signal.aborted) throw e;
      if (!(e instanceof BridgeError)) throw e;
      fail(errorCode(e));
    } finally { rmSync(stage,{recursive:true,force:true}); }
  }
  async poll(signal: AbortSignal): Promise<void> {
    const store = this.service.store;
    const data = await this.channel.api.bot('getupdates',{get_updates_buf:getMeta(store,'weixin:cursor') ?? ''},this.channel.auth,signal,40000);
    const messages = data.msgs ?? [];
    invariant(Array.isArray(messages) && messages.length <= 1000,'WEIXIN_UPDATES');
    for (const msg of messages) { signal.throwIfAborted(); await this.accept(msg,signal); }
    if (data.get_updates_buf !== undefined && data.get_updates_buf !== '') setMeta(store,'weixin:cursor',field(data.get_updates_buf,1048576));
  }
}
export async function runWeixin(c: Config, output: Writable, signal: AbortSignal, api = new WeixinApi()): Promise<void> {
  invariant(c.transport === 'weixin','TRANSPORT_MISMATCH');
  // Keep chunks below the messaging endpoint's practical text budget.
  c.reply.chunkBytes = Math.min(c.reply.chunkBytes,3500);
  c.reply.minIntervalMs = Math.max(c.reply.minIntervalMs,1000);
  const channel = new WeixinChannel(api);
  const service = await openService(c,output,{channel,
    normalize:frame => frame as Incoming,
    initialize:async store => {
      channel.store = store; channel.auth = await loadOrLogin(c.stateRoot,api,signal);
      const identity = JSON.stringify([channel.auth.botId,channel.auth.userId]);
      invariant(!getMeta(store,'weixin:identity') || getMeta(store,'weixin:identity') === identity,'WEIXIN_ACCOUNT_MISMATCH');
      setMeta(store,'weixin:identity',identity);
      const stage = path.join(c.stateRoot,'weixin-incoming'); privateDirectory(stage); rmSync(stage,{recursive:true,force:true});
      channel.ready = true;
    }});
  const stop = () => { void service.bridge.stop().catch(() => log('weixin.stop_failed')); };
  signal.addEventListener('abort',stop,{once:true});
  try {
    signal.throwIfAborted();
    process.stderr.write(`微信接收已启动，工作目录：${c.workspace.path}\n请在手机微信 ClawBot 私聊中发消息。\n`);
    const receiver = new WeixinReceiver(c,service,channel);
    while (!signal.aborted) {
      try { await receiver.poll(signal); }
      catch(e) {
        if (signal.aborted) break;
        const code = errorCode(e); log('weixin.poll_failed',{code});
        if (code === 'WEIXIN_AUTH_EXPIRED') throw e;
        // Only transport failures may retry; persistence failures stop intake.
        if (!['WEIXIN_REQUEST_FAILED','WEIXIN_REQUEST_ABORTED','WEIXIN_HTTP_ERROR','WEIXIN_API_REJECTED'].includes(code)) throw e;
        await sleep(2000,undefined,{signal});
      }
      await sleep(100,undefined,{signal});
    }
  } finally { signal.removeEventListener('abort',stop); await service.stop(); channel.ready = false; }
}
