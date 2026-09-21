import path from 'node:path';
import { existsSync, readFileSync, accessSync, constants } from 'node:fs';
import { loadConfig, preparePaths } from './config.ts';
import { configArg } from './main.ts';
import { Store } from './store.ts';
import { acquireLock, clearStaleLock, processAlive } from './fsutil.ts';
import { errorCode, invariant } from './errors.ts';
async function cli(): Promise<void> {
    const args = process.argv.slice(2);
    const cmd = args[0];
    const c = loadConfig(configArg(args));
    preparePaths(c);
    const dbFile = path.join(c.stateRoot, 'bridge.sqlite');
    if (cmd === 'recover') {
        const i = args.indexOf('--ack-workspace');
        invariant(i >= 0 && args[i + 1] === c.workspace.id, 'RECOVERY_ACK_REQUIRED');
        invariant(args.includes('--processes-stopped') && args.includes('--diff-reviewed'), 'RECOVERY_REVIEW_REQUIRED');
        const marker = path.join(c.stateRoot, 'agent-process.json');
        if (existsSync(marker)) {
            const pid = JSON.parse(readFileSync(marker, 'utf8')).pid;
            invariant(Number.isSafeInteger(pid) && pid > 0 && !processAlive(-pid), 'AGENT_PROCESS_GROUP_STILL_ALIVE');
        }
        clearStaleLock(c.stateRoot);
        const unlock = acquireLock(c.stateRoot);
        try {
            const store = new Store(dbFile, c);
            try {
                store.recover();
                const reviewed = store.review();
                console.log(JSON.stringify({ reviewed, rerun: false, notice: '旧会话仍为 tainted；请用 /new 开始新会话。' }));
            }
            finally {
                store.close();
            }
        }
        finally {
            unlock();
        }
        return;
    }
    if (cmd === 'status') {
        if (!existsSync(dbFile)) {
            console.log(JSON.stringify({ initialized: false }));
            return;
        }
        const store = new Store(dbFile, c, true);
        try {
            console.log(JSON.stringify(store.summary(), null, 2));
        }
        finally {
            store.close();
        }
        return;
    }
    invariant(cmd === 'doctor', 'UNKNOWN_CLI_COMMAND');
    const checks: Record<string, unknown> = { configValid: true, storeWritable: false, singleInstance: true, wecomAuthenticated: 'unverified', piRpcReady: 'unverified', sessionRestore: 'unverified', imagesNative: 'unverified', workspaceIsolation: 'unverified', workspaceBlocked: false, mediaHostsReviewed: c.wecom.mediaAllowedHosts.length > 0 };
    try {
        accessSync(c.stateRoot, constants.W_OK);
        checks.storeWritable = true;
    }
    catch { }
    const lock = path.join(c.stateRoot, 'instance.lock');
    if (existsSync(lock)) {
        const pid = JSON.parse(readFileSync(lock, 'utf8')).pid;
        checks.singleInstance = Number.isSafeInteger(pid) && pid > 0 && processAlive(pid);
        const health = path.join(c.stateRoot, 'health.json');
        if (checks.singleInstance && existsSync(health)) {
            const h = JSON.parse(readFileSync(health, 'utf8'));
            if (h.pid === pid && h.workspaceId === c.workspace.id && Date.now() - h.writtenAt < 10000)
                for (const k of ['wecomAuthenticated', 'piRpcReady', 'sessionRestore', 'imagesNative', 'workspaceIsolation', 'workspaceBlocked'])
                    checks[k] = h[k] ?? 'unverified';
        }
    }
    if (existsSync(dbFile)) {
        const store = new Store(dbFile, c, true);
        try {
            checks.workspaceBlocked = store.blocked();
        }
        finally {
            store.close();
        }
    }
    const offline = checks.configValid === true && checks.storeWritable === true && checks.singleInstance === true && checks.workspaceBlocked === false;
    console.log(JSON.stringify({ mode: args.includes('--offline') ? 'offline' : 'readiness', checks, notice: 'offline 通过不代表真实企微/模型/隔离已验证。doctor 不建立 WebSocket，也不启动 Agent。' }, null, 2));
    // Native vision/isolation need explicit live/manual evidence; never infer from configuration.
    if (!offline || (!args.includes('--offline') && ['wecomAuthenticated', 'piRpcReady', 'sessionRestore', 'imagesNative', 'workspaceIsolation'].some(k => checks[k] !== true)))
        process.exitCode = 2;
}
void cli().catch(e => { console.error(JSON.stringify({ code: errorCode(e) })); process.exitCode = 1; });
