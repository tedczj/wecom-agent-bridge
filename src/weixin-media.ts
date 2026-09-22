import { createDecipheriv } from 'node:crypto';
import { field, boundedBody, type Fetch } from './weixin-api.ts';
import { BridgeError, invariant, record } from './errors.ts';

export function imageUrl(image: Record<string, unknown>): URL {
  const media = record(image.media);
  const url = media.full_url ? new URL(field(media.full_url))
    : new URL(`https://novac2c.cdn.weixin.qq.com/c2c/download?encrypted_query_param=${encodeURIComponent(field(media.encrypt_query_param))}`);
  invariant(url.protocol === 'https:' && url.hostname === 'novac2c.cdn.weixin.qq.com' && !url.username && !url.password && !url.port && !url.hash, 'WEIXIN_CDN_HOST');
  return url;
}
export function decryptImage(bytes: Buffer, image: Record<string, unknown>): Buffer {
  const media = record(image.media);
  let key: Buffer;
  if (image.aeskey !== undefined) {
    invariant(/^[0-9a-f]{32}$/i.test(field(image.aeskey)), 'WEIXIN_MEDIA_KEY');
    key = Buffer.from(image.aeskey as string,'hex');
  } else if (media.aes_key !== undefined) {
    const decoded = Buffer.from(field(media.aes_key),'base64');
    key = decoded.length === 32 && /^[0-9a-f]{32}$/i.test(decoded.toString()) ? Buffer.from(decoded.toString(),'hex') : decoded;
  } else return bytes; // The upstream protocol also permits plain CDN images.
  invariant(key.length === 16, 'WEIXIN_MEDIA_KEY');
  try {
    const decipher = createDecipheriv('aes-128-ecb',key,null);
    return Buffer.concat([decipher.update(bytes),decipher.final()]);
  } catch { throw new BridgeError('WEIXIN_MEDIA_DECRYPT'); }
}
export async function downloadImage(image: Record<string, unknown>, maxBytes: number, signal: AbortSignal, fetcher: Fetch = globalThis.fetch): Promise<Buffer> {
  const url = imageUrl(image);
  const boundedSignal = AbortSignal.any([signal,AbortSignal.timeout(20000)]);
  try {
    const response = await fetcher(url,{redirect:'error',signal:boundedSignal});
    const bytes = decryptImage(await boundedBody(response,maxBytes + 16),image);
    invariant(bytes.length <= maxBytes, 'MEDIA_SIZE'); return bytes;
  } catch (e) {
    if (e instanceof BridgeError) throw e;
    throw new BridgeError('WEIXIN_MEDIA_DOWNLOAD');
  }
}
