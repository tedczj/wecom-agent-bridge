import { existsSync, lstatSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import qrcode from 'qrcode-terminal';
import { apiBase, field, WeixinApi, WEIXIN_BASE, type WeixinAuth } from './weixin-api.ts';
import { invariant, record } from './errors.ts';

export function parseAuth(value: unknown): WeixinAuth {
  const a = record(value);
  return {token:field(a.token), botId:field(a.botId,512), userId:field(a.userId,512), baseUrl:apiBase(a.baseUrl)};
}
export function saveAuth(file: string, auth: WeixinAuth): void {
  const tmp = file + '.' + randomUUID() + '.tmp';
  // Atomic rename replaces a directory entry; never follow an existing auth symlink.
  if (existsSync(file)) invariant(!lstatSync(file).isSymbolicLink(), 'UNSAFE_AUTH_FILE');
  try {
    writeFileSync(tmp, JSON.stringify(parseAuth(auth)), {mode:0o600, flag:'wx'});
    renameSync(tmp, file);
  } finally { rmSync(tmp,{force:true}); }
}
export interface LoginUI {
  showQr(value: string): void;
  verify(signal: AbortSignal): Promise<string>;
}
const terminal: LoginUI = {
  showQr(value) {
    process.stderr.write('请用个人微信扫描二维码并确认连接 ClawBot：\n');
    qrcode.generate(value, {small:true}, code => process.stderr.write(code + '\n'));
  },
  async verify(signal) {
    invariant(process.stdin.isTTY, 'WEIXIN_VERIFY_REQUIRES_TERMINAL');
    const rl = createInterface({input:process.stdin,output:process.stderr});
    try { return (await rl.question('输入手机微信显示的验证码：', {signal})).trim(); }
    finally { rl.close(); }
  },
};
export async function weixinLogin(api: WeixinApi, signal: AbortSignal, ui: LoginUI = terminal): Promise<WeixinAuth> {
  const loginSignal = AbortSignal.any([signal, AbortSignal.timeout(300000)]);
  const qr = await api.request('ilink/bot/get_bot_qrcode?bot_type=3', {local_token_list:[]}, {signal:loginSignal});
  const code = field(qr.qrcode); ui.showQr(field(qr.qrcode_img_content));
  let baseUrl = WEIXIN_BASE, verifyCode: string | undefined;
  for (;;) {
    loginSignal.throwIfAborted();
    const params = new URLSearchParams({qrcode:code}); if (verifyCode) params.set('verify_code',verifyCode);
    let status: Record<string, unknown>;
    try { status = await api.request(`ilink/bot/get_qrcode_status?${params}`, undefined, {baseUrl,signal:loginSignal,timeoutMs:35000}); }
    catch (e) { if (loginSignal.aborted) throw e; await sleep(1000,undefined,{signal:loginSignal}); continue; }
    if (status.status === 'confirmed') return parseAuth({token:status.bot_token,botId:status.ilink_bot_id,userId:status.ilink_user_id,baseUrl:status.baseurl ?? baseUrl});
    if (status.status === 'need_verifycode') {
      verifyCode = await ui.verify(loginSignal); invariant(/^\d{1,12}$/.test(verifyCode), 'WEIXIN_VERIFY_INVALID'); continue;
    }
    invariant(status.status !== 'expired', 'WEIXIN_QR_EXPIRED');
    invariant(status.status !== 'verify_code_blocked', 'WEIXIN_VERIFY_BLOCKED');
    invariant(status.status !== 'binded_redirect', 'WEIXIN_EXISTING_BINDING_REQUIRES_AUTH');
    if (status.status === 'scaned_but_redirect') baseUrl = apiBase(`https://${field(status.redirect_host,253)}`);
    else invariant(status.status === 'wait' || status.status === 'scaned', 'WEIXIN_QR_STATUS');
    if (status.status === 'scaned') verifyCode = undefined;
    await sleep(1000,undefined,{signal:loginSignal});
  }
}
export async function loadOrLogin(stateRoot: string, api: WeixinApi, signal: AbortSignal): Promise<WeixinAuth> {
  const file = path.join(stateRoot, 'weixin-auth.json');
  if (existsSync(file)) {
    const stat = lstatSync(file);
    invariant(stat.isFile() && !stat.isSymbolicLink() && (stat.mode & 0o077) === 0 && stat.size <= 32768, 'UNSAFE_AUTH_FILE');
    return parseAuth(JSON.parse(readFileSync(file,'utf8')));
  }
  const auth = await weixinLogin(api,signal); saveAuth(file,auth);
  process.stderr.write('微信绑定完成。\n'); return auth;
}
