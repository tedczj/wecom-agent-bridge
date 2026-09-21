import path from 'node:path';
import { writeFileSync, renameSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { loadConfig, preparePaths, type Config } from './config.ts';
import { acquireLock } from './fsutil.ts';
import { Store } from './store.ts';
import { createWecom } from './wecom.ts';
import { MediaStore } from './media.ts';
import { PiBackend } from './pi.ts';
import { Bridge } from './bridge.ts';
import { OutboxPump } from './reply.ts';
import { errorCode, invariant, log } from './errors.ts';
export function configArg(args = process.argv.slice(2)): string {
    const i = args.indexOf('--config');
    invariant(i >= 0 && args[i + 1], 'CONFIG_ARGUMENT_REQUIRED');
    return args[i + 1]!;
}
export async function runService(c: Config): Promise<() => Promise<void>> {
    process.umask(0o077);
    preparePaths(c);
    invariant(c.agent.isolation === 'external', 'WORKSPACE_ISOLATION_UNVERIFIED');
    invariant(c.agent.env.HOME && path.isAbsolute(c.agent.env.HOME), 'AGENT_HOME_REQUIRED');
    const unlock = acquireLock(c.stateRoot);
    let store: Store | undefined;
    let bridge: Bridge | undefined;
    let channel: ReturnType<typeof createWecom>['channel'] | undefined;
    let tick: ReturnType<typeof setInterval> | undefined;
    let health: ReturnType<typeof setInterval> | undefined;
    let gc: ReturnType<typeof setInterval> | undefined;
    try {
        store = new Store(path.join(c.stateRoot, 'bridge.sqlite'), c);
        const media = new MediaStore(c);
        const backend = new PiBackend(c, img => media.read(img));
        const link = createWecom(c);
        channel = link.channel;
        bridge = new Bridge(c, link.botId, store, channel, backend, media);
        const outbox = new OutboxPump(store, channel, c.reply);
        bridge.start();
        channel.connect(frame => bridge!.accept(frame));
        tick = setInterval(() => void outbox.tick().catch(() => log('outbox.error', { code: 'OUTBOX_FAILURE' })), 100);
        const writeHealth = () => {
            const content = { pid: process.pid, writtenAt: Date.now(), workspaceId: c.workspace.id, workspaceBlocked: store!.blocked(), wecomAuthenticated: channel!.ready, connectionConflict: channel!.conflict, piRpcReady: backend.lastHandshakeAt ? 'observed' : 'unverified', agentSettled: backend.settledSeen ? 'observed' : 'unverified', sessionRestore: backend.restoredSession ? 'observed' : 'unverified', imagesNative: 'unverified', imageBytesSent: backend.imageBytesSent, workspaceIsolation: 'operator-attested' };
            const file = path.join(c.stateRoot, 'health.json');
            writeFileSync(file + '.part', JSON.stringify(content), { mode: 0o600 });
            renameSync(file + '.part', file);
        };
        writeHealth();
        health = setInterval(() => { try {
            writeHealth();
        }
        catch {
            log('health.error', { code: 'HEALTH_WRITE_FAILED' });
        } }, 2000);
        await media.gc(store.activeMedia());
        gc = setInterval(() => void media.gc(store!.activeMedia()).catch(() => log('media.gc_error', { code: 'MEDIA_GC_FAILED' })), 3600000);
        log('bridge.started', { state: store.blocked() ? 'blocked' : 'ready' });
        let closing = false;
        return async () => {
            if (closing)
                return;
            closing = true;
            clearInterval(tick);
            clearInterval(health);
            clearInterval(gc);
            channel!.disconnect();
            try {
                await bridge!.stop();
                store!.close();
                unlock();
            }
            catch (e) {
                try {
                    store!.close();
                }
                catch { }
                ; /* Keep the lock for explicit operator recovery. */
                throw e;
            }
        };
    }
    catch (e) {
        clearInterval(tick);
        clearInterval(health);
        clearInterval(gc);
        channel?.disconnect();
        try {
            await bridge?.stop();
            store?.close();
            unlock();
        }
        catch { /* Keep stale lock on uncertain cleanup. */ }
        throw e;
    }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
    try {
        const stop = await runService(loadConfig(configArg()));
        let stopping = false;
        const shutdown = () => { if (stopping)
            return; stopping = true; void stop().then(() => process.exit(0)).catch(e => { log('shutdown.failed', { code: errorCode(e) }); process.exit(1); }); };
        process.once('SIGTERM', shutdown);
        process.once('SIGINT', shutdown);
    }
    catch (e) {
        log('startup.failed', { code: errorCode(e) });
        process.exitCode = 1;
    }
}
