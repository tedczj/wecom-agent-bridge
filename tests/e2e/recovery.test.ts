import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, writeFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { Store } from '../../src/store.ts';
import { Bridge } from '../../src/bridge.ts';
import { MediaStore } from '../../src/media.ts';
import { OutboxPump } from '../../src/reply.ts';
import { deadline } from '../../src/async.ts';
import { setup, bot, FakeBackend, FakeChannel, fixture } from '../helpers.ts';
async function crash(t: TestContext, stage: string) {
    const x = setup();
    const cfg = path.join(x.root, 'config.json');
    writeFileSync(cfg, JSON.stringify(x.c));
    const child = spawn(process.execPath, [path.resolve('tests/fakes/crash.mjs'), cfg, stage], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', b => { stderr += b; });
    const exited = once(child, 'exit');
    t.after(() => { if (child.exitCode === null && child.signalCode === null)
        child.kill('SIGKILL'); });
    await deadline(new Promise<void>((resolve, reject) => { let stdout = ''; child.stdout.on('data', b => { stdout += b; if (stdout.includes('READY\n'))
        resolve(); }); child.once('error', reject); child.once('exit', () => reject(new Error('child exited before READY: ' + stderr))); }), 3000, 'CRASH_READY_TIMEOUT');
    child.kill('SIGKILL');
    const [, signal] = await exited;
    assert.equal(signal, 'SIGKILL');
    const store = new Store(path.join(x.c.stateRoot, 'bridge.sqlite'), x.c);
    t.after(() => { store.close(); x.cleanup(); });
    const info = JSON.parse(readFileSync(path.join(x.c.stateRoot, 'crash-info.json'), 'utf8')) as {
        id: string;
        frame: unknown;
    };
    return { ...x, store, info };
}
test('R01: SIGKILL while preparing -> explicit failure and orphan .part cleanup', async (t) => { const h = await crash(t, 'preparing'); h.store.recover(); assert.equal(h.store.get(h.info.id).status, 'failed'); assert.equal(h.store.get(h.info.id).error_code, 'MEDIA_PREPARATION_INTERRUPTED'); const media = new MediaStore(h.c); await media.gc(h.store.activeMedia()); assert(!existsSync(path.join(media.root, h.info.id))); });
test('R02: SIGKILL with queued complete input -> exactly one safe execution after restart', async (t) => { const h = await crash(t, 'queued'); const backend = new FakeBackend(), channel = new FakeChannel(), media = new MediaStore(h.c); const bridge = new Bridge(h.c, bot, h.store, channel, backend, media); bridge.start(); await bridge.idle(); assert.equal(backend.calls.length, 1); assert.equal(h.store.get(h.info.id).status, 'succeeded'); assert((await bridge.accept(h.info.frame)).duplicate); await bridge.idle(); assert.equal(backend.calls.length, 1); await bridge.stop(); });
test('R03: SIGKILL after a workspace modification -> interrupted, tainted, blocked, no rerun', async (t) => { const h = await crash(t, 'running'); const backend = new FakeBackend(), channel = new FakeChannel(); const bridge = new Bridge(h.c, bot, h.store, channel, backend, new MediaStore(h.c)); bridge.start(); await bridge.idle(); assert.equal(h.store.get(h.info.id).status, 'interrupted'); assert.equal(h.store.session(h.store.get(h.info.id).session_key).state, 'tainted'); assert(h.store.blocked()); assert.equal(backend.calls.length, 0); assert.equal(readFileSync(path.join(h.c.workspace.path, 'changed.txt'), 'utf8'), 'SIDE EFFECT ALREADY HAPPENED'); assert.equal((await bridge.accept(fixture('new'))).rejected, 'WORKSPACE_BLOCKED'); const reset = await bridge.accept(fixture('/new')); assert.equal(h.store.get(reset.taskId!).status, 'failed'); assert.equal(h.store.review(), 1); assert(!h.store.blocked()); assert.equal(h.store.session(h.store.get(h.info.id).session_key).state, 'tainted'); await bridge.stop(); });
test('R04: SIGKILL inside result transaction rolls back status and result atomically', async (t) => { const h = await crash(t, 'transaction'); assert.equal(h.store.get(h.info.id).status, 'running'); assert.equal(h.store.get(h.info.id).result_text, null); assert.equal((h.store.db.prepare('SELECT count(*) n FROM outbox').get() as any).n, 0); h.store.recover(); assert.equal(h.store.get(h.info.id).status, 'interrupted'); assert(h.store.blocked()); });
test('R05: SIGKILL after result+outbox commit -> delivery only, no Agent execution', async (t) => { const h = await crash(t, 'pending'); const backend = new FakeBackend(), channel = new FakeChannel(); const bridge = new Bridge(h.c, bot, h.store, channel, backend, new MediaStore(h.c)); bridge.start(); await bridge.idle(); const pump = new OutboxPump(h.store, channel, h.c.reply); await pump.tick(); assert.equal(backend.calls.length, 0); assert.equal(channel.sent.length, 1); assert.match(channel.sent[0]!.text, /durable answer/); assert((await bridge.accept(h.info.frame)).duplicate); assert.equal(backend.calls.length, 0); await bridge.stop(); });
test('R06: SIGKILL during sending -> unknown; manual result retrieval does not execute', async (t) => { const h = await crash(t, 'sending'); const backend = new FakeBackend(), channel = new FakeChannel(); const bridge = new Bridge(h.c, bot, h.store, channel, backend, new MediaStore(h.c)); bridge.start(); await bridge.idle(); assert.equal((h.store.db.prepare('SELECT state FROM outbox WHERE task_id=?').get(h.info.id) as any).state, 'unknown'); const pump = new OutboxPump(h.store, channel, h.c.reply); assert.equal(await pump.tick(), false); await bridge.accept(fixture(`/result ${h.info.id}`)); await pump.tick(); assert.equal(channel.sent.length, 1); assert.match(channel.sent[0]!.text, /durable answer/); assert.equal(backend.calls.length, 0); await bridge.stop(); });
