import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import sharp from 'sharp';
import { PiBackend } from '../../src/pi.ts';
import { JsonlFramer, RpcProcess } from '../../src/rpc-jsonl.ts';
import { MediaStore, SafeDownloader } from '../../src/media.ts';
import { agentEnvironment } from '../../src/config.ts';
import { setup, input, records, until } from '../helpers.ts';
import type { SessionRef } from '../../src/types.ts';
function harness(t: TestContext, scenario = 'normal') {
    const x = setup();
    const trace = path.join(x.root, 'trace.jsonl');
    x.c.agent.args.push('--scenario', scenario, '--record', trace);
    const backend = new PiBackend(x.c);
    let saved: SessionRef | undefined;
    const hooks = { persistSession: async (ref: SessionRef) => { saved = { ...ref }; }, progress: () => { } };
    t.after(async () => { await backend.stop(); x.cleanup(); });
    return { ...x, trace, backend, hooks, saved: () => saved, run: (prior?: SessionRef, signal = new AbortController().signal) => backend.run(input(x.c), prior, hooks, signal) };
}
test('P01: UTF-8 and JSON survive every possible two-chunk boundary', () => { const b = Buffer.from(JSON.stringify({ type: 'event', text: '图片😀' }) + '\n'); for (let cut = 0; cut <= b.length; cut++) {
    const out: any[] = [];
    const f = new JsonlFramer(1024, x => out.push(x));
    f.push(b.subarray(0, cut));
    f.push(b.subarray(cut));
    f.end();
    assert.deepEqual(out, [{ type: 'event', text: '图片😀' }]);
} });
test('P02: CRLF and embedded U+2028/U+2029 are not extra records', () => { const values = [{ text: 'a\u2028b\u2029c' }, { text: '中文' }]; const b = Buffer.from(values.map(x => JSON.stringify(x)).join('\r\n') + '\r\n'); const out: any[] = []; const f = new JsonlFramer(1024, x => out.push(x)); for (const byte of b)
    f.push(Buffer.from([byte])); f.end(); assert.deepEqual(out, values); });
test('P03: accepted and agent_end do not complete or release a turn', async (t) => { const h = harness(t, 'delayed'); let done = false; const running = h.run().then(r => { done = true; return r; }); await until(() => records(h.trace).some(x => x.type === 'prompt')); await sleep(20); assert.equal(done, false); const result = await running; assert.equal(result.outcome, 'success'); assert.equal(result.finalText, 'delayed answer'); assert(h.backend.settledSeen); });
test('P04: retry after agent_end settles once with final success, ignoring temporary error', async (t) => { const h = harness(t, 'retry'); const r = await h.run(); assert.equal(r.outcome, 'success'); assert.equal(r.finalText, 'retry succeeded'); assert(!r.finalText.includes('temporary')); assert(!r.finalText.includes('THINKING')); });
test('P05: error stopReason is failure and cannot reuse the previous answer', async (t) => { const h = harness(t); assert.equal((await h.run()).outcome, 'success'); h.c.agent.args[h.c.agent.args.indexOf('--scenario') + 1] = 'model-error'; const r = await h.run(h.saved()); assert.equal(r.outcome, 'failed'); assert.equal(r.errorCode, 'PI_MODEL_ERROR'); assert(!r.finalText.includes('final answer')); });
test('P06: cancelled new/switch commands never send a prompt', async (t) => { const h = harness(t, 'new-cancel'); let r = await h.run(); assert.equal(r.errorCode, 'SESSION_SWITCH_CANCELLED'); assert.equal(records(h.trace).filter(x => x.type === 'prompt').length, 0); const file = path.join(h.c.agent.sessionRoot, 'old.jsonl'); writeFileSync(file, JSON.stringify({ id: 'old' })); h.c.agent.args[h.c.agent.args.indexOf('--scenario') + 1] = 'switch-cancel'; r = await h.run({ kind: 'pi', sessionId: 'old', sessionFile: file, hasHistory: true }); assert.equal(r.errorCode, 'SESSION_SWITCH_CANCELLED'); assert.equal(records(h.trace).filter(x => x.type === 'prompt').length, 0); });
test('P07: rejected prompt fails only this turn and does not retain a stale collector', async (t) => { const h = harness(t, 'reject'); const r = await h.run(); assert.equal(r.outcome, 'failed'); assert.equal(r.errorCode, 'RPC_REJECTED'); assert(!r.finalText.includes('sensitive-token')); h.c.agent.args[h.c.agent.args.indexOf('--scenario') + 1] = 'normal'; assert.equal((await h.run()).finalText, 'final answer'); });
test('P08: exit, invalid/oversized JSONL and EPIPE end pending requests within a bound', async (t) => { for (const scenario of ['exit', 'invalid', 'huge']) {
    await t.test(scenario, async (t) => { const h = harness(t, scenario); h.c.agent.maxFrameBytes = 1024; const start = Date.now(); const r = await h.run(); assert.equal(r.outcome, 'interrupted'); assert(Date.now() - start < 2000); });
} await t.test('EPIPE', async (t) => { const h = harness(t); const rpc = new RpcProcess({ command: h.c.agent.command, args: h.c.agent.args.concat('--mode', 'rpc', '--session-dir', h.c.agent.sessionRoot), cwd: h.c.workspace.path, env: agentEnvironment(h.c), maxFrameBytes: 4096, timeoutMs: 500, killGraceMs: 300 }); t.after(() => rpc.stop()); const pending = rpc.request('get_state'); (rpc as any).child.stdin.emit('error', Object.assign(new Error('secret'), { code: 'EPIPE' })); await assert.rejects(pending, /RPC_STDIN/); }); });
test('P09: fresh per-turn process prevents late old-epoch stdout from contaminating new turn', async (t) => { const h = harness(t); await h.backend.start(); const old = (h.backend as any).rpc as RpcProcess; const first = await h.run(); assert.equal(first.outcome, 'success'); const running = h.run(h.saved()); (old as any).child.stdout.emit('data', Buffer.from(JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'OLD ANSWER' }] } }) + '\n' + JSON.stringify({ type: 'agent_settled' }) + '\n')); const r = await running; assert.equal(r.finalText, 'final answer'); assert.equal(records(h.trace).filter(x => x.envKeys).length, 2); });
test('P10: interactive select/confirm/input requests are cancelled, never approved or left hanging', async (t) => { for (const method of ['select', 'confirm', 'input', 'editor'])
    await t.test(method, async (t) => { const h = harness(t, 'ui'); h.c.agent.args.push('--ui-method', method); const r = await h.run(); assert.equal(r.errorCode, 'NEEDS_LOCAL_INTERACTION'); const response = records(h.trace).find(x => x.type === 'extension_ui_response'); assert(response); assert.equal(response.cancelled, true); assert.notEqual(response.confirmed, true); }); });
test('P11: actual spawned Agent receives no WECOM_SECRET or unrelated host credentials', async (t) => { const before = process.env.WECOM_SECRET; process.env.WECOM_SECRET = 'MUST_NOT_INHERIT'; t.after(() => { if (before === undefined)
    delete process.env.WECOM_SECRET;
else
    process.env.WECOM_SECRET = before; }); const h = harness(t); await h.run(); const env = records(h.trace).find(x => x.envKeys).envKeys; assert(!env.includes('WECOM_SECRET')); assert(env.includes('HOME')); });
test('P12: missing established session fails; explicitly never-written session can be recreated', async (t) => { const h = harness(t); await h.run(); const saved = h.saved()!; assert(saved.kind === 'pi'); unlinkSync(saved.sessionFile); const n = records(h.trace).filter(x => x.type === 'prompt').length; const failed = await h.run(saved); assert.equal(failed.errorCode, 'SESSION_MISSING'); assert.equal(records(h.trace).filter(x => x.type === 'prompt').length, n); const empty = { ...saved, hasHistory: false }; assert.equal((await h.run(empty)).outcome, 'success'); });
test('B01: validated file bytes arrive unchanged in Pi native image blocks', async (t) => { const h = harness(t); const bytes = await sharp({ create: { width: 2, height: 3, channels: 3, background: '#00ff00' } }).png().toBuffer(); const d = new SafeDownloader(['cdn.example.com'], async () => [{ address: '8.8.8.8', family: 4 }], async () => ({ status: 200, body: (async function* () { yield bytes; })() })); const media = new MediaStore(h.c, d); const i = input(h.c); i.images = await media.prepare(i.taskId, [{ url: 'https://cdn.example.com/i', source: 'message' }]); assert.equal((await h.backend.run(i, undefined, h.hooks, new AbortController().signal)).outcome, 'success'); const prompt = records(h.trace).find(x => x.type === 'prompt'); assert.equal(prompt.images[0].type, 'image'); assert.equal(prompt.images[0].mimeType, 'image/png'); assert.equal(createHash('sha256').update(Buffer.from(prompt.images[0].data, 'base64')).digest('hex'), i.images[0]?.sha256); assert(h.backend.imageBytesSent); });
test('B02: second turn switches to the exact persisted session file and ID', async (t) => { const h = harness(t); await h.run(); const saved = h.saved(); await h.run(saved); assert.deepEqual(h.saved(), saved); const switches = records(h.trace).filter(x => x.type === 'switch_session'); assert.equal(switches.length, 1); assert.equal(switches[0].sessionPath, saved?.kind === 'pi' ? saved.sessionFile : null); assert(h.backend.restoredSession); });
test('B03: fresh session mapping creates a new native session', async (t) => { const h = harness(t); await h.run(); const saved = h.saved(); await h.run(undefined); assert.notDeepEqual(h.saved(), saved); assert.equal(records(h.trace).filter(x => x.type === 'switch_session').length, 0); });
test('B04: empty final fails; refusal and explicit tool failure explanation remain valid answers', async (t) => { for (const scenario of ['empty', 'refusal', 'tool-error'])
    await t.test(scenario, async (t) => { const h = harness(t, scenario); const r = await h.run(); assert.equal(r.outcome, scenario === 'empty' ? 'failed' : 'success'); assert(!r.finalText.includes('TOOL_SECRET')); assert(!r.finalText.includes('THINKING')); }); });
test('B05: cancellation stops a real continuously-writing grandchild, not just a Promise', async (t) => { const h = harness(t, 'writer'); const file = path.join(h.c.workspace.path, 'sentinel'); h.c.agent.args.push('--sentinel', file); const controller = new AbortController(); const running = h.run(undefined, controller.signal); await until(() => existsSync(file) && readFileSync(file).length > 3); controller.abort(); const r = await running; assert.equal(r.outcome, 'cancelled'); const size = readFileSync(file).length; await sleep(100); assert.equal(readFileSync(file).length, size); assert(!existsSync(path.join(h.c.stateRoot, 'agent-process.json'))); });
test('B06: failed pre-prompt session persistence prevents execution; post-prompt failure interrupts', async (t) => { const h = harness(t); let r = await h.backend.run(input(h.c), undefined, { persistSession: async () => { throw new Error('db down'); }, progress: () => { } }, new AbortController().signal); assert.equal(r.outcome, 'failed'); assert.equal(records(h.trace).filter(x => x.type === 'prompt').length, 0); let calls = 0; r = await h.backend.run(input(h.c), undefined, { persistSession: async () => { if (++calls === 2)
        throw new Error('db down'); }, progress: () => { } }, new AbortController().signal); assert.equal(r.outcome, 'interrupted'); assert.equal(r.errorCode, 'SESSION_PERSISTENCE_AFTER_PROMPT'); });
test('already-aborted signal starts no subprocess and reads no credentials', async (t) => { const h = harness(t); const c = new AbortController(); c.abort(); const r = await h.run(undefined, c.signal); assert.equal(r.outcome, 'cancelled'); assert.equal(records(h.trace).length, 0); });
