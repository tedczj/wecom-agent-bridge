import { mkdtempSync, mkdirSync, rmSync, readFileSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { parseConfig, preparePaths, type Config } from '../src/config.ts';
import { normalize } from '../src/wecom.ts';
import type { AgentBackend, AgentResult, Channel, Incoming, NormalizedInput, Route, RunHooks, SessionRef } from '../src/types.ts';
export const bot = 'fixture-bot';
export function fixture(text = 'hello', id = randomUUID(), user = 'owner', group?: string): any {
    return { cmd: 'aibot_msg_callback', headers: { req_id: 'req-' + id }, body: { msgid: id, aibotid: bot, chattype: group ? 'group' : 'single', ...(group ? { chatid: group } : {}), from: { userid: user }, msgtype: 'text', text: { content: text } } };
}
export function setup(overrides: Record<string, unknown> = {}) {
    const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'wecom-bridge-test-')));
    const workspace = path.join(root, 'workspace');
    mkdirSync(workspace);
    const home = path.join(root, 'agent-home');
    mkdirSync(home);
    const base = { workspace: { id: 'fixture', path: workspace }, stateRoot: path.join(root, 'state'), wecom: { allowedUsers: ['owner', 'other'], allowedGroups: ['g1'], enableGroups: true, mediaAllowedHosts: ['cdn.example.com'] }, agent: { command: process.execPath, args: [path.resolve('tests/fakes/pi.mjs')], env: { HOME: home }, startupTimeoutMs: 1000, taskTimeoutMs: 2000, cancelGraceMs: 150, killGraceMs: 300, isolation: 'external' }, reply: { minIntervalMs: 0, sendTimeoutMs: 50 } };
    const raw = { ...base, ...overrides };
    const c = parseConfig(raw);
    preparePaths(c);
    return { root, c, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}
export function incoming(c: Config, text = 'hello', id = randomUUID(), user = 'owner', group?: string): Incoming { return normalize(fixture(text, id, user, group), c, bot); }
export function input(c: Config, text = 'hello'): NormalizedInput {
    const msg = incoming(c, text);
    return { taskId: randomUUID(), messageId: msg.messageId, route: msg.route, text, receivedAt: Date.now(), images: [], workspaceId: c.workspace.id, sessionKey: 'fixture-session', generation: 0 };
}
export function deferred<T = void>() { let resolve!: (value: T) => void; let reject!: (e: Error) => void; const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; }); return { promise, resolve, reject }; }
export async function until(fn: () => boolean, timeout = 3000): Promise<void> { const start = Date.now(); while (!fn()) {
    if (Date.now() - start > timeout)
        throw new Error('condition timed out');
    await sleep(5);
} }
export class FakeChannel implements Channel {
    ready = true;
    receipts: Array<{
        reqId: string;
        text: string;
    }> = [];
    sent: Array<{
        route: Route;
        text: string;
    }> = [];
    sendHook?: () => Promise<void>;
    async receipt(reqId: string, text: string) { this.receipts.push({ reqId, text }); }
    async send(route: Route, text: string) { this.sent.push({ route, text }); await this.sendHook?.(); }
}
export class FakeBackend implements AgentBackend {
    calls: NormalizedInput[] = [];
    active = 0;
    maxActive = 0;
    refs: Array<SessionRef | undefined> = [];
    handler?: (input: NormalizedInput, signal: AbortSignal) => Promise<AgentResult>;
    async start() { }
    async stop() { }
    async run(i: NormalizedInput, ref: SessionRef | undefined, h: RunHooks, s: AbortSignal): Promise<AgentResult> {
        this.calls.push(i);
        this.refs.push(ref);
        this.active++;
        this.maxActive = Math.max(this.maxActive, this.active);
        try {
            const next = ref ?? { kind: 'pi' as const, sessionId: randomUUID(), sessionFile: '/fixture/' + randomUUID(), hasHistory: true };
            await h.persistSession(next);
            return this.handler ? await this.handler(i, s) : { outcome: 'success', finalText: 'answer ' + i.text, sessionRef: next };
        }
        finally {
            this.active--;
        }
    }
}
export function records(file: string): any[] { try {
    return readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
}
catch {
    return [];
} }
