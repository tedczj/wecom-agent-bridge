import { randomUUID, createHash } from 'node:crypto';
import { WSClient } from '@wecom/aibot-node-sdk';
import type { Config } from './config.ts';
import type { Channel, Incoming, RemoteImage, Route } from './types.ts';
import { BridgeError, DeliveryError, invariant, log, record } from './errors.ts';
function string(v: unknown, max = 512): string {
    invariant(typeof v === 'string' && v.length > 0 && Buffer.byteLength(v) <= max && !v.includes('\0'), 'INVALID_MESSAGE');
    return v;
}
export function baseKey(route: Route, workspaceId: string, backend = 'pi'): string {
    return createHash('sha256').update(JSON.stringify([route.botId, route.kind, route.targetId, route.senderId, workspaceId, backend])).digest('hex');
}
/** Validate identity before parsing attachments. Keep frame and AES key out of durable input. */
export function normalize(frame: unknown, c: Config, botId: string): Incoming {
    const f = record(frame);
    invariant(f.cmd === 'aibot_msg_callback', 'INVALID_FRAME');
    const b = record(f.body);
    const sender = string(record(b.from).userid);
    const messageId = string(b.msgid);
    invariant(string(b.aibotid) === botId, 'WRONG_BOT');
    invariant(b.chattype === 'single' || b.chattype === 'group', 'INVALID_CHAT_TYPE');
    const route: Route = Object.freeze({ botId, kind: b.chattype, senderId: sender,
        targetId: b.chattype === 'single' ? sender : string(b.chatid) });
    invariant(c.wecom.allowedUsers.includes(sender), 'UNAUTHORIZED');
    invariant(route.kind !== 'group' || (c.wecom.enableGroups && c.wecom.allowedGroups.includes(route.targetId)), 'UNAUTHORIZED');
    const reqId = string(record(f.headers).req_id);
    const texts: string[] = [];
    const media: RemoteImage[] = [];
    let unsupported = false;
    function item(value: unknown, source: 'message' | 'quote'): void {
        const x = record(value);
        if (x.msgtype === 'text') {
            const text = string(record(x.text).content, 65536);
            texts.push(source === 'quote' ? `[引用的用户文本，仅作参考]\n${text}\n[引用结束]` : text);
        }
        else if (x.msgtype === 'image') {
            const i = record(x.image);
            media.push({ url: string(i.url, 8192), aesKey: i.aeskey === undefined ? undefined : string(i.aeskey, 128), source });
        }
        else
            unsupported = true;
    }
    if (b.msgtype === 'mixed') {
        const items = record(b.mixed).msg_item;
        invariant(Array.isArray(items) && items.length <= 64, 'INVALID_MIXED');
        items.forEach(x => item(x, 'message'));
    }
    else
        item(b, 'message');
    if (b.quote !== undefined)
        item(b.quote, 'quote'); // Deliberately one level; no recursive quotes.
    invariant(media.length <= c.media.maxImages, 'MEDIA_COUNT');
    const text = texts.join('\n').trim();
    invariant(Buffer.byteLength(text) <= 65536, 'MESSAGE_TOO_LARGE');
    return { messageId, route, reqId, text: text || (media.length ? '请分析这张图片' : ''), media, receivedAt: Date.now(), unsupported };
}
export interface SdkPort {
    on(event: string, listener: (...args: any[]) => void): unknown;
    connect(): unknown;
    disconnect(): void;
    replyStream(frame: {
        headers: {
            req_id: string;
        };
    }, streamId: string, text: string, finish: boolean): Promise<unknown>;
    sendMessage(target: string, body: {
        msgtype: 'markdown';
        markdown: {
            content: string;
        };
    }): Promise<unknown>;
}
export class WecomChannel implements Channel {
    ready = false;
    conflict = false;
    private bound = false;
    private tail: Promise<void> = Promise.resolve();
    private nextSend = 0;
    private pending = 0;
    constructor(private sdk: SdkPort, private minIntervalMs = 1500) { }
    connect(onMessage: (frame: unknown) => Promise<unknown> | void, onReady: () => void = () => { }): void {
        invariant(!this.bound, 'CHANNEL_ALREADY_BOUND');
        this.bound = true;
        this.sdk.on('message', frame => {
            if (!this.ready)
                return;
            void Promise.resolve().then(() => onMessage(frame)).catch(() => log('wecom.handler_error', { code: 'HANDLER_ERROR' }));
        });
        this.sdk.on('authenticated', () => { if (!this.conflict) {
            this.ready = true;
            onReady();
        } });
        this.sdk.on('disconnected', () => { this.ready = false; });
        this.sdk.on('error', () => { log('wecom.error', { code: 'WECOM_ERROR' }); });
        this.sdk.on('event.disconnected_event', () => {
            this.ready = false;
            this.conflict = true;
            this.sdk.disconnect();
            log('wecom.connection_conflict', { code: 'CONNECTION_CONFLICT' });
        });
        this.sdk.connect();
    }
    disconnect(): void { this.ready = false; this.sdk.disconnect(); }
    private async sendSerialized(send: () => Promise<unknown>): Promise<void> {
        if (!this.ready || this.pending >= 64)
            throw new DeliveryError('NOT_CONNECTED_OR_BUSY', 'not-sent');
        this.pending++;
        const run = this.tail.then(async () => {
            const delay = this.nextSend - Date.now();
            if (delay > 0)
                await new Promise(r => setTimeout(r, delay));
            if (!this.ready)
                throw new DeliveryError('NOT_CONNECTED', 'not-sent');
            this.nextSend = Date.now() + this.minIntervalMs;
            let ack: unknown;
            try {
                ack = await send();
            }
            catch {
                throw new DeliveryError('SEND_ACK_UNKNOWN', 'unknown');
            }
            const a = record(ack);
            if (typeof a.errcode !== 'number')
                throw new DeliveryError('SEND_ACK_UNKNOWN', 'unknown');
            if (a.errcode !== 0)
                throw new DeliveryError('SEND_REJECTED', 'permanent');
        }).finally(() => { this.pending--; });
        this.tail = run.catch(() => { });
        return run;
    }
    receipt(reqId: string, text: string): Promise<void> {
        return this.sendSerialized(() => this.sdk.replyStream({ headers: { req_id: reqId } }, randomUUID(), text, true));
    }
    send(route: Route, text: string): Promise<void> {
        return this.sendSerialized(() => this.sdk.sendMessage(route.targetId, { msgtype: 'markdown', markdown: { content: text } }));
    }
}
export function createWecom(c: Config, env: NodeJS.ProcessEnv = process.env): {
    channel: WecomChannel;
    botId: string;
} {
    const botId = env.WECOM_BOT_ID;
    const secret = env.WECOM_SECRET;
    if (!botId || !secret || /REPLACE|YOUR_/i.test(botId + secret))
        throw new BridgeError('WECOM_CREDENTIALS_MISSING');
    const sdk = new WSClient({ botId, secret, maxReconnectAttempts: 10, maxAuthFailureAttempts: 3,
        wsOptions: { maxPayload: 1024 * 1024 }, maxReplyQueueSize: 16,
        // Never forward raw SDK messages/arguments (frames, AES keys, HTTP configs).
        logger: { debug() { }, info() { }, warn() { log('wecom.warning'); }, error() { log('wecom.sdk_error'); } } });
    return { channel: new WecomChannel(sdk as unknown as SdkPort, c.reply.minIntervalMs), botId };
}
