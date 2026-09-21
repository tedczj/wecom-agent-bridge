import { readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { invariant, record } from './errors.ts';
import { inside, privateDirectory } from './fsutil.ts';
export interface Config {
    backend: 'pi';
    workspace: {
        id: string;
        path: string;
    };
    stateRoot: string;
    wecom: {
        allowedUsers: string[];
        allowedGroups: string[];
        enableGroups: boolean;
        mediaAllowedHosts: string[];
    };
    queue: {
        maxActive: 1;
        maxPendingPerSession: number;
        maxPendingGlobal: number;
    };
    media: {
        maxImages: number;
        maxImageBytes: number;
        maxTotalBytes: number;
        maxPixels: number;
        maxTotalPixels: number;
        downloadTimeoutMs: number;
        retentionHours: number;
    };
    agent: {
        command: string;
        args: string[];
        env: Record<string, string>;
        sessionRoot: string;
        startupTimeoutMs: number;
        taskTimeoutMs: number;
        cancelGraceMs: number;
        killGraceMs: number;
        maxFrameBytes: number;
        isolation: 'unverified' | 'external';
    };
    reply: {
        chunkBytes: number;
        minIntervalMs: number;
        maxAutoParts: number;
        maxResultBytes: number;
        sendTimeoutMs: number;
    };
    ocr: {
        mode: 'off';
    };
}
function strict(v: unknown, keys: string[]): Record<string, unknown> {
    const o = record(v);
    invariant(Object.keys(o).every(k => keys.includes(k)), 'CONFIG_UNKNOWN_KEY');
    return o;
}
function str(v: unknown): string { invariant(typeof v === 'string' && v.length > 0 && v.length < 4096 && !v.includes('\0'), 'CONFIG_STRING'); return v; }
function list(v: unknown): string[] { invariant(Array.isArray(v), 'CONFIG_LIST'); return v.map(str); }
function integer(v: unknown, d: number, min: number, max: number): number {
    const n = v ?? d;
    invariant(typeof n === 'number' && Number.isSafeInteger(n) && n >= min && n <= max, 'CONFIG_NUMBER');
    return n;
}
function absolute(v: unknown): string { const p = str(v); invariant(path.isAbsolute(p) && !p.includes('/absolute/path/'), 'CONFIG_PATH'); return path.resolve(p); }
function boolean(v: unknown, fallback: boolean): boolean { invariant(v === undefined || typeof v === 'boolean', 'CONFIG_BOOLEAN'); return (v ?? fallback) as boolean; }
export function parseConfig(value: unknown): Config {
    const c = strict(value, ['backend', 'workspace', 'stateRoot', 'wecom', 'queue', 'media', 'agent', 'reply', 'ocr']);
    invariant((c.backend ?? 'pi') === 'pi', 'BACKEND_NOT_IMPLEMENTED');
    const w = strict(c.workspace, ['id', 'path']);
    const stateRoot = absolute(c.stateRoot);
    const workspace = { id: str(w.id), path: absolute(w.path) };
    invariant(/^[a-zA-Z0-9_-]{1,64}$/.test(workspace.id), 'WORKSPACE_ID');
    invariant(!inside(workspace.path, stateRoot) && !inside(stateRoot, workspace.path), 'STATE_WORKSPACE_OVERLAP');
    const wc = strict(c.wecom, ['allowedUsers', 'allowedGroups', 'enableGroups', 'mediaAllowedHosts']);
    const allowedUsers = list(wc.allowedUsers);
    invariant(allowedUsers.length > 0 && allowedUsers.every(x => !/REPLACE|YOUR_|\*/i.test(x)), 'EMPTY_OR_PLACEHOLDER_ALLOWLIST');
    const hosts = list(wc.mediaAllowedHosts ?? []).map(h => h.toLowerCase());
    invariant(hosts.every(h => /^(?!-)[a-z0-9.-]+$/.test(h) && h.includes('.') && !h.endsWith('.')), 'MEDIA_HOST_CONFIG');
    const q = strict(c.queue ?? {}, ['maxActive', 'maxPendingPerSession', 'maxPendingGlobal']);
    invariant((q.maxActive ?? 1) === 1, 'CONCURRENCY_MUST_BE_ONE');
    const m = strict(c.media ?? {}, ['maxImages', 'maxImageBytes', 'maxTotalBytes', 'maxPixels', 'maxTotalPixels', 'downloadTimeoutMs', 'retentionHours']);
    const a = strict(c.agent, ['command', 'args', 'env', 'sessionRoot', 'startupTimeoutMs', 'taskTimeoutMs', 'cancelGraceMs', 'killGraceMs', 'maxFrameBytes', 'isolation']);
    const args = list(a.args ?? []);
    invariant(!args.includes('--no-session') && !args.includes('--continue') && !args.includes('-c'), 'UNSAFE_SESSION_FLAGS');
    const env = record(a.env ?? {});
    invariant(Object.entries(env).every(([k, v]) => /^[A-Z_][A-Z0-9_]*$/.test(k) && !/^WECOM_|^NODE_OPTIONS$|^LD_|^DYLD_/i.test(k) && typeof v === 'string'), 'UNSAFE_AGENT_ENV');
    const r = strict(c.reply ?? {}, ['chunkBytes', 'minIntervalMs', 'maxAutoParts', 'maxResultBytes', 'sendTimeoutMs']);
    const o = strict(c.ocr ?? {}, ['mode']);
    invariant((o.mode ?? 'off') === 'off', 'OCR_NOT_IMPLEMENTED');
    invariant(a.isolation === undefined || a.isolation === 'unverified' || a.isolation === 'external', 'CONFIG_ISOLATION');
    const sessionRoot = absolute(a.sessionRoot ?? path.join(stateRoot, 'agent-sessions'));
    invariant(!inside(workspace.path, sessionRoot), 'SESSIONS_IN_WORKSPACE');
    return {
        backend: 'pi', workspace, stateRoot,
        wecom: { allowedUsers, allowedGroups: list(wc.allowedGroups ?? []), enableGroups: boolean(wc.enableGroups, false), mediaAllowedHosts: hosts },
        queue: { maxActive: 1, maxPendingPerSession: integer(q.maxPendingPerSession, 3, 1, 100), maxPendingGlobal: integer(q.maxPendingGlobal, 20, 1, 1000) },
        media: { maxImages: integer(m.maxImages, 4, 1, 4), maxImageBytes: integer(m.maxImageBytes, 10 * 1024 * 1024, 64, 20 * 1024 * 1024), maxTotalBytes: integer(m.maxTotalBytes, 20 * 1024 * 1024, 64, 40 * 1024 * 1024), maxPixels: integer(m.maxPixels, 20000000, 1, 40000000), maxTotalPixels: integer(m.maxTotalPixels, 40000000, 1, 80000000), downloadTimeoutMs: integer(m.downloadTimeoutMs, 20000, 1, 60000), retentionHours: integer(m.retentionHours, 24, 1, 168) },
        agent: { command: absolute(a.command), args, env: env as Record<string, string>, sessionRoot,
            startupTimeoutMs: integer(a.startupTimeoutMs, 30000, 1, 120000), taskTimeoutMs: integer(a.taskTimeoutMs, 900000, 1, 3600000), cancelGraceMs: integer(a.cancelGraceMs, 5000, 1, 30000), killGraceMs: integer(a.killGraceMs, 2000, 1, 10000), maxFrameBytes: integer(a.maxFrameBytes, 8 * 1024 * 1024, 256, 64 * 1024 * 1024), isolation: (a.isolation ?? 'unverified') as 'external' | 'unverified' },
        reply: { chunkBytes: integer(r.chunkBytes, 3500, 128, 3500), minIntervalMs: integer(r.minIntervalMs, 1500, 0, 60000), maxAutoParts: integer(r.maxAutoParts, 3, 1, 20), maxResultBytes: integer(r.maxResultBytes, 1048576, 128, 1048576), sendTimeoutMs: integer(r.sendTimeoutMs, 15000, 1, 60000) },
        ocr: { mode: 'off' },
    };
}
export function loadConfig(file: string): Config { return parseConfig(JSON.parse(readFileSync(file, 'utf8'))); }
export function preparePaths(c: Config): void {
    invariant(statSync(c.workspace.path).isDirectory(), 'WORKSPACE_MISSING');
    c.workspace.path = realpathSync(c.workspace.path);
    c.stateRoot = privateDirectory(c.stateRoot);
    invariant(!inside(c.workspace.path, c.stateRoot) && !inside(c.stateRoot, c.workspace.path), 'STATE_WORKSPACE_OVERLAP');
    c.agent.sessionRoot = privateDirectory(c.agent.sessionRoot);
    invariant(!inside(c.workspace.path, c.agent.sessionRoot), 'SESSIONS_IN_WORKSPACE');
}
/** No process.env spread. HOME must belong to the audited Agent security domain. */
export function agentEnvironment(c: Config, host: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
    return { PATH: host.PATH ?? '/usr/bin:/bin', LANG: 'C.UTF-8', ...c.agent.env };
}
