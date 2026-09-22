import { randomBytes } from 'node:crypto';
import { BridgeError, invariant, log, record } from './errors.ts';

// Wire compatibility inspected in Tencent/openclaw-weixin at
// 24de5c9eb0dd5e595d7e2d090ed8a3f82870d42c (protocol version 2.4.9).
export const WEIXIN_BASE = 'https://ilinkai.weixin.qq.com';
export type Fetch = typeof globalThis.fetch;
export interface WeixinAuth { token: string; botId: string; userId: string; baseUrl: string }
export function field(value: unknown, max = 8192): string {
  invariant(typeof value === 'string' && value.length > 0 && Buffer.byteLength(value) <= max && !value.includes('\0'), 'WEIXIN_PROTOCOL');
  return value;
}
export function apiBase(value: unknown): string {
  const url = new URL(field(value));
  invariant(url.protocol === 'https:' && (url.hostname === 'ilinkai.weixin.qq.com' || url.hostname.endsWith('.weixin.qq.com')) && !url.username && !url.password && !url.port && url.pathname === '/' && !url.search && !url.hash, 'WEIXIN_API_HOST');
  return url.origin;
}
export async function boundedBody(response: Response, max: number): Promise<Buffer> {
  invariant(response.ok && response.body, 'WEIXIN_HTTP_ERROR');
  const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const {value, done} = await reader.read(); if (done) break;
      size += value.length; invariant(size <= max, 'WEIXIN_RESPONSE_TOO_LARGE'); chunks.push(value);
    }
    return Buffer.concat(chunks, size);
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
export class WeixinApi {
  constructor(private fetcher: Fetch = globalThis.fetch) {}
  async request(endpoint: string, body: Record<string, unknown> | undefined, options: {baseUrl?: string; token?: string; signal?: AbortSignal; timeoutMs?: number} = {}): Promise<Record<string, unknown>> {
    const base = apiBase(options.baseUrl ?? WEIXIN_BASE);
    const headers: Record<string, string> = {'iLink-App-Id':'bot', 'iLink-App-ClientVersion':String((2 << 16) | (4 << 8) | 9)};
    if (body) {
      headers['Content-Type'] = 'application/json'; headers.AuthorizationType = 'ilink_bot_token';
      headers['X-WECHAT-UIN'] = Buffer.from(String(randomBytes(4).readUInt32BE())).toString('base64');
    }
    if (options.token) headers.Authorization = `Bearer ${options.token}`;
    const timeout = AbortSignal.timeout(options.timeoutMs ?? 15000);
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
    try {
      const response = await this.fetcher(new URL(endpoint, base + '/'), {
        method:body ? 'POST' : 'GET', headers, redirect:'error', signal,
        body:body ? JSON.stringify(options.token ? {...body, base_info:{channel_version:'2.4.9',bot_agent:'LocalAgentBridge/0.2.0'}} : body) : undefined,
      });
      const raw = new TextDecoder('utf-8', {fatal:true}).decode(await boundedBody(response, 4 * 1024 * 1024));
      // iLink message IDs are uint64. Preserve them before JSON number conversion.
      return record(JSON.parse(raw.replace(/("message_id"\s*:\s*)(\d+)(?=\s*[,}])/g, '$1"$2"')));
    } catch (e) {
      if (e instanceof BridgeError) throw e;
      throw new BridgeError(signal.aborted ? 'WEIXIN_REQUEST_ABORTED' : 'WEIXIN_REQUEST_FAILED');
    }
  }
  async bot(endpoint: string, body: Record<string, unknown>, auth: WeixinAuth, signal?: AbortSignal, timeoutMs?: number): Promise<Record<string, unknown>> {
    const data = await this.request(`ilink/bot/${endpoint}`, body, {baseUrl:auth.baseUrl,token:auth.token,signal,timeoutMs});
    // iLink omits zero-valued return codes in successful getupdates/sendmessage
    // responses. Missing fields are distinct from present, malformed codes.
    invariant((data.ret === undefined || Number.isSafeInteger(data.ret)) && (data.errcode === undefined || Number.isSafeInteger(data.errcode)), 'WEIXIN_API_PROTOCOL');
    invariant(data.ret !== -14 && data.errcode !== -14, 'WEIXIN_AUTH_EXPIRED');
    if ((data.ret !== undefined && data.ret !== 0) || (data.errcode !== undefined && data.errcode !== 0)) {
      log('weixin.api_rejected',{code:'WEIXIN_API_REJECTED',apiRet:data.ret as number | undefined,apiErrcode:data.errcode as number | undefined});
      throw new BridgeError('WEIXIN_API_REJECTED');
    }
    return data;
  }
}
