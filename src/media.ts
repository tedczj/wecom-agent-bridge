import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readdir, lstat, writeFile, rename, rm, open } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import type { Config } from './config.ts';
import type { ImageRef, LocalImage, MediaProvider } from './types.ts';
import { invariant, BridgeError } from './errors.ts';
import { inside, privateDirectory, readControlled } from './fsutil.ts';
const taskPattern = /^[0-9a-f]{8}-[0-9a-f-]{27}$/;
const formats = { png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp' } as const;
function aborted(signal?: AbortSignal): void { if (signal?.aborted) throw new BridgeError('ABORTED'); }
/** Serial decoding bounds memory; no URLs, network downloads, AES keys or OCR remain. */
export class MediaStore implements MediaProvider {
  readonly root: string;
  private tail: Promise<void> = Promise.resolve();
  constructor(private c: Config) { this.root = privateDirectory(path.join(c.stateRoot, 'media')); }
  prepare(taskId: string, media: LocalImage[], signal?: AbortSignal): Promise<ImageRef[]> {
    const job = this.tail.then(() => this.prepareSerial(taskId, media, signal));
    this.tail = job.then(() => {}, () => {}); return job;
  }
  /** Only the startup owner may recover a request that has not reached management planning. */
  recoverPreparation(taskId: string, media: LocalImage[], signal?: AbortSignal): Promise<ImageRef[]> {
    const job = this.tail.then(async () => {
      invariant(this.c.orchestration && taskPattern.test(taskId), 'MEDIA_RECOVERY_SCOPE');
      const dir = path.join(this.root, taskId);
      try {
        const manifest = JSON.parse((await readControlled(this.root, path.join(dir, 'manifest.json'), 65536)).toString('utf8'));
        invariant(manifest.taskId === taskId && manifest.inputHash === createHash('sha256').update(JSON.stringify(media)).digest('hex') && Array.isArray(manifest.images), 'MEDIA_RECOVERY_SCOPE');
        await this.validate(manifest.images); aborted(signal); return manifest.images as ImageRef[];
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      try { const stat = await lstat(dir); invariant(stat.isDirectory() && !stat.isSymbolicLink(), 'MEDIA_RECOVERY_SCOPE'); await rm(dir, { recursive: true }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      return this.prepareSerial(taskId, media, signal);
    });
    this.tail = job.then(() => {}, () => {}); return job;
  }
  private async prepareSerial(taskId: string, media: LocalImage[], signal?: AbortSignal): Promise<ImageRef[]> {
    aborted(signal); invariant(taskPattern.test(taskId), 'MEDIA_TASK_ID');
    invariant(media.length <= this.c.media.maxImages, 'MEDIA_COUNT');
    if (!media.length) return [];
    const dir = path.join(this.root, taskId); let ownsDir = false;
    try {
      await mkdir(dir, { mode: 0o700 }); ownsDir = true;
      const images: ImageRef[] = []; let totalBytes = 0, totalPixels = 0;
      for (const item of media) {
        aborted(signal);
        invariant(path.isAbsolute(item.path), 'MEDIA_PATH');
        const bytes = await readControlled(path.parse(item.path).root, item.path, this.c.media.maxImageBytes);
        aborted(signal); invariant(bytes.length > 0, 'MEDIA_EMPTY');
        totalBytes += bytes.length; invariant(totalBytes <= this.c.media.maxTotalBytes, 'MEDIA_TOTAL_BYTES');
        const metadata = await sharp(bytes, { failOn: 'error', limitInputPixels: this.c.media.maxPixels }).metadata();
        invariant(metadata.format === 'png' || metadata.format === 'jpeg' || metadata.format === 'webp', 'MEDIA_TYPE');
        invariant((metadata.pages ?? 1) === 1, 'MEDIA_ANIMATED');
        const width = metadata.width ?? 0, height = metadata.height ?? 0;
        invariant(width > 0 && height > 0 && width * height <= this.c.media.maxPixels, 'MEDIA_PIXELS');
        totalPixels += width * height; invariant(totalPixels <= this.c.media.maxTotalPixels, 'MEDIA_TOTAL_PIXELS');
        // Metadata is not a full decode. Reject truncated/corrupt payloads before persisting.
        await sharp(bytes, { failOn: 'error', limitInputPixels: this.c.media.maxPixels }).raw().toBuffer();
        aborted(signal);
        const id = randomUUID(), file = path.join(dir, `${id}.${metadata.format === 'jpeg' ? 'jpg' : metadata.format}`);
        await writeFile(file + '.part', bytes, { flag: 'wx', mode: 0o600 });
        aborted(signal); await rename(file + '.part', file);
        images.push({ id, localPath: file, mimeType: formats[metadata.format], width, height, bytes: bytes.length,
          sha256: createHash('sha256').update(bytes).digest('hex'), source: item.source });
      }
      if (this.c.orchestration) {
        for (const image of images) { const handle = await open(image.localPath, 'r'); try { await handle.sync(); } finally { await handle.close(); } }
        const manifest = await open(path.join(dir, 'manifest.json.part'), 'wx', 0o600);
        try { await manifest.writeFile(JSON.stringify({ taskId, inputHash: createHash('sha256').update(JSON.stringify(media)).digest('hex'), images })); await manifest.sync(); }
        finally { await manifest.close(); }
        await rename(path.join(dir, 'manifest.json.part'), path.join(dir, 'manifest.json'));
        const handle = await open(dir, 'r'); try { await handle.sync(); } finally { await handle.close(); }
      }
      return images;
    } catch (e) { if (ownsDir) await rm(dir, { recursive: true, force: true }); throw e; }
  }
  async read(image: ImageRef): Promise<Buffer> {
    invariant(inside(this.root, image.localPath), 'MEDIA_PATH');
    const bytes = await readControlled(this.root, image.localPath, this.c.media.maxImageBytes);
    invariant(bytes.length === image.bytes && createHash('sha256').update(bytes).digest('hex') === image.sha256, 'MEDIA_HASH');
    return bytes;
  }
  async validate(images: ImageRef[]): Promise<void> {
    invariant(images.length <= this.c.media.maxImages, 'MEDIA_COUNT');
    let totalBytes = 0, totalPixels = 0;
    for (const image of images) {
      const bytes = await this.read(image);
      const metadata = await sharp(bytes, { failOn: 'error', limitInputPixels: this.c.media.maxPixels }).metadata();
      invariant(metadata.format === 'png' || metadata.format === 'jpeg' || metadata.format === 'webp', 'MEDIA_TYPE');
      invariant(formats[metadata.format] === image.mimeType && metadata.width === image.width && metadata.height === image.height && (metadata.pages ?? 1) === 1, 'MEDIA_METADATA');
      totalBytes += image.bytes; totalPixels += image.width * image.height;
      invariant(image.width * image.height <= this.c.media.maxPixels, 'MEDIA_PIXELS');
    }
    invariant(totalBytes <= this.c.media.maxTotalBytes && totalPixels <= this.c.media.maxTotalPixels, 'MEDIA_TOTAL_LIMIT');
  }
  async gc(active: Set<string>, now = Date.now()): Promise<number> {
    let removed = 0;
    for (const entry of await readdir(this.root, { withFileTypes: true })) {
      if (!taskPattern.test(entry.name) || active.has(entry.name) || !entry.isDirectory() || entry.isSymbolicLink()) continue;
      const dir = path.join(this.root, entry.name), stat = await lstat(dir);
      const partial = (await readdir(dir)).some(name => name.endsWith('.part'));
      if (partial || now - stat.mtimeMs >= this.c.media.retentionHours * 3600000) {
        await rm(dir, { recursive: true, force: true }); removed++;
      }
    }
    return removed;
  }
}
