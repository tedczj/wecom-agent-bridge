import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { CodexAppServer, controllerPolicy } from '../src/controllers/codex-app-server.ts';
import { invariant, record, errorCode } from '../src/errors.ts';
import type { ControllerTool } from '../src/controllers/runtime.ts';
import { checkCodexWriter } from '../src/history/writer-readiness.ts';
import { binaryDigest, controllerConfigurationDigest } from '../src/controllers/factory.ts';
import type { ModelProfile } from '../src/orchestration/config.ts';
import type { ImageRef } from '../src/types.ts';
import sharp from 'sharp';
import { deadline } from '../src/async.ts';

const hash = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
function schemaDigest(root: string): string {
  const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap(e =>
    e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]);
  return hash(walk(root).sort().map(file => path.relative(root, file) + '\0' + hash(readFileSync(file))).join('\n'));
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  invariant(args.includes('--live'), 'LIVE_OPT_IN_REQUIRED');
  invariant(args.every((arg, i) => arg === '--live' || ['--config', '--out'].includes(arg) || i > 0 && ['--config', '--out'].includes(args[i - 1]!)), 'PROBE_ARGUMENT');
  const argument = (name: string) => { const i = args.indexOf(name); invariant(i >= 0 && args[i + 1] && !args[i + 1]!.startsWith('--'), 'PROBE_ARGUMENT'); return args[i + 1]!; };
  const configBytes = readFileSync(argument('--config'));
  const config = record(JSON.parse(configBytes.toString('utf8'))), models = record(config.models);
  const orchestration = record(config.orchestration), runtime = record(orchestration.controllerRuntime);
  const profile = record(models[String(record(orchestration.bridge).modelProfile)]);
  invariant(runtime.kind === 'codex-app-server' && runtime.transport === 'stdio', 'CONTROLLER_RUNTIME');
  for (const key of ['command', 'home']) invariant(typeof runtime[key] === 'string' && path.isAbsolute(runtime[key] as string), 'CONFIG_PATH');
  invariant(typeof profile.model === 'string' && typeof profile.reasoning === 'string' && Number.isSafeInteger(profile.contextWindowTokens), 'CONFIG_MODEL');
  const root = path.resolve(argument('--out'), randomUUID());
  mkdirSync(root, { recursive: true, mode: 0o700 }); chmodSync(root, 0o700);
  const save = (name: string, value: unknown) => writeFileSync(path.join(root, name), JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  const cwd = path.join(root, 'empty-workspace'); mkdirSync(cwd, { mode: 0o700 });
  const mediaRoot = path.join(root, 'media'); mkdirSync(mediaRoot, { mode: 0o700 });
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH ?? '/usr/bin:/bin', LANG: 'C.UTF-8', CODEX_HOME: runtime.home as string };
  // No credential copying, environment wildcard inheritance, or provider fallback.
  const command = runtime.command as string;
  const version = execFileSync(command, ['--version'], { env, encoding: 'utf8', timeout: 30000 }).trim();
  const schemaRoot = path.join(root, 'schema');
  execFileSync(command, ['app-server', 'generate-json-schema', '--experimental', '--out', schemaRoot], { env, timeout: 30000, stdio: 'pipe' });
  const schemaHash = schemaDigest(schemaRoot);
  const binarySha256 = await binaryDigest(command), configurationDigest = await controllerConfigurationDigest(runtime.home as string, profile as unknown as ModelProfile);
  const gitSha = execFileSync('git', ['rev-parse', 'HEAD'], { env, encoding: 'utf8' }).trim();
  const evidence: Record<string, unknown> = { caseId: 'LIVE-00', tier: 'LIVE_LOCAL', status: 'BLOCKED', gitSha,
    version, schemaHash, configHash: hash(configBytes), platform: process.platform, arch: process.arch,
    requested: profile, providerObserved: 'unknown', cost: 'unknown', startedAt: new Date().toISOString(), checks: {} };
  const checks = evidence.checks as Record<string, unknown>;
  const server = new CodexAppServer({ command, env, cwd, model: profile.model, reasoning: profile.reasoning,
    contextWindowTokens: profile.contextWindowTokens as number, timeoutMs: 30000, turnTimeoutMs: 90000,
    killGraceMs: 3000, maxFrameBytes: 8388608, media: { root: mediaRoot, maxImages: 1, maxImageBytes: 1048576, maxTotalBytes: 1048576 } });
  const usageEvents: unknown[] = [], methods = new Set<string>();
  server.protocol.subscribe((method, params) => {
    methods.add(method);
    if (method === 'thread/tokenUsage/updated') usageEvents.push(params);
  }, () => {});
  const tool: ControllerTool = { name: 'probe_read', description: 'Return a synthetic read-only capability marker.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false } };
  const instructions = 'You are a capability probe. Use only the supplied probe_read tool when requested. Never use other tools. Return a short final answer.';
  let calls = 0;
  let completedProbe = false;
  try {
    const ref = await server.create(0, instructions, [tool]);
    // Role identity is persisted before the first prompt, including failed probes.
    save('controller-roles.json', [{ ...ref, role: 'bridge', cwd, scope: path.basename(root) }]);
    checks.create = true;
    checks.writerDuringServer = await checkCodexWriter(runtime.home as string, ref.threadId);
    const first = await server.run(ref, '只回复“能力探测完成”。', async () => { throw new Error('UNEXPECTED_TOOL'); });
    checks.firstTurnCompleted = true; checks.usage = first.usage ?? null;
    await server.resume(ref, instructions, [tool]); checks.resumeSameIdentity = true;
    const second = await server.run(ref, '请调用一次 probe_read，然后只回复“完成”。', async (name, args) => {
      invariant(name === 'probe_read' && Object.keys(args).length === 0, 'PROBE_TOOL_ARGUMENTS');
      calls++; return { marker: 'synthetic-read-only' };
    });
    checks.dynamicTool = calls === 1; checks.secondUsage = second.usage ?? null;
    checks.modelProfileObserved = true;
    const bytes = await sharp({ create: { width: 32, height: 32, channels: 3, background: '#ff0000' } }).png().toBuffer();
    const imageFile = path.join(mediaRoot, 'image.png'); writeFileSync(imageFile, bytes, { mode: 0o600 });
    const image: ImageRef = { id: randomUUID(), localPath: imageFile, mimeType: 'image/png', sha256: hash(bytes), bytes: bytes.length, width: 32, height: 32, source: 'message' };
    const vision = await server.run(ref, '只回答图片主色，一个中文词，不要调用工具。', async () => { throw new Error('UNEXPECTED_TOOL'); }, undefined, [image]);
    checks.mediaVerified = /^(?:红色|红)[。.!]?$/.test(vision.text.trim());
    save('media-check.json', { inputSha256: image.sha256, answerSha256: hash(vision.text), matchedExpectedColor: checks.mediaVerified, usage: vision.usage });
    const cancellation = new AbortController(); let reached!: () => void;
    const callback = new Promise<void>(resolve => { reached = resolve; });
    const running = server.run(ref, '调用一次 probe_read，然后等待其结果。', async () => {
      reached(); await new Promise<void>(resolve => { if (cancellation.signal.aborted) resolve(); else cancellation.signal.addEventListener('abort', () => resolve(), { once: true }); });
      return { cancelled: true };
    }, cancellation.signal);
    void running.catch(() => {});
    await deadline(Promise.race([callback, running.then(() => { invariant(false, 'PROBE_TOOL_NOT_CALLED'); })]), 30000, 'PROBE_TOOL_TIMEOUT');
    cancellation.abort();
    try { await running; checks.cancellationVerified = false; }
    catch (error) { checks.cancellationVerified = errorCode(error) === 'CONTROLLER_CANCELLED' && await checkCodexWriter(runtime.home as string, ref.threadId) === 'idle'; }
    const policies = server.policyObservations;
    const covered = [first.turnId, second.turnId, vision.turnId].every(turnId => policies.some(policy => policy.threadId === ref.threadId && policy.turnId === turnId));
    checks.effectiveToolSurfaceVerified = covered;
    checks.nativeAutoCompactionDisabledVerified = covered && policies.every(policy => policy.nativeAutoCompaction === 'disabled');
    completedProbe = true;
    if (!covered) evidence.blockedReason = 'TOOL_SURFACE_AND_COMPACTION_UNVERIFIED';
  } catch (e) {
    evidence.blockedReason = errorCode(e, 'CONTROLLER_PROBE_FAILED');
    if (e instanceof Error && e.cause) save('private-rejection.json', e.cause);
  }
  finally {
    save('controller-roles.json', server.createdRefs.map(ref => ({ ...ref, role: 'bridge', cwd, scope: path.basename(root) })));
    const native = server.createdRefs.at(-1);
    if (native && checks.writerDuringServer === undefined) checks.writerDuringServer = await checkCodexWriter(runtime.home as string, native.threadId);
    try { await server.close(); checks.processGroupStopped = true; }
    catch (e) { checks.processGroupStopped = false; evidence.blockedReason = errorCode(e, 'CONTROLLER_CLEANUP_FAILED'); }
    evidence.observed = server.observations;
    if (native) {
      checks.writerAfterServer = await checkCodexWriter(runtime.home as string, native.threadId);
      checks.writerOwnershipVerified = checks.writerDuringServer === 'busy' && checks.writerAfterServer === 'idle';
    }
    evidence.finishedAt = new Date().toISOString();
    save('usage-event.json', usageEvents);
    checks.configurationUnchanged = configurationDigest === await controllerConfigurationDigest(runtime.home as string, profile as unknown as ModelProfile);
    checks.binaryUnchanged = binarySha256 === await binaryDigest(command);
    const required = ['firstTurnCompleted', 'resumeSameIdentity', 'dynamicTool', 'modelProfileObserved', 'effectiveToolSurfaceVerified',
      'nativeAutoCompactionDisabledVerified', 'mediaVerified', 'cancellationVerified', 'writerOwnershipVerified', 'processGroupStopped', 'configurationUnchanged', 'binaryUnchanged'];
    const capabilityReady = completedProbe && required.every(check => checks[check] === true);
    evidence.status = capabilityReady ? 'PASS' : 'BLOCKED';
    if (capabilityReady) delete evidence.blockedReason;
    else evidence.blockedReason ??= 'CONTROLLER_CAPABILITY_INCOMPLETE';
    save('effective-tool-policy.json', { requested: controllerPolicy, verified: checks.effectiveToolSurfaceVerified === true,
      observed: server.policyObservations, eventMethods: [...methods].sort() });
    save('runtime-lock.json', { version, schemaHash, configHash: hash(configBytes), configurationDigest, binarySha256,
      model: profile, checks, capabilityReady, writerOwnershipVerified: checks.writerOwnershipVerified === true });
    save('probe.json', evidence);
    process.stdout.write(JSON.stringify({ status: evidence.status, reason: evidence.blockedReason, evidence: root }) + '\n');
    process.exitCode = capabilityReady ? 0 : 1;
  }
}
main().catch(e => { process.stderr.write(errorCode(e, 'PROBE_FAILED') + '\n'); process.exitCode = 1; });
