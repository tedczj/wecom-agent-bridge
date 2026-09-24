import type { LiveCase } from './spec.ts';
import { invariant } from '../../src/errors.ts';
export type LiveStatus = 'PASS' | 'FAIL' | 'BLOCKED' | 'NOT_RUN';
export interface AssertionResult { id: string; predicate: string; expected: string; status: LiveStatus; actual?: unknown; evidence?: string[]; evidenceSha256?: Record<string, string>; reason?: string }
export interface CaseResult { caseId: string; attempt: number; tier: string; status: LiveStatus; assertions: AssertionResult[]; blockedReason?: string; failureCode?: string; cleanupConfirmed?: boolean }
export function caseStatus(assertions: AssertionResult[]): LiveStatus {
  invariant(assertions.every(a => ['PASS', 'FAIL', 'BLOCKED', 'NOT_RUN'].includes(a.status)), 'LIVE_ASSERTION_STATUS');
  invariant(assertions.every(a => a.status !== 'PASS' || a.evidence?.length), 'LIVE_PASS_WITHOUT_EVIDENCE');
  if (assertions.some(a => a.status === 'FAIL')) return 'FAIL';
  if (assertions.some(a => a.status === 'BLOCKED')) return 'BLOCKED';
  if (!assertions.length || assertions.some(a => a.status === 'NOT_RUN')) return 'NOT_RUN';
  return 'PASS';
}
export function blockedCase(test: LiveCase, attempt: number, globals: string[], reason: string): CaseResult {
  const assertions: AssertionResult[] = [...test.assertions.map(a => ({ ...a, status: 'BLOCKED' as const, reason })),
    ...globals.map(predicate => ({ id: test.id + '-GLOBAL-' + predicate, predicate, expected: 'true', status: 'BLOCKED' as const, reason }))];
  return { caseId: test.id, attempt, tier: test.evidenceTier, status: caseStatus(assertions), assertions, blockedReason: reason };
}
/** Every named requirement must be represented; partial observations cannot become a case PASS. */
export function finalizeCase(test: LiveCase, attempt: number, globals: string[], results: AssertionResult[]): CaseResult {
  const expected = new Map([...test.assertions, ...globals.map(predicate => ({ id: test.id + '-GLOBAL-' + predicate, predicate, expected: 'true' }))].map(a => [a.id, a]));
  invariant(results.length === expected.size && results.every(result => {
    const assertion = expected.get(result.id);
    return assertion && result.predicate === assertion.predicate && result.expected === assertion.expected && expected.delete(result.id);
  }) && expected.size === 0, 'LIVE_ASSERTION_COVERAGE');
  return { caseId: test.id, attempt, tier: test.evidenceTier, assertions: results, status: caseStatus(results) };
}
