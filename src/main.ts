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
import { supervised } from './maintenance.ts';
import type { AgentBackend, Channel } from './types.ts';
import { ControllerFactory, type ControllerToolResultAudit } from './controllers/factory.ts';
import { ControllerManager } from './controllers/manager.ts';
import { HierarchicalBridge } from './orchestration/engine.ts';
import { BusinessSessions } from './orchestration/business-sessions.ts';
import { sha256 } from './orchestration/requests.ts';
import { modelDigest } from './orchestration/config.ts';
import { ArtifactStore } from './answers/artifact-store.ts';
import { RecapService } from './answers/recap.ts';
import { CodexRecapModel } from './answers/codex-recap.ts';
import { NativeReader } from './history/reader.ts';
import { ResumeVerifier } from './history/verifier.ts';
import { CodexWriterReadiness } from './history/writer-readiness.ts';
import { initializeHierarchy } from './orchestration/schema.ts';
import { recoverHierarchyResources } from './orchestration/recover-resources.ts';
export function createBackend(c: Config, media: MediaStore, untrustedProject = !!c.orchestration): AgentBackend {
  return c.backend === 'codex' ? new CodexBackend(c, image => media.read(image), undefined, untrustedProject) : new PiBackend(c, image => media.read(image));
}
export interface LocalService {
  store: Store; bridge: Bridge | HierarchicalBridge; channel: LocalChannel;
  accept(frame: unknown): Promise<{taskId?: string; duplicate?: boolean; rejected?: string}>;
  settle(): Promise<void>; stop(): Promise<void>;
}
export interface TransportAdapter {
  channel: Channel;
  normalize: typeof normalize;
  initialize(store: Store): Promise<void>;
}
export async function openService(c: Config, output: Writable, transport?: TransportAdapter, businessClock: () => number = Date.now): Promise<LocalService> {
  let store: Store | undefined;
  const controllerFactory = c.orchestration ? await ControllerFactory.open(c, event => {
    if (event.requestId) {
      invariant(store, 'AUDIT_STORE_UNAVAILABLE');
      if (event.kind === 'prompt') store.put('controller-wire:' + event.role + ':' + event.requestId, event);
      else if (event.kind === 'policy') store.put('controller-policy-wire:' + event.role + ':' + event.requestId, event);
      else {
        const key = 'controller-tool-wire:' + event.role + ':' + event.requestId, rows = store.value<ControllerToolResultAudit[]>(key) ?? [];
        invariant(rows.length < c.orchestration!.limits.maxControllerDecisionsPerRequest, 'CONTROLLER_DECISION_LIMIT');
        store.put(key, [...rows, event]);
      }
    }
  }) : undefined;
  process.umask(0o077); preparePaths(c);
  invariant(c.agent.env.HOME && path.isAbsolute(c.agent.env.HOME), 'AGENT_HOME_REQUIRED');
  invariant(c.backend === 'codex' ? ['native','external'].includes(c.agent.isolation) : c.agent.isolation === 'external', 'WORKSPACE_ISOLATION_UNVERIFIED');
  if (c.orchestration) await recoverHierarchyResources(c.stateRoot);
  const unlock = acquireLock(c.stateRoot);
  let bridge: Bridge | HierarchicalBridge | undefined;
  let tick: ReturnType<typeof setInterval> | undefined, gc: ReturnType<typeof setInterval> | undefined;
  try {
    invariant(!existsSync(path.join(c.stateRoot, 'agent-process.json')), 'AGENT_PROCESS_REVIEW_REQUIRED');
    store = new Store(path.join(c.stateRoot, 'bridge.sqlite'), c);
    if (c.orchestration) initializeHierarchy(store);
    const oldTransport = store.db.prepare("SELECT value FROM metadata WHERE key='transport'").get() as {value:string} | undefined;
    invariant((oldTransport?.value ?? 'local') === c.transport || (!oldTransport && !store.db.prepare('SELECT 1 FROM jobs LIMIT 1').get()), 'STATE_TRANSPORT_MISMATCH');
    invariant(!!transport === (c.transport === 'weixin'), 'TRANSPORT_MISMATCH');
    store.db.prepare("INSERT OR IGNORE INTO metadata(key,value) VALUES ('transport',?)").run(c.transport);
    await transport?.initialize(store);
    const media = new MediaStore(c), channel = new LocalChannel(output), backend = createBackend(c, media);
    let channelId=`${c.transport}:${c.backend}`;
    if(c.routing) { channelId=store.value<string>('routing:channel') ?? channelId; store.put('routing:channel',channelId); }
    if (controllerFactory && c.orchestration) {
      const homeKey = sha256(JSON.stringify(['codex', c.orchestration.controllerRuntime.home]));
      const controllers = new ControllerManager(store, (actor, model) => controllerFactory.create(actor.role, actor.controller_id, model), homeKey);
      const sessions = new BusinessSessions(store, controllers.registry, new ResumeVerifier(new NativeReader(), new CodexWriterReadiness()), businessClock);
      const artifacts = new ArtifactStore(store, c.orchestration.answers.root, c.orchestration.answers.maxOriginalBytes);
      const recapProfile = c.models![c.orchestration.answers.recapModelProfile]!;
      const recaps = new RecapService(store, artifacts, new CodexRecapModel(store, controllerFactory, recapProfile, homeKey), modelDigest(recapProfile),
        c.orchestration.answers.shortAnswerMaxChars, c.orchestration.answers.recapMaxChars);
      bridge = new HierarchicalBridge(c, channelId, store, transport?.channel ?? channel, media,
        { controllers, sessions, artifacts, recaps, backend: target => createBackend(target, media, true) }, transport?.normalize);
    } else bridge = new Bridge(c, channelId, store, transport?.channel ?? channel, backend, media, transport?.normalize, target => createBackend(target, media));
    const outbox = new OutboxPump(store, transport?.channel ?? channel, c.reply);
    await bridge.start(); await media.gc(store.activeMedia());
    if(supervised(c))process.send?.({type:'bridge-ready'});
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
