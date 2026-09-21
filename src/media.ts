import { lookup } from 'node:dns/promises';
import { request } from 'node:https';
import { BlockList, isIP } from 'node:net';
import { createHash } from 'node:crypto';
import { writeFile, rename, rm, readdir, lstat } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { decryptFile } from '@wecom/aibot-node-sdk';
import type { Config } from './config.ts';
import type { ImageRef, MediaProvider, RemoteImage } from './types.ts';
import { BridgeError, invariant } from './errors.ts';
import { privateDirectory, readControlled } from './fsutil.ts';
import { withSignal } from './async.ts';
export interface Address {
    address: string;
    family: number;
}
export interface DownloadResponse {
    status: number;
    length?: string;
    body: AsyncIterable<Buffer>;
}
export type Resolver = (host: string) => Promise<Address[]>;
export type Transport = (url: URL, address: Address, signal: AbortSignal) => Promise<DownloadResponse>;
const denied4 = new BlockList();
for (const [addr, prefix] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]] as const)
    denied4.addSubnet(addr, prefix, 'ipv4');
const global6 = new BlockList();
global6.addSubnet('2000::', 3, 'ipv6');
const denied6 = new BlockList();
for (const [addr, prefix] of [['2001::', 23], ['2001:db8::', 32], ['2002::', 16]] as const)
    denied6.addSubnet(addr, prefix, 'ipv6');
export function publicAddress(address: string): boolean {
    const family = isIP(address);
    return family === 4 ? !denied4.check(address, 'ipv4') : family === 6 && global6.check(address, 'ipv6') && !denied6.check(address, 'ipv6');
}
export const nativeTransport: Transport = (url, address, signal) => new Promise((resolve, reject) => {
    const req = request(url, {
        method: 'GET', agent: false, signal, servername: url.hostname,
        headers: { Accept: 'image/png,image/jpeg,image/webp', 'Accept-Encoding': 'identity' },
        // Pin the validated address; retain original hostname for TLS verification/SNI.
        lookup: ((_host: string, options: any, callback: any) => options?.all
            ? callback(null, [address]) : callback(null, address.address, address.family)) as any,
    }, res => resolve({ status: res.statusCode ?? 0, length: res.headers['content-length'], body: res }));
    req.on('error', () => reject(new BridgeError('MEDIA_NETWORK')));
    req.end();
});
export class SafeDownloader {
    constructor(private hosts: string[], private resolver: Resolver = host => lookup(host, { all: true, verbatim: true }), private transport: Transport = nativeTransport) { }
    async download(raw: string, cap: number, timeoutMs: number, parent?: AbortSignal): Promise<Buffer> {
        let url: URL;
        try {
            url = new URL(raw);
        }
        catch {
            throw new BridgeError('MEDIA_URL');
        }
        invariant(url.protocol === 'https:' && (!url.port || url.port === '443') && !url.username && !url.password && !url.hash && this.hosts.includes(url.hostname.toLowerCase()), 'MEDIA_URL');
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        const signal = parent ? AbortSignal.any([parent, controller.signal]) : controller.signal;
        try {
            const addresses = await withSignal(this.resolver(url.hostname), signal);
            invariant(addresses.length > 0 && addresses.every(a => publicAddress(a.address) && isIP(a.address) === a.family), 'MEDIA_ADDRESS');
            const response = await withSignal(this.transport(url, addresses[0]!, signal), signal);
            invariant(response.status === 200, 'MEDIA_HTTP_STATUS');
            if (response.length !== undefined)
                invariant(/^\d+$/.test(response.length) && Number(response.length) <= cap, 'MEDIA_SIZE');
            const chunks: Buffer[] = [];
            let size = 0;
            const iterator = response.body[Symbol.asyncIterator]();
            try {
                for (;;) {
                    const next = await withSignal(iterator.next(), signal);
                    if (next.done)
                        break;
                    size += next.value.length;
                    invariant(size <= cap, 'MEDIA_SIZE');
                    chunks.push(next.value);
                }
            }
            finally {
                controller.abort();
                void iterator.return?.().catch(() => { });
            }
            invariant(size > 0, 'MEDIA_EMPTY');
            return Buffer.concat(chunks, size);
        }
        catch (e) {
            if (e instanceof BridgeError && e.code !== 'ABORTED')
                throw e;
            throw new BridgeError(parent?.aborted ? 'MEDIA_CANCELLED' : controller.signal.aborted ? 'MEDIA_TIMEOUT' : 'MEDIA_DOWNLOAD_FAILED');
        }
        finally {
            clearTimeout(timer);
            controller.abort();
        }
    }
}
export class MediaStore implements MediaProvider {
    readonly root: string;
    private active = 0;
    private waiters: Array<() => void> = [];
    constructor(private c: Config, private downloader = new SafeDownloader(c.wecom.mediaAllowedHosts)) {
        this.root = privateDirectory(path.join(c.stateRoot, 'media'));
    }
    private async slot<T>(fn: () => Promise<T>): Promise<T> {
        if (this.active >= 2)
            await new Promise<void>(resolve => this.waiters.push(resolve));
        else
            this.active++;
        try {
            return await fn();
        }
        finally {
            const next = this.waiters.shift();
            if (next)
                next();
            else
                this.active--;
        }
    }
    async prepare(taskId: string, media: RemoteImage[], signal?: AbortSignal): Promise<ImageRef[]> {
        invariant(/^[0-9a-f-]{36}$/.test(taskId), 'MEDIA_TASK_ID');
        invariant(media.length <= this.c.media.maxImages, 'MEDIA_COUNT');
        if (!media.length)
            return [];
        const dir = privateDirectory(path.join(this.root, taskId));
        const refs: ImageRef[] = [];
        let bytes = 0;
        let pixels = 0;
        try {
            for (const [i, remote] of media.entries()) {
                const ref = await this.slot(async () => {
                    if (signal?.aborted)
                        throw new BridgeError('MEDIA_CANCELLED');
                    let buffer = await this.downloader.download(remote.url, this.c.media.maxImageBytes + 32, this.c.media.downloadTimeoutMs, signal);
                    if (remote.aesKey) {
                        try {
                            buffer = decryptFile(buffer, remote.aesKey);
                        }
                        catch {
                            throw new BridgeError('MEDIA_DECRYPT');
                        }
                    }
                    invariant(buffer.length <= this.c.media.maxImageBytes, 'MEDIA_SIZE');
                    // libvips tolerates a missing PNG IEND: reject truncated containers explicitly.
                    if (buffer.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')))
                        invariant(buffer.subarray(-12).equals(Buffer.from('0000000049454e44ae426082', 'hex')), 'MEDIA_TRUNCATED');
                    if (buffer.subarray(0, 4).toString() === 'RIFF')
                        invariant(buffer.length >= 12 && buffer.readUInt32LE(4) + 8 === buffer.length, 'MEDIA_TRUNCATED');
                    let meta: sharp.Metadata;
                    try {
                        const decoder = sharp(buffer, { limitInputPixels: this.c.media.maxPixels, animated: true, failOn: 'warning' });
                        meta = await decoder.metadata();
                        invariant(['png', 'jpeg', 'webp'].includes(meta.format ?? ''), 'MEDIA_FORMAT');
                        invariant((meta.pages ?? 1) === 1 && meta.width && meta.height && meta.width * meta.height <= this.c.media.maxPixels, 'MEDIA_PIXELS_OR_ANIMATION');
                        // Metadata alone does not prove a decodable image. The raw allocation has a pixel budget.
                        await decoder.raw().toBuffer();
                    }
                    catch (e) {
                        if (e instanceof BridgeError)
                            throw e;
                        throw new BridgeError('MEDIA_DECODE');
                    }
                    const ext = meta.format === 'jpeg' ? 'jpg' : meta.format!;
                    const file = path.join(dir, `input-${String(i + 1).padStart(2, '0')}.${ext}`);
                    const part = file + '.part';
                    await writeFile(part, buffer, { flag: 'wx', mode: 0o600 });
                    await rename(part, file);
                    return { id: `image-${i + 1}`, localPath: file, mimeType: `image/${meta.format}`, sha256: createHash('sha256').update(buffer).digest('hex'), bytes: buffer.length, width: meta.width!, height: meta.height!, source: remote.source } as ImageRef;
                });
                bytes += ref.bytes;
                pixels += ref.width * ref.height;
                invariant(bytes <= this.c.media.maxTotalBytes && pixels <= this.c.media.maxTotalPixels, 'MEDIA_TOTAL_LIMIT');
                refs.push(ref);
            }
            return refs;
        }
        catch (e) {
            await rm(dir, { recursive: true, force: true });
            throw e;
        }
    }
    async read(image: ImageRef): Promise<Buffer> {
        const buffer = await readControlled(this.root, image.localPath, this.c.media.maxImageBytes);
        invariant(buffer.length === image.bytes && createHash('sha256').update(buffer).digest('hex') === image.sha256, 'MEDIA_HASH');
        return buffer;
    }
    async validate(images: ImageRef[]): Promise<void> { for (const image of images)
        await this.read(image); }
    async gc(activeTaskIds: Set<string>, now = Date.now()): Promise<void> {
        for (const name of await readdir(this.root)) {
            if (!/^[0-9a-f-]{36}$/.test(name) || activeTaskIds.has(name))
                continue;
            const file = path.join(this.root, name);
            const stat = await lstat(file);
            if (!stat.isSymbolicLink() && stat.isDirectory() && stat.mtimeMs < now - this.c.media.retentionHours * 3600000)
                await rm(file, { recursive: true, force: true });
        }
    }
}
