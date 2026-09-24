import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import path from 'node:path';
import { Writable } from 'node:stream';
import { parseConfig, type Config } from '../../src/config.ts';
import { openService, type LocalService } from '../../src/main.ts';
import { privateDirectory, inside } from '../../src/fsutil.ts';
import { invariant } from '../../src/errors.ts';
import { modelDigest } from '../../src/orchestration/config.ts';

const projects = [
  ['wecom-agent-bridge', '个人微信与本地 Agent 的桥接服务'],
  ['term4u', '终端应用，支持本地交互式命令界面'],
  ['multi-lang-video-generator', '视频翻译、配音及多语言生成项目'],
  ['doc-ocr-service', '文档 OCR 文字识别服务'],
] as const;
let stopping = false, activeService: LocalService | undefined;
const stopController = new AbortController();
export const liveStopSignal = stopController.signal;
export const liveStopRequested = () => stopping;
export function requestLiveStop(): void {
  stopping = true;
  stopController.abort();
  // The case's finally block records cleanup success/failure and saves evidence.
  void activeService?.stop().catch(() => {});
}
export async function liveFixture(base: Config, evidence: string, sandbox: Config['codex']['sandbox'] = 'read-only', options: {
  ackFault?: (frame: Record<string, unknown>) => Error | undefined; businessClock?: () => number; directoryDescriptions?: Record<string, string>;
  beforeStart?: (config: Config) => Promise<void>;
} = {}) {
  invariant(!stopping, 'LIVE_STOP_REQUESTED');
  invariant(base.orchestration && base.models && base.backend === 'codex', 'LIVE_CONFIG_REQUIRED');
  const root = privateDirectory(path.join(evidence, 'fixture-' + randomUUID())), projectRoot = privateDirectory(path.join(root, 'projects'));
  writeFileSync(path.join(root, 'fixture-owner.json'), JSON.stringify({ id: path.basename(root), synthetic: true }), { mode: 0o600 });
  writeFileSync(path.join(root, '.gitignore'), '*\n', { mode: 0o600 });
  const env = { PATH: process.env.PATH ?? '/usr/bin:/bin', LANG: 'C.UTF-8', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  const git = (directory: string, args: string[]) => execFileSync('git', ['-C', directory, ...args], { env, encoding: 'utf8', timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  for (const [name, description] of projects) {
    const directory = path.join(projectRoot, name); mkdirSync(directory, { mode: 0o700 });
    writeFileSync(path.join(directory, 'README.md'), '# ' + name + '\n\n' + description + '。这是本次验收创建的合成 fixture。\n', { mode: 0o600 });
    git(directory, ['init', '--initial-branch=fixture']);
    git(directory, ['config', 'user.name', 'Bridge Fixture']); git(directory, ['config', 'user.email', 'fixture@localhost']);
    git(directory, ['config', 'commit.gpgsign', 'false']);
    git(directory, ['config', 'core.hooksPath', '/dev/null']); git(directory, ['add', 'README.md']); git(directory, ['commit', '-m', 'synthetic fixture baseline']);
  }
  const stateRoot = privateDirectory(path.join(root, 'state')), workRoot = privateDirectory(path.join(stateRoot, 'controllers'));
  const profile = sandbox === 'read-only' ? 'fixture-read' : 'fixture-write';
  const c = parseConfig({ ...base, transport: 'local', workspace: { id: 'wecom-agent-bridge', path: path.join(projectRoot, 'wecom-agent-bridge') }, stateRoot,
    local: { ...base.local, actorId: 'live-' + randomUUID().slice(0, 8) },
    agent: { ...base.agent, sessionRoot: path.join(stateRoot, 'pi-sessions') }, codex: { ...base.codex, sandbox, networkAccess: false },
    routing: { roots: [{ id: 'fixture', path: projectRoot, profile }],
      profiles: [{ id: profile, version: '1', codex: { sandbox, networkAccess: false } }],
      workspaces: projects.map(([id, description]) => ({ id, path: path.join(projectRoot, id), description: options.directoryDescriptions?.[id] ?? description, profile, aliases: [] })), history: true },
    orchestration: { ...base.orchestration, controllerRuntime: { ...base.orchestration.controllerRuntime, workRoot }, answers: { ...base.orchestration.answers, root: path.join(stateRoot, 'artifacts') } } });
  for (const profile of new Set([c.orchestration!.bridge.modelProfile, c.orchestration!.answers.recapModelProfile])) {
    const name = 'runtime-lock-' + modelDigest(c.models![profile]!) + '.json';
    const source = path.join(base.orchestration.controllerRuntime.workRoot, name);
    const destination = path.join(workRoot, name);
    copyFileSync(existsSync(source) ? source : path.join(base.orchestration.controllerRuntime.workRoot, 'runtime-lock.json'), destination); chmodSync(destination, 0o600);
  }
  // The service receives its environment in memory; evidence must not duplicate inline credentials.
  writeFileSync(path.join(root, 'fixture-configuration.json'), JSON.stringify({ workspace: c.workspace, models: c.models,
    routing: c.routing, sandbox: c.codex.sandbox, networkAccess: c.codex.networkAccess,
    environmentKeys: Object.keys(c.agent.env), passedEnvironmentKeys: c.agent.passEnv }, null, 2), { mode: 0o600 });
  const frames: Record<string, unknown>[] = [];
  const output = () => {
    let pending = '';
    return new Writable({ write(chunk, _encoding, callback) {
      pending += chunk.toString('utf8'); let end, fault: Error | undefined;
      while ((end = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, end); pending = pending.slice(end + 1);
        if (line) { const frame = JSON.parse(line); frames.push(frame); fault ??= options.ackFault?.(frame); }
      }
      callback(fault);
    } });
  };
  await options.beforeStart?.(c);
  invariant(!stopping, 'LIVE_STOP_REQUESTED');
  let service = await openService(c, output(), undefined, options.businessClock);
  activeService = service;
  if (stopping) { await service.stop(); activeService = undefined; invariant(false, 'LIVE_STOP_REQUESTED'); }
  return { root, projectRoot, c, get service() { return service; }, frames,
    async restart() {
      await service.stop(); if (activeService === service) activeService = undefined;
      invariant(!stopping, 'LIVE_STOP_REQUESTED'); service = await openService(c, output(), undefined, options.businessClock); activeService = service;
      if (stopping) { await service.stop(); activeService = undefined; invariant(false, 'LIVE_STOP_REQUESTED'); }
      return service;
    },
    gitState: () => Object.fromEntries(projects.map(([name]) => {
      const directory = path.join(projectRoot, name); invariant(inside(projectRoot, directory), 'LIVE_FIXTURE_SCOPE');
      return [name, { head: git(directory, ['rev-parse', 'HEAD']), status: git(directory, ['status', '--porcelain']), remotes: git(directory, ['remote', '-v']) }];
    })),
    save: (name: string, value: unknown) => { invariant(/^[a-z0-9_.-]+$/i.test(name), 'LIVE_EVIDENCE_PATH'); writeFileSync(path.join(evidence, name), JSON.stringify(value, null, 2), { mode: 0o600 }); },
    async close() { try { await service.stop(); } finally {
      if (activeService === service) activeService = undefined;
      writeFileSync(path.join(evidence, 'private-output.json'), JSON.stringify(frames), { mode: 0o600 });
    } },
    marker: JSON.parse(readFileSync(path.join(root, 'fixture-owner.json'), 'utf8')),
  };
}
