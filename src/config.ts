import { parseRouting, type RoutingConfig } from './routing/config.ts';
import { parseModels, parseOrchestration, type ModelProfile, type OrchestrationConfig } from './orchestration/config.ts';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { invariant, record } from './errors.ts';
import { inside, privateDirectory } from './fsutil.ts';
export const configSources = new WeakMap<Config,string>();
export interface Config {
  models?: Record<string, ModelProfile>;
  orchestration?: OrchestrationConfig;
  routing?: RoutingConfig;
  transport: 'local' | 'weixin';
  backend: 'codex' | 'pi'; workspace: { id: string; path: string }; stateRoot: string;
  local: { actorId: string; maxInputBytes: number };
  queue: { maxActive: 1; maxPendingPerSession: number; maxPendingGlobal: number };
  media: { maxImages: number; maxImageBytes: number; maxTotalBytes: number; maxPixels: number; maxTotalPixels: number; retentionHours: number };
  agent: { command: string; args: string[]; env: Record<string, string>; passEnv: string[]; sessionRoot: string;
    startupTimeoutMs: number; taskTimeoutMs: number; cancelGraceMs: number; killGraceMs: number;
    maxFrameBytes: number; maxStreamBytes: number; isolation: 'native' | 'external' | 'unverified' };
  codex: { home: string; sandbox: 'read-only' | 'workspace-write'; model?: string; reasoning?: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'; contextWindowTokens?: number; networkAccess: boolean };
  reply: { chunkBytes: number; minIntervalMs: number; maxAutoParts: number; maxResultBytes: number; sendTimeoutMs: number };
}
function strict(v: unknown, keys: string[]): Record<string, unknown> {
  const o = record(v); invariant(Object.keys(o).every(k => keys.includes(k)), 'CONFIG_UNKNOWN_KEY'); return o;
}
function str(v: unknown): string { invariant(typeof v === 'string' && v.length > 0 && v.length < 4096 && !v.includes('\0'), 'CONFIG_STRING'); return v; }
function list(v: unknown): string[] { invariant(Array.isArray(v), 'CONFIG_LIST'); return v.map(str); }
function integer(v: unknown, d: number, min: number, max: number): number {
  const n = v ?? d; invariant(typeof n === 'number' && Number.isSafeInteger(n) && n >= min && n <= max, 'CONFIG_NUMBER'); return n;
}
function absolute(v: unknown): string {
  const p = str(v); invariant(path.isAbsolute(p) && !p.includes('/absolute/path/'), 'CONFIG_PATH'); return path.resolve(p);
}
function bool(v: unknown, fallback: boolean): boolean { invariant(v === undefined || typeof v === 'boolean', 'CONFIG_BOOLEAN'); return (v ?? fallback) as boolean; }
export function parseConfig(value: unknown): Config {
  const c = strict(value, ['transport', 'backend', 'workspace', 'stateRoot', 'local', 'queue', 'media', 'agent', 'reply', 'codex', 'routing', 'models', 'orchestration']);
  const models = c.models === undefined ? undefined : parseModels(c.models);
  invariant(c.orchestration === undefined || models, 'CONFIG_MODELS_REQUIRED');
  const orchestration = c.orchestration === undefined ? undefined : parseOrchestration(c.orchestration, models!);
  const transport = c.transport ?? 'local'; invariant(transport === 'local' || transport === 'weixin', 'TRANSPORT_NOT_IMPLEMENTED');
  const backend = c.backend ?? 'codex'; invariant(backend === 'codex' || backend === 'pi', 'BACKEND_NOT_IMPLEMENTED');
  const w = strict(c.workspace, ['id', 'path']), stateRoot = absolute(c.stateRoot);
  const workspace = { id: str(w.id), path: absolute(w.path) };
  invariant(/^[a-zA-Z0-9_-]{1,64}$/.test(workspace.id), 'WORKSPACE_ID');
  invariant(!inside(workspace.path, stateRoot) && !inside(stateRoot, workspace.path), 'STATE_WORKSPACE_OVERLAP');
  const l = strict(c.local ?? {}, ['actorId', 'maxInputBytes']);
  const actorId = str(l.actorId ?? 'operator'); invariant(/^[a-zA-Z0-9_.-]{1,64}$/.test(actorId), 'ACTOR_ID');
  const q = strict(c.queue ?? {}, ['maxActive', 'maxPendingPerSession', 'maxPendingGlobal']);
  invariant((q.maxActive ?? 1) === 1, 'CONCURRENCY_MUST_BE_ONE');
  const m = strict(c.media ?? {}, ['maxImages', 'maxImageBytes', 'maxTotalBytes', 'maxPixels', 'maxTotalPixels', 'retentionHours']);
  const a = strict(c.agent, ['command', 'args', 'env', 'passEnv', 'sessionRoot', 'startupTimeoutMs', 'taskTimeoutMs', 'cancelGraceMs', 'killGraceMs', 'maxFrameBytes', 'maxStreamBytes', 'isolation']);
  const args = list(a.args ?? []);
  // Production Codex flags are owned entirely by this adapter. Use an executable wrapper for tests/profiles.
  if (backend === 'codex') invariant(args.length === 0, 'CODEX_ARGS_NOT_ALLOWED');
  else invariant(!args.some(x => ['--mode', '--session', '--session-dir', '--continue', '--no-session', '-c'].includes(x.split('=')[0]!)), 'PI_ARGS_CONFLICT');
  const env = record(a.env ?? {});
  const unsafeEnv = /^(NODE_OPTIONS|NODE_PATH|BASH_ENV|ENV|SHELLOPTS|LD_.*|DYLD_.*|CODEX_HOME)$/i;
  invariant(Object.entries(env).every(([k, v]) => /^[A-Z_][A-Z0-9_]*$/.test(k) && !unsafeEnv.test(k) && typeof v === 'string' && !v.includes('\0')), 'UNSAFE_AGENT_ENV');
  const passEnv = list(a.passEnv ?? []);
  invariant(passEnv.every(k => ['CODEX_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GOOGLE_API_KEY'].includes(k)), 'UNSAFE_AGENT_ENV');
  const sessionRoot = absolute(a.sessionRoot ?? path.join(stateRoot, 'agent-sessions'));
  invariant(!inside(workspace.path, sessionRoot) && !inside(sessionRoot, workspace.path), 'SESSIONS_IN_WORKSPACE');
  const x = strict(c.codex ?? {}, ['home', 'sandbox', 'model', 'reasoning', 'contextWindowTokens', 'networkAccess']);
  const home = absolute(x.home ?? path.join(stateRoot, 'codex-home'));
  invariant(!inside(workspace.path, home) && !inside(home, workspace.path), 'CODEX_HOME_WORKSPACE_OVERLAP');
  invariant(x.reasoning === undefined || ['minimal','low','medium','high','xhigh'].includes(String(x.reasoning)), 'CONFIG_REASONING');
  const sandbox = x.sandbox ?? 'read-only'; invariant(sandbox === 'read-only' || sandbox === 'workspace-write', 'UNSAFE_SANDBOX');
  const isolation = a.isolation ?? (backend === 'codex' ? 'native' : 'unverified');
  invariant(['unverified', 'external', 'native'].includes(String(isolation)), 'CONFIG_ISOLATION');
  const r = strict(c.reply ?? {}, ['chunkBytes', 'minIntervalMs', 'maxAutoParts', 'maxResultBytes', 'sendTimeoutMs']);
  return {
    models, orchestration,
    routing: c.routing === undefined ? undefined : parseRouting(c.routing),
    transport, backend, workspace, stateRoot, local: { actorId, maxInputBytes: integer(l.maxInputBytes, 131072, 256, 1048576) },
    queue: { maxActive: 1, maxPendingPerSession: integer(q.maxPendingPerSession, 3, 1, 100), maxPendingGlobal: integer(q.maxPendingGlobal, 20, 1, 1000) },
    media: { maxImages: integer(m.maxImages, 4, 1, 4), maxImageBytes: integer(m.maxImageBytes, 10485760, 64, 20971520), maxTotalBytes: integer(m.maxTotalBytes, 20971520, 64, 41943040), maxPixels: integer(m.maxPixels, 20000000, 1, 40000000), maxTotalPixels: integer(m.maxTotalPixels, 40000000, 1, 80000000), retentionHours: integer(m.retentionHours, 24, 1, 168) },
    agent: { command: absolute(a.command), args, env: env as Record<string,string>, passEnv, sessionRoot,
      startupTimeoutMs: integer(a.startupTimeoutMs, 30000, 1, 120000), taskTimeoutMs: integer(a.taskTimeoutMs, 900000, 1, 3600000), cancelGraceMs: integer(a.cancelGraceMs, 5000, 1, 30000), killGraceMs: integer(a.killGraceMs, 2000, 1, 10000), maxFrameBytes: integer(a.maxFrameBytes, 8388608, 256, 67108864), maxStreamBytes: integer(a.maxStreamBytes, 134217728, 1024, 536870912), isolation: isolation as Config['agent']['isolation'] },
    codex: { home, sandbox, model: x.model === undefined ? 'gpt-6-sol' : str(x.model), reasoning: (x.reasoning ?? 'high') as Config['codex']['reasoning'],
      ...(x.contextWindowTokens === undefined ? {} : { contextWindowTokens: integer(x.contextWindowTokens, 1, 1, Number.MAX_SAFE_INTEGER) }), networkAccess: bool(x.networkAccess, false) },
    reply: { chunkBytes: integer(r.chunkBytes, 65536, 128, 1048576), minIntervalMs: integer(r.minIntervalMs, 0, 0, 60000), maxAutoParts: integer(r.maxAutoParts, 20, 1, 100), maxResultBytes: integer(r.maxResultBytes, 1048576, 128, 1048576), sendTimeoutMs: integer(r.sendTimeoutMs, 15000, 1, 60000) },
  };
}
export function loadConfig(file: string): Config { const c=parseConfig(JSON.parse(readFileSync(file, 'utf8'))); configSources.set(c,realpathSync(file)); return c; }
export function preparePaths(c: Config): void {
  invariant(statSync(c.workspace.path).isDirectory(), 'WORKSPACE_MISSING');
  c.workspace.path = realpathSync(c.workspace.path);
  c.stateRoot = privateDirectory(c.stateRoot);
  invariant(!inside(c.workspace.path, c.stateRoot) && !inside(c.stateRoot, c.workspace.path), 'STATE_WORKSPACE_OVERLAP');
  c.agent.sessionRoot = privateDirectory(c.agent.sessionRoot);
  invariant(!inside(c.workspace.path, c.agent.sessionRoot) && !inside(c.agent.sessionRoot, c.workspace.path), 'SESSIONS_IN_WORKSPACE');
  if (c.backend === 'codex') {
    c.codex.home = privateDirectory(c.codex.home);
    invariant(!inside(c.workspace.path, c.codex.home) && !inside(c.codex.home, c.workspace.path), 'CODEX_HOME_WORKSPACE_OVERLAP');
  }
}
export function agentEnvironment(c: Config, host: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { PATH: host.PATH ?? '/usr/bin:/bin', LANG: 'C.UTF-8', ...c.agent.env };
  for (const key of c.agent.passEnv) if (host[key] !== undefined) env[key] = host[key];
  if (c.backend === 'codex') env.CODEX_HOME = c.codex.home;
  return env;
}
