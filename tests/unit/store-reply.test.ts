import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { Store } from '../../src/store.ts';
import { splitText, resultParts, boundedResult, OutboxPump } from '../../src/reply.ts';
import { DeliveryError } from '../../src/errors.ts';
import { setup, incoming, FakeChannel } from '../helpers.ts';
function harness(t: TestContext) { const x = setup(); const store = new Store(path.join(x.c.stateRoot, 'bridge.sqlite'), x.c); t.after(() => { store.close(); x.cleanup(); }); const job = store.reserve(incoming(x.c), 'agent').job; store.prepared(job.task_id, []); store.claim(); store.complete(job.task_id, 'succeeded', 'saved result'); const channel = new FakeChannel(); const pump = new OutboxPump(store, channel, x.c.reply); const delivery = () => store.db.prepare('SELECT * FROM outbox WHERE task_id=?').get(job.task_id) as any; return { ...x, store, job, channel, pump, delivery }; }
test('D01: UTF-8 chunk budgets include task prefix/footer and preserve all body code points', () => { const text = ('中文😀e\u0301\n').repeat(1000); assert.equal(splitText(text, 111).join(''), text); const id = randomUUID(); const pages = resultParts(id, text, 200); assert(pages.length > 3); const bodies = pages.map(p => { assert(Buffer.byteLength(p) <= 200); return p.replace(/^\[[^\]]+\]\n/, '').replace(/\n下一段: \/result [0-9a-f-]+ \d+$/, ''); }); assert.equal(bodies.join(''), text); const bounded = boundedResult(text, 128); assert(bounded.truncated); assert(Buffer.byteLength(bounded.text) <= 128); });
test('D03: disconnected before sending stays pending; reconnection sends result only', async (t) => { const h = harness(t); h.channel.ready = false; assert.equal(await h.pump.tick(), false); assert.equal(h.delivery().state, 'pending'); assert.equal(h.channel.sent.length, 0); h.channel.ready = true; await h.pump.tick(); assert.equal(h.delivery().state, 'sent'); assert.equal(h.store.get(h.job.task_id).status, 'succeeded'); });
test('D04: server accepted but ACK absent becomes unknown, with no retry or fallback', async (t) => { const h = harness(t); h.channel.sendHook = () => new Promise(() => { }); await h.pump.tick(); assert.equal(h.delivery().state, 'unknown'); assert.equal(h.store.get(h.job.task_id).status, 'succeeded'); assert.equal(await h.pump.tick(Date.now() + 10000), false); assert.equal(h.channel.sent.length, 1); });
test('D05: explicit success is sent once, even after repeated pump calls', async (t) => { const h = harness(t); await Promise.all(Array.from({ length: 10 }, () => h.pump.tick())); assert.equal(h.channel.sent.length, 1); assert.equal(h.delivery().state, 'sent'); assert.equal(await h.pump.tick(), false); });
test('D06: permanent failure, definitely not sent, and bounded explicit retry classifications', async (t) => { for (const disposition of ['permanent', 'not-sent', 'retryable'] as const)
    await t.test(disposition, async (t) => { const h = harness(t); h.channel.sendHook = async () => { throw new DeliveryError('FIXTURE_FAILURE', disposition); }; const now = Date.now(); await h.pump.tick(now); assert.equal(h.delivery().state, disposition === 'permanent' ? 'failed' : 'pending'); if (disposition === 'not-sent') {
        assert.equal(h.delivery().attempts, 0);
        h.channel.sendHook = undefined;
        await h.pump.tick(now + 10000);
        assert.equal(h.delivery().state, 'sent');
    } if (disposition === 'retryable') {
        await h.pump.tick(now + 10000);
        await h.pump.tick(now + 30000);
        assert.equal(h.delivery().state, 'failed');
        assert.equal(h.delivery().attempts, 3);
        assert.equal(await h.pump.tick(now + 60000), false);
    } }); });
test('Q07: success/cancel CAS produces exactly one terminal and one final outbox set', t => { const x = setup(); t.after(x.cleanup); const s = new Store(':memory:', x.c); t.after(() => s.close()); for (const cancelFirst of [true, false]) {
    const job = s.reserve(incoming(x.c), 'agent').job;
    s.prepared(job.task_id, []);
    s.claim();
    if (cancelFirst)
        s.cancel(job.task_id);
    assert(s.complete(job.task_id, 'succeeded', 'success'));
    assert(!s.complete(job.task_id, 'failed', 'late failure'));
    s.cancel(job.task_id);
    assert.equal(s.get(job.task_id).status, cancelFirst ? 'cancelled' : 'succeeded');
    assert.equal((s.db.prepare('SELECT count(*) n FROM outbox WHERE task_id=?').get(job.task_id) as any).n, 1);
} });
test('SQLite checks enforce states/dedup; result+outbox transaction rolls back together', t => { const x = setup(); t.after(x.cleanup); const s = new Store(':memory:', x.c); t.after(() => s.close()); const j = s.reserve(incoming(x.c), 'agent').job; assert.throws(() => s.db.prepare('UPDATE jobs SET status=? WHERE task_id=?').run('made-up', j.task_id)); assert.throws(() => s.atomic(() => { s.complete(j.task_id, 'succeeded', 'answer'); throw new Error('fault'); })); assert.equal(s.get(j.task_id).status, 'preparing'); assert.equal((s.db.prepare('SELECT count(*) n FROM outbox').get() as any).n, 0); });
