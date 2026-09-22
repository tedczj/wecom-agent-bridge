import path from 'node:path';
import { existsSync } from 'node:fs';
import type { Writable } from 'node:stream';
import { preparePaths, type Config } from './config.ts';
import { acquireLock } from './fsutil.ts';
import { Store } from './store.ts';
import { MediaStore } from './media.ts';
import { CodexBackend } from './codex.ts';
import { PiBackend } from './pi.ts';
import { Bridge } from './bridge.ts';
import { LocalChannel, normalize } from './local.ts';
import { OutboxPump } from './reply.ts';
import { invariant, log } from './errors.ts';
import type { AgentBackend, Channel } from './types.ts';
export function createBackend(c: Config, media: MediaStore): AgentBackend {
  return c.backend === 'codex' ? new CodexBackend(c, image => media.read(image)) : new PiBackend(c, image => media.read(image));
}
export interface LocalService {
  store: Store; bridge: Bridge; channel: LocalChannel;
  accept(frame: unknown): Promise<{taskId?: string; duplicate?: boolean; rejected?: string}>;
  settle(): Promise<void>; stop(): Promise<void>;
}
export interface TransportAdapter {
  channel: Channel;
  normalize: typeof normalize;
  initialize(store: Store): Promise<void>;
}
export async function openService(c: Config, output: Writable, transport?: TransportAdapter): Promise<LocalService> {
  process.umask(0o077); preparePaths(c);
  invariant(c.agent.env.HOME && path.isAbsolute(c.agent.env.HOME), 'AGENT_HOME_REQUIRED');
  invariant(c.backend === 'codex' ? ['native','external'].includes(c.agent.isolation) : c.agent.isolation === 'external', 'WORKSPACE_ISOLATION_UNVERIFIED');
  const unlock = acquireLock(c.stateRoot);
  let store: Store | undefined, bridge: Bridge | undefined;
  let tick: ReturnType<typeof setInterval> | undefined, gc: ReturnType<typeof setInterval> | undefined;
  try {
    invariant(!existsSync(path.join(c.stateRoot, 'agent-process.json')), 'AGENT_PROCESS_REVIEW_REQUIRED');
    store = new Store(path.join(c.stateRoot, 'bridge.sqlite'), c);
    const oldTransport = store.db.prepare("SELECT value FROM metadata WHERE key='transport'").get() as {value:string} | undefined;
    invariant((oldTransport?.value ?? 'local') === c.transport || (!oldTransport && !store.db.prepare('SELECT 1 FROM jobs LIMIT 1').get()), 'STATE_TRANSPORT_MISMATCH');
    invariant(!!transport === (c.transport === 'weixin'), 'TRANSPORT_MISMATCH');
    store.db.prepare("INSERT OR IGNORE INTO metadata(key,value) VALUES ('transport',?)").run(c.transport);
    await transport?.initialize(store);
    const media = new MediaStore(c), channel = new LocalChannel(output), backend = createBackend(c, media);
    let channelId=`${c.transport}:${c.backend}`;
    if(c.routing) { channelId=store.value<string>('routing:channel') ?? channelId; store.put('routing:channel',channelId); }
    bridge = new Bridge(c, channelId, store, transport?.channel ?? channel, backend, media, transport?.normalize, target => createBackend(target, media));
    const outbox = new OutboxPump(store, transport?.channel ?? channel, c.reply);
    bridge.start(); await media.gc(store.activeMedia());
    tick = setInterval(() => void outbox.tick().catch(() => log('outbox.error', {code:'OUTBOX_FAILURE'})), 100);
    gc = setInterval(() => void media.gc(store!.activeMedia()).catch(() => log('media.gc_error', {code:'MEDIA_GC_FAILED'})), 3600000);
    let stopping: Promise<void> | undefined;
    const stop = () => stopping ??= (async () => {
      clearInterval(tick); clearInterval(gc);
      try {
        await bridge!.stop(); await outbox.idle(); await channel.flush();
        store!.close();
        invariant(!existsSync(path.join(c.stateRoot, 'agent-process.json')), 'AGENT_PROCESS_REVIEW_REQUIRED');
        unlock();
      } catch (e) { try { store!.close(); } catch {} throw e; }
    })();
    return { store, bridge, channel,
      accept: async frame => {
        const result = await bridge!.accept(frame);
        await channel.write({type:'accepted', ...result}); return result;
      },
      settle: async () => {
        await bridge!.idle(); await outbox.idle();
        while (await outbox.tick()) await outbox.idle();
        await channel.flush();
      }, stop,
    };
  } catch (e) {
    clearInterval(tick); clearInterval(gc);
    try { await bridge?.stop(); store?.close(); unlock(); } catch {}
    throw e;
  }
}
