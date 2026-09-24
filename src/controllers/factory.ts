import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, existsSync, realpathSync, statSync, readdirSync, lstatSync, renameSync, writeFileSync, readFileSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import type { Config } from '../config.ts';
import { agentEnvironment } from '../config.ts';
import { inside, privateDirectory, readControlled, processAlive } from '../fsutil.ts';
import { BridgeError, invariant, record } from '../errors.ts';
import { modelDigest, type ModelProfile } from '../orchestration/config.ts';
import { sha256 } from '../orchestration/requests.ts';
import { CodexAppServer, controllerPolicy } from './codex-app-server.ts';
import type { ControllerPolicyAudit } from './policy.ts';

export async function binaryDigest(command: string): Promise<string> {
  const hash = createHash('sha256'); for await (const chunk of createReadStream(command)) hash.update(chunk); return hash.digest('hex');
}
export async function controllerConfigurationDigest(home: string, model: ModelProfile): Promise<string> {
  const config = path.join(home, 'config.toml');
  const configHash = existsSync(config) ? sha256(await readControlled(home, config, 1048576)) : 'absent';
  return sha256(JSON.stringify({ home: realpathSync(home), model: [model.model, model.reasoning, model.contextWindowTokens], policy: controllerPolicy, nativeConfigHash: configHash }));
}
interface Capability { configurationDigest: string; binarySha256: string; capabilityReady: boolean; checks: Record<string, unknown>; model: ModelProfile }
export class ControllerCapabilityError extends BridgeError {
  constructor(code: 'CONTROLLER_CAPABILITY_MISMATCH' | 'CONTROLLER_CAPABILITY_INCOMPLETE', readonly gaps: string[]) { super(code); }
}
export interface ControllerPromptAudit { kind: 'prompt'; role: 'bridge' | 'route' | 'recap'; controllerId: string; threadId: string; requestId?: string; sourceRequestId?: string; textSha256: string; attachmentHashes: string[] }
export interface ControllerToolResultAudit { kind: 'tool-result'; role: 'bridge' | 'route' | 'recap'; controllerId: string; threadId: string; turnId: string; requestId?: string; callId: string; tool: string; resultSha256: string }
export type ControllerPolicyWireAudit = ControllerPolicyAudit & { kind: 'policy'; role: 'bridge' | 'route' | 'recap'; controllerId: string };
export type ControllerWireAudit = ControllerPromptAudit | ControllerToolResultAudit | ControllerPolicyWireAudit;

/** Production factory has no fake fallback and cannot enable an unprobed tool surface. */
export class ControllerFactory {
  private blocked = false;
  private constructor(private c: Config, private binary: string, private binaryRevision: string, private proofs: Map<string, Capability>, private observer?: (event: ControllerWireAudit) => void) {}
  static async open(c: Config, observer?: (event: ControllerWireAudit) => void): Promise<ControllerFactory> {
    invariant(c.orchestration && c.models && c.routing, 'HIERARCHICAL_CONFIG_REQUIRED');
    const runtime = c.orchestration.controllerRuntime;
    invariant(inside(c.stateRoot, runtime.workRoot) && inside(c.stateRoot, c.orchestration.answers.root), 'CONTROLLER_PRIVATE_ROOT');
    const profiles = new Set([c.orchestration.bridge.modelProfile, c.orchestration.answers.recapModelProfile]);
    const proofs = new Map<string, Capability>();
    const binary = realpathSync(runtime.command), hash = await binaryDigest(binary);
    for (const profile of profiles) {
      const model = c.models[profile]!, digest = modelDigest(model);
      const named = path.join(runtime.workRoot, 'runtime-lock-' + digest + '.json'), defaultFile = path.join(runtime.workRoot, 'runtime-lock.json');
      const file = existsSync(named) ? named : defaultFile;
      invariant(existsSync(file), 'CONTROLLER_CAPABILITY_REQUIRED');
      const proof = record(JSON.parse((await readControlled(runtime.workRoot, file, 131072)).toString('utf8'))) as unknown as Capability;
      const mismatches = [
        ...(proof.binarySha256 === hash ? [] : ['binarySha256']),
        ...(proof.configurationDigest === await controllerConfigurationDigest(runtime.home, model) ? [] : ['configurationDigest']),
        ...(proof.model && modelDigest(proof.model) === digest ? [] : ['modelProfile']),
      ];
      if (mismatches.length) throw new ControllerCapabilityError('CONTROLLER_CAPABILITY_MISMATCH', mismatches);
      const checks = record(proof.checks);
      const gaps = ['firstTurnCompleted', 'resumeSameIdentity', 'dynamicTool', 'modelProfileObserved', 'effectiveToolSurfaceVerified',
        'nativeAutoCompactionDisabledVerified', 'mediaVerified', 'cancellationVerified', 'writerOwnershipVerified'].filter(check => checks[check] !== true);
      if (proof.capabilityReady !== true) gaps.unshift('capabilityReady');
      if (gaps.length) throw new ControllerCapabilityError('CONTROLLER_CAPABILITY_INCOMPLETE', gaps);
      proofs.set(digest, proof);
    }
    const stat = statSync(binary);
    for (const role of ['bridge', 'route', 'recap']) {
      const directory = path.join(runtime.workRoot, role); if (!existsSync(directory)) continue;
      invariant(lstatSync(directory).isDirectory() && !lstatSync(directory).isSymbolicLink(), 'CONTROLLER_PROCESS_REVIEW_REQUIRED');
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (!/^[0-9a-f-]{36}$/.test(entry.name)) continue;
        invariant(entry.isDirectory() && !entry.isSymbolicLink(), 'CONTROLLER_PROCESS_REVIEW_REQUIRED');
        const marker = path.join(directory, entry.name, 'process.json'); if (!existsSync(marker)) continue;
        const markerState = record(JSON.parse((await readControlled(runtime.workRoot, marker, 16384)).toString('utf8')));
        invariant(Number.isSafeInteger(markerState.pid) && (markerState.pid as number) > 0 && typeof markerState.token === 'string' && /^[0-9a-f-]{36}$/.test(markerState.token), 'CONTROLLER_PROCESS_REVIEW_REQUIRED');
        invariant(!processAlive(markerState.pid as number) && !processAlive(-(markerState.pid as number)), 'CONTROLLER_PROCESS_REVIEW_REQUIRED');
        renameSync(marker, marker + '.stopped-' + markerState.token);
      }
    }
    return new ControllerFactory(c, binary, JSON.stringify([stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs]), proofs, observer);
  }
  async create(role: 'bridge' | 'route' | 'recap', id: string, model: ModelProfile): Promise<CodexAppServer> {
    invariant(/^[0-9a-f-]{36}$/.test(id), 'CONTROLLER_ID');
    invariant(!this.blocked, 'CONTROLLER_PROCESS_REVIEW_REQUIRED');
    const runtime = this.c.orchestration!.controllerRuntime, proof = this.proofs.get(modelDigest(model)), stat = statSync(this.binary);
    invariant(proof && proof.configurationDigest === await controllerConfigurationDigest(runtime.home, model) &&
      this.binaryRevision === JSON.stringify([stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs]), 'CONTROLLER_CAPABILITY_MISMATCH');
    const cwd = privateDirectory(path.join(runtime.workRoot, role, id, 'workspace'));
    const marker = path.join(runtime.workRoot, role, id, 'process.json'), token = randomUUID(); let ownsMarker = false;
    invariant(!existsSync(marker), 'CONTROLLER_PROCESS_REVIEW_REQUIRED');
    const env = agentEnvironment({ ...this.c, backend: 'codex', codex: { ...this.c.codex, home: runtime.home } });
    return new CodexAppServer({ command: this.binary, cwd, env, model: model.model, reasoning: model.reasoning,
      contextWindowTokens: model.contextWindowTokens, timeoutMs: this.c.agent.startupTimeoutMs,
      turnTimeoutMs: this.c.orchestration!.limits.controllerDecisionTimeoutMs, killGraceMs: this.c.agent.killGraceMs,
      maxToolCalls: this.c.orchestration!.limits.maxControllerDecisionsPerRequest,
      requireRestrictedPolicy: true,
      maxFrameBytes: this.c.agent.maxFrameBytes, media: { root: path.join(this.c.stateRoot, 'media'), ...this.c.media },
      onSpawn: pid => { writeFileSync(marker, JSON.stringify({ pid, token, controllerId: id, role, binary: this.binary, startedAt: Date.now() }), { flag: 'wx', mode: 0o600 }); ownsMarker = true; },
      onStopped: () => { if (ownsMarker && JSON.parse(readFileSync(marker, 'utf8')).token === token) unlinkSync(marker); },
      onCleanupUnknown: () => { this.blocked = true; },
      promptAudit: event => {
        const audit = { kind: 'prompt' as const, role, controllerId: id, ...event }; this.observer?.(audit);
        process.stderr.write(JSON.stringify({ event: 'controller.prompt_submitted', ...audit }) + '\n');
      },
      toolResultAudit: event => { this.observer?.({ kind: 'tool-result', role, controllerId: id, ...event }); },
      policyAudit: event => { this.observer?.({ kind: 'policy', role, controllerId: id, ...event }); },
    });
  }
}
