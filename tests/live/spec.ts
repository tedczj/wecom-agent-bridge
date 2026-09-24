import { invariant, record } from '../../src/errors.ts';
export type LiveSuite = 'probe' | 'core' | 'fault' | 'large-context' | 'weixin';
export interface LiveAssertion { id: string; predicate: string; expected: string }
export interface LiveCase { id: string; title: string; suite: LiveSuite; evidenceTier: string; repeat: number;
  requires: string[]; setup: string[]; steps: Array<{ order: number; action: string; detail: string }>; assertions: LiveAssertion[]; evidence: string[] }
export interface LiveSpecification { globalAssertions: string[]; cases: LiveCase[] }
export function parseLiveSpecification(input: unknown): LiveSpecification {
  const value = record(input), frozen = record(value.frozenRules);
  invariant(value.schemaVersion === 1 && value.specVersion === '1.0' && value.repository === 'tedczj/wecom-agent-bridge', 'LIVE_SPEC_VERSION');
  invariant(frozen.rotationThresholdNumerator === 4 && frozen.rotationThresholdDenominator === 5 && frozen.predictFutureTokens === false &&
    frozen.rewriteUserQuery === false && frozen.injectBusinessHistory === false && frozen.bridgeReadRawAnswer === false, 'LIVE_FROZEN_RULE');
  const strings = (value: unknown): string[] => { invariant(Array.isArray(value) && value.every(s => typeof s === 'string' && s.length > 0), 'LIVE_SPEC_SCHEMA'); return value as string[]; };
  invariant(Array.isArray(value.cases), 'LIVE_SPEC_SCHEMA');
  const ids = new Set<string>(), assertions = new Set<string>();
  const cases = value.cases.map(item => {
    const c = record(item);
    invariant(typeof c.id === 'string' && /^LIVE-(?:\d{2}|W\d{2})$/.test(c.id) && !ids.has(c.id), 'LIVE_CASE_ID'); ids.add(c.id);
    invariant(typeof c.title === 'string' && ['probe', 'core', 'fault', 'large-context', 'weixin'].includes(String(c.suite)) && typeof c.evidenceTier === 'string' &&
      Number.isSafeInteger(c.repeat) && Number(c.repeat) > 0 && Array.isArray(c.steps) && Array.isArray(c.assertions), 'LIVE_SPEC_SCHEMA');
    const steps = c.steps.map((step, index) => {
      const s = record(step); invariant(s.order === index + 1 && ['user', 'runner', 'probe', 'fault', 'assert'].includes(String(s.action)) && typeof s.detail === 'string', 'LIVE_STEP_SCHEMA');
      return { order: s.order as number, action: s.action as string, detail: s.detail };
    });
    const checks = c.assertions.map(assertion => {
      const a = record(assertion); invariant(typeof a.id === 'string' && a.id.startsWith(c.id + '-A') && !assertions.has(a.id) && typeof a.predicate === 'string' && typeof a.expected === 'string', 'LIVE_ASSERTION_SCHEMA');
      assertions.add(a.id); return { id: a.id, predicate: a.predicate, expected: a.expected };
    });
    return { id: c.id, title: c.title, suite: c.suite as LiveSuite, evidenceTier: c.evidenceTier, repeat: c.repeat as number,
      requires: strings(c.requires), setup: strings(c.setup), steps, assertions: checks, evidence: strings(c.evidence) };
  });
  invariant(cases.length === 33 && assertions.size === 145, 'LIVE_SPEC_COVERAGE');
  return { cases, globalAssertions: strings(value.globalAssertions) };
}
