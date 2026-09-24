import path from 'node:path';
import { writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { parseConfig, agentEnvironment, type Config } from '../../src/config.ts';
import { privateDirectory, readControlled, inside } from '../../src/fsutil.ts';
import { invariant, record } from '../../src/errors.ts';
import { ControllerProtocol } from '../../src/controllers/protocol.ts';

/** A short-lived copy may authenticate tests, but must never consume the user's refresh token. */
export function accessOnlyAuth(value: unknown, now = Date.now()): Record<string, unknown> {
  const auth = record(value), tokens = record(auth.tokens);
  invariant(auth.auth_mode === 'chatgpt' && typeof tokens.id_token === 'string' && typeof tokens.access_token === 'string' &&
    typeof tokens.account_id === 'string' && typeof auth.last_refresh === 'string', 'LIVE_ISOLATED_AUTH_UNSUPPORTED');
  let claims: Record<string, unknown>;
  try { claims = record(JSON.parse(Buffer.from(tokens.access_token.split('.')[1]!, 'base64url').toString('utf8'))); }
  catch { throw new Error('LIVE_ISOLATED_AUTH_UNVERIFIED'); }
  invariant(typeof claims.exp === 'number' && Number.isSafeInteger(claims.exp) && claims.exp * 1000 > now + 3600000, 'LIVE_ISOLATED_AUTH_EXPIRING');
  const refreshed = Date.parse(auth.last_refresh);
  invariant(Number.isFinite(refreshed) && refreshed <= now && now - refreshed < 7 * 86400000, 'LIVE_ISOLATED_AUTH_REFRESH_REQUIRED');
  return { auth_mode: 'chatgpt', OPENAI_API_KEY: null, tokens: { id_token: tokens.id_token, access_token: tokens.access_token,
    refresh_token: '', account_id: tokens.account_id }, last_refresh: auth.last_refresh };
}

/** Isolate business history and credentials; management continues to use its separately probed home. */
export async function isolatedBusinessHome(base: Config, directory: string): Promise<{ config: Config; close(): void }> {
  invariant(path.isAbsolute(directory) && !inside(base.codex.home, directory) && !inside(directory, base.codex.home), 'LIVE_ISOLATED_HOME_SCOPE');
  const root = privateDirectory(directory), authFile = path.join(root, 'auth.json'), configFile = path.join(root, 'config.toml');
  invariant(!existsSync(authFile) && !existsSync(configFile), 'LIVE_ISOLATED_HOME_NOT_EMPTY');
  writeFileSync(path.join(root, '.gitignore'), '*\n', { mode: 0o600 });
  const protocol = new ControllerProtocol({ command: base.agent.command, args: ['app-server', '--stdio'], cwd: root,
    env: agentEnvironment(base), timeoutMs: 30000, killGraceMs: 3000, maxFrameBytes: 8388608 });
  let native: Record<string, unknown>;
  try {
    await protocol.request('initialize', { clientInfo: { name: 'bridge_isolated_fixture', version: '1' }, capabilities: { experimentalApi: true } });
    await protocol.notify('initialized'); native = record((await protocol.request('config/read', { includeLayers: false, cwd: root })).config);
  } finally { await protocol.close(); }
  invariant((native.model_provider ?? 'openai') === 'openai' && !record(native.model_providers ?? {}).openai, 'LIVE_ISOLATED_PROVIDER_UNSUPPORTED');
  let toml = 'cli_auth_credentials_store = "file"\n';
  if (native.chatgpt_base_url !== undefined && native.chatgpt_base_url !== null) {
    invariant(typeof native.chatgpt_base_url === 'string', 'LIVE_ISOLATED_PROVIDER_UNSUPPORTED');
    const url = new URL(native.chatgpt_base_url);
    invariant(!url.username && !url.password && !url.search && !url.hash, 'LIVE_ISOLATED_PROVIDER_UNSUPPORTED');
    toml += 'chatgpt_base_url = ' + JSON.stringify(native.chatgpt_base_url) + '\n';
  }
  const auth = accessOnlyAuth(JSON.parse((await readControlled(base.codex.home, path.join(base.codex.home, 'auth.json'), 131072)).toString('utf8')));
  try {
    writeFileSync(configFile, toml, { mode: 0o600, flag: 'wx' });
    writeFileSync(authFile, JSON.stringify(auth), { mode: 0o600, flag: 'wx' });
    writeFileSync(path.join(root, 'bridge-fixture-home.json'), JSON.stringify({ purpose: 'native-history-fault', refreshTokenCopied: false }), { mode: 0o600, flag: 'wx' });
    const config = parseConfig({ ...base, codex: { ...base.codex, home: root } });
    return { config, close() { if (existsSync(authFile)) unlinkSync(authFile); } };
  } catch (error) { if (existsSync(authFile)) unlinkSync(authFile); throw error; }
}
