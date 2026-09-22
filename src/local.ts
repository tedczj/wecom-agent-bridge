import { createHash } from 'node:crypto';
import type { Writable } from 'node:stream';
import path from 'node:path';
import type { Config } from './config.ts';
import type { Channel, Incoming, Route } from './types.ts';
import { DeliveryError, invariant, record } from './errors.ts';
export function baseKey(route: Route, workspaceId: string, backend: string): string {
  return createHash('sha256').update(JSON.stringify([route.channelId, route.kind, route.targetId, route.senderId, workspaceId, backend])).digest('hex');
}
function identifier(value: unknown): string {
  invariant(typeof value === 'string' && /^[a-zA-Z0-9_.:-]{1,128}$/.test(value), 'INPUT_ID'); return value;
}
/** Only trusted local stdin is accepted. There is no HTTP listener, webhook, login or remote user field. */
export function normalize(frame: unknown, c: Config, channelId: string): Incoming {
  const f = record(frame);
  invariant(Object.keys(f).every(k => ['id', 'session', 'text', 'images'].includes(k)), 'INPUT_UNKNOWN_KEY');
  const messageId = identifier(f.id), session = identifier(f.session ?? 'default');
  invariant(typeof f.text === 'string' && Buffer.byteLength(f.text) <= 65536 && !f.text.includes('\0'), 'INPUT_TEXT');
  const raw = f.images ?? []; invariant(Array.isArray(raw) && raw.length <= c.media.maxImages, 'MEDIA_COUNT');
  const media = raw.map(value => {
    invariant(typeof value === 'string' && value.length < 4096 && !value.includes('\0') && path.isAbsolute(value), 'MEDIA_PATH');
    return { path: path.resolve(value), source: 'message' as const };
  });
  invariant(f.text.trim() || media.length, 'EMPTY_INPUT');
  // Commands cannot smuggle ignored attachments into the control path.
  invariant(!f.text.trim().startsWith('/') || media.length === 0, 'COMMAND_IMAGES');
  const route: Route = { channelId, kind: 'local', targetId: session, senderId: c.local.actorId };
  return { messageId, route, reqId: messageId, text: f.text.trim() || '请分析这张图片', media, receivedAt: Date.now() };
}
export class LocalChannel implements Channel {
  ready = true;
  private tail = Promise.resolve();
  private pending = 0;
  constructor(private output: Writable) { output.on('error', () => { this.ready = false; }); }
  write(value: unknown): Promise<void> {
    if (!this.ready || this.pending >= 128) return Promise.reject(new DeliveryError('LOCAL_OUTPUT_UNAVAILABLE', 'not-sent'));
    this.pending++;
    const run = this.tail.then(() => new Promise<void>((resolve, reject) => {
      if (!this.ready) { reject(new DeliveryError('LOCAL_OUTPUT_UNAVAILABLE', 'not-sent')); return; }
      this.output.write(JSON.stringify(value) + '\n', error => {
        if (error) { this.ready = false; reject(new DeliveryError('LOCAL_OUTPUT_UNKNOWN', 'unknown')); } else resolve();
      });
    })).finally(() => { this.pending--; });
    this.tail = run.catch(() => {}); return run;
  }
  receipt(reqId: string, text: string): Promise<void> { return this.write({ type: 'receipt', id: reqId, text }); }
  send(route: Route, text: string, taskId?: string): Promise<void> {
    return this.write({ type: 'result', taskId, session: route.targetId, text });
  }
  async flush(): Promise<void> { await this.tail; }
}
