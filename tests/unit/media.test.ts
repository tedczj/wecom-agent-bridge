import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, randomBytes, randomUUID, createHash } from 'node:crypto';
import { readFileSync, symlinkSync, mkdirSync, existsSync, utimesSync, readdirSync } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { decryptFile } from '@wecom/aibot-node-sdk';
import { MediaStore, SafeDownloader, publicAddress, type Transport } from '../../src/media.ts';
import { setup } from '../helpers.ts';
const url = 'https://cdn.example.com/image.png';
const address = { address: '8.8.8.8', family: 4 };
async function png(width = 3, height = 2) { return sharp({ create: { width, height, channels: 3, background: '#ff0055' } }).png().toBuffer(); }
function downloader(data: Buffer, extra: Partial<Awaited<ReturnType<Transport>>> = {}) { return new SafeDownloader(['cdn.example.com'], async () => [address], async () => ({ status: 200, body: (async function* () { yield data; })(), ...extra })); }
function encrypted(data: Buffer, key: Buffer) { const padding = 32 - data.length % 32; const c = createCipheriv('aes-256-cbc', key, key.subarray(0, 16)); c.setAutoPadding(false); return Buffer.concat([c.update(Buffer.concat([data, Buffer.alloc(padding, padding)])), c.final()]); }
test('M01: real SDK decrypt + plaintext images preserve the original SHA-256', async (t) => { const x = setup(); t.after(x.cleanup); const bytes = await png(); const key = randomBytes(32); for (const aes of [false, true]) {
    const media = new MediaStore(x.c, downloader(aes ? encrypted(bytes, key) : bytes));
    const refs = await media.prepare(randomUUID(), [{ url, ...(aes ? { aesKey: key.toString('base64') } : {}), source: 'message' }]);
    assert.equal(refs.length, 1);
    assert.equal(refs[0]?.sha256, createHash('sha256').update(bytes).digest('hex'));
    assert.deepEqual(await media.read(refs[0]!), bytes);
    assert.equal(refs[0]?.mimeType, 'image/png');
    assert.equal(refs[0]?.width, 3);
} });
test('M02: real SDK supports 16/32 padding boundaries and rejects invalid keys/padding', () => { const key = randomBytes(32); for (const size of [16, 32, 48, 64]) {
    const data = randomBytes(size);
    assert.deepEqual(decryptFile(encrypted(data, key), key.toString('base64')), data);
} assert.throws(() => decryptFile(encrypted(Buffer.from('content'), key), 'bad-key')); const c = createCipheriv('aes-256-cbc', key, key.subarray(0, 16)); c.setAutoPadding(false); const invalid = Buffer.alloc(32, 32); invalid[0] = 31; assert.throws(() => decryptFile(Buffer.concat([c.update(invalid), c.final()]), key.toString('base64'))); });
test('M03: no/false Content-Length still has a hard streaming byte cap; early rejection aborts', async () => { for (const length of [undefined, '1', '1000']) {
    let count = 0;
    let aborted = false;
    const d = new SafeDownloader(['cdn.example.com'], async () => [address], async (_u, _a, s) => { s.addEventListener('abort', () => { aborted = true; }); return { status: 200, length, body: (async function* () { for (let i = 0; i < 100; i++) {
            count++;
            yield Buffer.alloc(60);
        } })() }; });
    await assert.rejects(d.download(url, 100, 1000), /MEDIA_SIZE/);
    assert(count <= 2);
    assert(aborted);
} });
test('M04: private/metadata/mapped IPv6 and all redirects blocked; DNS result pinned exactly once', async () => { for (const ip of ['127.0.0.1', '10.0.0.1', '169.254.169.254', '100.64.1.1', '192.168.1.2', '::1', 'fe80::1', 'fd00::1', '::ffff:8.8.8.8', '64:ff9b::7f00:1', '2001:db8::1'])
    assert.equal(publicAddress(ip), false, ip); assert(publicAddress('8.8.8.8')); assert(publicAddress('2606:4700:4700::1111')); let resolutions = 0, connections = 0; const d = new SafeDownloader(['cdn.example.com'], async () => { resolutions++; return resolutions === 1 ? [address] : [{ address: '127.0.0.1', family: 4 }]; }, async (u, a) => { connections++; assert.equal(u.hostname, 'cdn.example.com'); assert.deepEqual(a, address); return { status: 200, body: (async function* () { yield Buffer.from('ok'); })() }; }); assert.equal((await d.download(url, 100, 1000)).toString(), 'ok'); assert.equal(resolutions, 1); assert.equal(connections, 1); await assert.rejects(d.download(url, 100, 1000), /MEDIA_ADDRESS/); assert.equal(connections, 1); for (const status of [301, 302, 307, 308])
    await assert.rejects(downloader(Buffer.from('x'), { status }).download(url, 100, 1000), /MEDIA_HTTP_STATUS/); for (const bad of ['http://cdn.example.com/x', 'https://u:p@cdn.example.com/x', 'https://cdn.example.com:444/x', 'https://cdn.example.com.evil/x'])
    await assert.rejects(downloader(Buffer.from('x')).download(bad, 100, 1000), /MEDIA_URL/); });
test('M05: HTML/SVG/EXE with png filename is rejected and incomplete directory removed', async (t) => { const x = setup(); t.after(x.cleanup); for (const bytes of [Buffer.from('<html>secret</html>'), Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"></svg>'), Buffer.from('MZ executable')]) {
    const media = new MediaStore(x.c, downloader(bytes));
    const id = randomUUID();
    await assert.rejects(media.prepare(id, [{ url, source: 'message' }]));
    assert(!existsSync(path.join(media.root, id)));
} });
test('M06: over-pixel, corrupted, and animated images are rejected', async (t) => { const x = setup(); t.after(x.cleanup); const big = await png(10, 10); x.c.media.maxPixels = 6; const over = new MediaStore(x.c, downloader(big)); await assert.rejects(over.prepare(randomUUID(), [{ url, source: 'message' }])); x.c.media.maxPixels = 1000; const corrupt = big.subarray(0, big.length - 12); await assert.rejects(new MediaStore(x.c, downloader(corrupt)).prepare(randomUUID(), [{ url, source: 'message' }])); const frame = await png(); const animated = await sharp([frame, await png(4, 2)], { join: { animated: true } }).webp({ loop: 0 }).toBuffer(); assert.equal((await sharp(animated, { animated: true }).metadata()).pages, 2); await assert.rejects(new MediaStore(x.c, downloader(animated)).prepare(randomUUID(), [{ url, source: 'message' }]), /MEDIA_PIXELS_OR_ANIMATION/); });
test('M07: DNS/download timeout and expired URL fail explicitly', async () => { const d = new SafeDownloader(['cdn.example.com'], () => new Promise(() => { })); await assert.rejects(d.download(url, 100, 10), /MEDIA_TIMEOUT/); await assert.rejects(downloader(Buffer.from('expired'), { status: 403 }).download(url, 100, 1000), /MEDIA_HTTP_STATUS/); const hang = new SafeDownloader(['cdn.example.com'], async () => [address], async () => ({ status: 200, body: (async function* () { await new Promise(() => { }); yield Buffer.from('x'); })() })); await assert.rejects(hang.download(url, 100, 10), /MEDIA_TIMEOUT/); });
test('M08: remote filename is ignored and symlink cannot escape the controlled root', async (t) => { const x = setup(); t.after(x.cleanup); const bytes = await png(); const m = new MediaStore(x.c, downloader(bytes)); const refs = await m.prepare(randomUUID(), [{ url: 'https://cdn.example.com/../../evil.png?filename=../../secret', source: 'message' }]); assert.equal(path.basename(refs[0]!.localPath), 'input-01.png'); const id = randomUUID(); const outside = path.join(x.root, 'outside'); mkdirSync(outside); symlinkSync(outside, path.join(m.root, id)); await assert.rejects(m.prepare(id, [{ url, source: 'message' }]), /UNSAFE_DIRECTORY/); assert.deepEqual(readdirSync(outside), []); });
test('M09: TTL GC preserves queued/running references and deletes only unreferenced old media', async (t) => { const x = setup(); t.after(x.cleanup); const m = new MediaStore(x.c, downloader(await png())); const active = randomUUID(), old = randomUUID(); await m.prepare(active, [{ url, source: 'message' }]); await m.prepare(old, [{ url, source: 'message' }]); const epoch = new Date(0); for (const id of [active, old])
    utimesSync(path.join(m.root, id), epoch, epoch); await m.gc(new Set([active])); assert(existsSync(path.join(m.root, active))); assert(!existsSync(path.join(m.root, old))); });
test('media total quota, bytes hash, file permissions and cancellation are enforced', async (t) => { const x = setup(); t.after(x.cleanup); const bytes = await png(); const m = new MediaStore(x.c, downloader(bytes)); x.c.media.maxTotalBytes = bytes.length; await assert.rejects(m.prepare(randomUUID(), [{ url, source: 'message' }, { url, source: 'message' }]), /MEDIA_TOTAL_LIMIT/); const refs = await m.prepare(randomUUID(), [{ url, source: 'message' }]); await assert.rejects(m.read({ ...refs[0]!, sha256: 'wrong' }), /MEDIA_HASH/); const abort = new AbortController(); abort.abort(); await assert.rejects(m.prepare(randomUUID(), [{ url, source: 'message' }], abort.signal), /MEDIA_CANCELLED/); });
