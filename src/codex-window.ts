import { existsSync, writeFileSync, unlinkSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { type Config, agentEnvironment } from './config.ts';
import { ControllerProtocol } from './controllers/protocol.ts';
import { invariant, record } from './errors.ts';
import { readControlled } from './fsutil.ts';
import { withSignal } from './async.ts';
import { sha256 } from './orchestration/requests.ts';

export interface CodexWindowResolution {
  model: string; usableTokens: number; nativeTotalTokens: number; effectivePercent: number; nativeMaxTokens: number; metadataSha256: string;
}
/** Native model_context_window is a total; ModelProfile.contextWindowTokens is usable capacity. */
export function resolveWindowMetadata(value: unknown, model: string, usableTokens: number): CodexWindowResolution {
  invariant(Number.isSafeInteger(usableTokens) && usableTokens > 0, 'EXECUTION_CONTEXT_WINDOW');
  const cache = record(value); invariant(Array.isArray(cache.models), 'CODEX_WINDOW_METADATA_UNAVAILABLE');
  const matches = cache.models.map(record).filter(row => row.slug === model);
  invariant(matches.length === 1, 'CODEX_WINDOW_METADATA_UNAVAILABLE');
  const metadata = matches[0]!, percent = metadata.effective_context_window_percent, maximum = metadata.max_context_window ?? metadata.context_window;
  invariant(typeof percent === 'number' && Number.isSafeInteger(percent) && percent > 0 && percent <= 100 &&
    typeof maximum === 'number' && Number.isSafeInteger(maximum) && maximum > 0, 'CODEX_WINDOW_METADATA_UNAVAILABLE');
  const wanted = BigInt(usableTokens), p = BigInt(percent), total = (wanted * 100n + p - 1n) / p;
  invariant(total <= BigInt(maximum) && total <= BigInt(Number.MAX_SAFE_INTEGER) && total * p / 100n === wanted, 'CONTEXT_WINDOW_MISMATCH');
  return { model, usableTokens, nativeTotalTokens: Number(total), effectivePercent: percent, nativeMaxTokens: maximum,
    metadataSha256: sha256(JSON.stringify(metadata)) };
}

/** Ask native model/list to validate/refresh its own account cache. No thread or model prompt is created. */
export async function resolveCodexWindow(c: Config, signal: AbortSignal): Promise<CodexWindowResolution> {
  invariant(c.codex.model && c.codex.contextWindowTokens !== undefined, 'CODEX_WINDOW_PROFILE_REQUIRED');
  invariant(!signal.aborted, 'ABORTED');
  const marker = path.join(c.stateRoot, 'agent-process.json'), token = randomUUID(); let ownsMarker = false;
  invariant(!existsSync(marker), 'AGENT_PROCESS_REVIEW_REQUIRED');
  const protocol = new ControllerProtocol({ command: c.agent.command,
    args: ['--config', `projects={${JSON.stringify(c.workspace.path)}={trust_level="untrusted"}}`, 'app-server', '--stdio'], cwd: c.workspace.path,
    env: agentEnvironment(c), timeoutMs: c.agent.startupTimeoutMs, killGraceMs: c.agent.killGraceMs, maxFrameBytes: c.agent.maxFrameBytes,
    onSpawn: pid => { writeFileSync(marker, JSON.stringify({ pid, token, backend: 'codex', phase: 'model-metadata', startedAt: Date.now() }), { flag: 'wx', mode: 0o600 }); ownsMarker = true; },
    onStopped: () => { if (ownsMarker && JSON.parse(readFileSync(marker, 'utf8')).token === token) unlinkSync(marker); } });
  const abort = () => { void protocol.close().catch(() => {}); };
  signal.addEventListener('abort', abort, { once: true });
  try {
    await withSignal(protocol.request('initialize', { clientInfo: { name: 'bridge_window_metadata', version: '1' }, capabilities: { experimentalApi: true } }), signal);
    await protocol.notify('initialized');
    let cursor: string | undefined, found = false;
    for (let page = 0; page < 10; page++) {
      const response = await withSignal(protocol.request('model/list', { limit: 100, ...(cursor ? { cursor } : {}) }), signal);
      invariant(Array.isArray(response.data), 'CODEX_WINDOW_METADATA_UNAVAILABLE');
      found = response.data.map(record).some(row => row.model === c.codex.model);
      if (found || !response.nextCursor) break;
      invariant(typeof response.nextCursor === 'string' && response.nextCursor !== cursor, 'CODEX_WINDOW_METADATA_UNAVAILABLE'); cursor = response.nextCursor;
    }
    invariant(found, 'CODEX_WINDOW_METADATA_UNAVAILABLE');
    const bytes = await readControlled(c.codex.home, path.join(c.codex.home, 'models_cache.json'), 4 * 1024 * 1024);
    return resolveWindowMetadata(JSON.parse(bytes.toString('utf8')), c.codex.model, c.codex.contextWindowTokens);
  } finally { signal.removeEventListener('abort', abort); await protocol.close(); }
}
