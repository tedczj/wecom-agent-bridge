import { createHash } from 'node:crypto';
import path from 'node:path';
import { invariant, record } from '../errors.ts';

export interface ModelProfile { model: string; reasoning: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'; contextWindowTokens: number }
export type ModelSource = 'request' | 'session-explicit' | 'directory' | 'daily';
export type ModelSources = Record<keyof ModelProfile, ModelSource>;
export interface OrchestrationConfig {
  mode: 'hierarchical';
  controllerRuntime: { kind: 'codex-app-server'; transport: 'stdio'; command: string; home: string; workRoot: string;
    requireCapabilityProbe: true; nativeAutoCompaction: 'disabled' };
  bridge: { modelProfile: string };
  route: { inheritModelFrom: 'bridge'; initialization: 'lazy' };
  business: { defaultModelProfile: string };
  rotation: { thresholdNumerator: 4; thresholdDenominator: 5; usageSource: 'runtime-only'; mode: 'new-session-with-handoff' };
  query: { mode: 'verbatim'; injectHistoricalContext: false };
  answers: { root: string; maxOriginalBytes: number; shortAnswerMaxChars: number; recapMaxChars: number; recapModelProfile: string; bridgeCanReadOriginal: false };
  history: { defaultInteractionLimit: number; defaultSessionLimit: number; maxOriginalPageBytes: number };
  limits: { maxControllerDecisionsPerRequest: number; controllerDecisionTimeoutMs: number; passiveChildWaitUsesBusinessDeadline: true; businessWorkers: 1 };
}
function strict(value: unknown, keys: string[]): Record<string, unknown> {
  const o = record(value); invariant(Object.keys(o).every(key => keys.includes(key)), 'ORCHESTRATION_UNKNOWN_KEY'); return o;
}
function text(value: unknown): string {
  invariant(typeof value === 'string' && value.length > 0 && value.length < 4096 && !value.includes('\0'), 'CONFIG_STRING'); return value;
}
function absolute(value: unknown): string { const result = text(value); invariant(path.isAbsolute(result), 'CONFIG_PATH'); return path.resolve(result); }
function number(value: unknown, min: number, max: number): number {
  invariant(typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max, 'CONFIG_NUMBER'); return value;
}
function fixed<T extends string | boolean | number>(actual: unknown, expected: T): T {
  invariant(actual === expected, 'ORCHESTRATION_FROZEN_RULE'); return expected;
}
export function parseModels(value: unknown): Record<string, ModelProfile> {
  const models = record(value), result: Record<string, ModelProfile> = {};
  invariant(Object.keys(models).length > 0 && Object.keys(models).length <= 32, 'CONFIG_MODELS');
  for (const [name, entry] of Object.entries(models)) {
    invariant(/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(name), 'CONFIG_MODEL_NAME');
    const model = strict(entry, ['model', 'reasoning', 'contextWindowTokens']);
    invariant(['minimal', 'low', 'medium', 'high', 'xhigh'].includes(String(model.reasoning ?? 'high')), 'CONFIG_REASONING');
    result[name] = { model: text(model.model ?? 'gpt-6-sol'), reasoning: (model.reasoning ?? 'high') as ModelProfile['reasoning'],
      contextWindowTokens: number(model.contextWindowTokens, 1, Number.MAX_SAFE_INTEGER) };
  }
  invariant(Object.hasOwn(result, 'daily'), 'CONFIG_DAILY_REQUIRED');
  return result;
}
export function parseOrchestration(value: unknown, models: Record<string, ModelProfile>): OrchestrationConfig {
  const o = strict(value, ['mode', 'controllerRuntime', 'bridge', 'route', 'business', 'rotation', 'query', 'answers', 'history', 'limits']);
  const runtime = strict(o.controllerRuntime, ['kind', 'transport', 'command', 'home', 'workRoot', 'requireCapabilityProbe', 'nativeAutoCompaction']);
  const bridge = strict(o.bridge, ['modelProfile']), route = strict(o.route, ['inheritModelFrom', 'initialization']);
  const business = strict(o.business, ['defaultModelProfile']), rotation = strict(o.rotation, ['thresholdNumerator', 'thresholdDenominator', 'usageSource', 'mode']);
  const query = strict(o.query, ['mode', 'injectHistoricalContext']);
  const answers = strict(o.answers, ['root', 'maxOriginalBytes', 'shortAnswerMaxChars', 'recapMaxChars', 'recapModelProfile', 'bridgeCanReadOriginal']);
  const history = strict(o.history, ['defaultInteractionLimit', 'defaultSessionLimit', 'maxOriginalPageBytes']);
  const limits = strict(o.limits, ['maxControllerDecisionsPerRequest', 'controllerDecisionTimeoutMs', 'passiveChildWaitUsesBusinessDeadline', 'businessWorkers']);
  const profile = (value: unknown) => { const name = text(value); invariant(Object.hasOwn(models, name), 'CONFIG_MODEL_PROFILE'); return name; };
  return {
    mode: fixed(o.mode, 'hierarchical'),
    controllerRuntime: { kind: fixed(runtime.kind, 'codex-app-server'), transport: fixed(runtime.transport, 'stdio'), command: absolute(runtime.command),
      home: absolute(runtime.home), workRoot: absolute(runtime.workRoot), requireCapabilityProbe: fixed(runtime.requireCapabilityProbe, true), nativeAutoCompaction: fixed(runtime.nativeAutoCompaction, 'disabled') },
    bridge: { modelProfile: profile(bridge.modelProfile ?? 'daily') },
    route: { inheritModelFrom: fixed(route.inheritModelFrom, 'bridge'), initialization: fixed(route.initialization, 'lazy') },
    business: { defaultModelProfile: profile(business.defaultModelProfile ?? 'daily') },
    rotation: { thresholdNumerator: fixed(rotation.thresholdNumerator, 4), thresholdDenominator: fixed(rotation.thresholdDenominator, 5),
      usageSource: fixed(rotation.usageSource, 'runtime-only'), mode: fixed(rotation.mode, 'new-session-with-handoff') },
    query: { mode: fixed(query.mode, 'verbatim'), injectHistoricalContext: fixed(query.injectHistoricalContext, false) },
    answers: { root: absolute(answers.root), maxOriginalBytes: number(answers.maxOriginalBytes, 1, 16777216), shortAnswerMaxChars: number(answers.shortAnswerMaxChars, 1, 1200),
      recapMaxChars: number(answers.recapMaxChars, 1, 1000), recapModelProfile: profile(answers.recapModelProfile ?? bridge.modelProfile ?? 'daily'), bridgeCanReadOriginal: fixed(answers.bridgeCanReadOriginal, false) },
    history: { defaultInteractionLimit: number(history.defaultInteractionLimit, 1, 30), defaultSessionLimit: number(history.defaultSessionLimit, 1, 100), maxOriginalPageBytes: number(history.maxOriginalPageBytes, 1, 16384) },
    limits: { maxControllerDecisionsPerRequest: number(limits.maxControllerDecisionsPerRequest, 1, 100), controllerDecisionTimeoutMs: number(limits.controllerDecisionTimeoutMs, 1, 300000),
      passiveChildWaitUsesBusinessDeadline: fixed(limits.passiveChildWaitUsesBusinessDeadline, true), businessWorkers: fixed(limits.businessWorkers, 1) },
  };
}
export function modelDigest(profile: ModelProfile): string {
  return createHash('sha256').update(JSON.stringify([profile.model, profile.reasoning, profile.contextWindowTokens])).digest('hex');
}
export function selectModel(daily: ModelProfile, overrides: Partial<Record<Exclude<ModelSource, 'daily'>, Partial<ModelProfile>>>): { profile: ModelProfile; source: ModelSource; sources: ModelSources; digest: string } {
  const profile = { ...daily }, sources: ModelSources = { model: 'daily', reasoning: 'daily', contextWindowTokens: 'daily' };
  let source: ModelSource = 'daily';
  for (const level of ['directory', 'session-explicit', 'request'] as const) {
    const values = overrides[level]; if (!values) continue;
    if (values.model !== undefined) { profile.model = values.model; sources.model = level; source = level; }
    if (values.reasoning !== undefined) { profile.reasoning = values.reasoning; sources.reasoning = level; source = level; }
    if (values.contextWindowTokens !== undefined) { profile.contextWindowTokens = values.contextWindowTokens; sources.contextWindowTokens = level; source = level; }
  }
  return { profile, source, sources, digest: modelDigest(profile) };
}
