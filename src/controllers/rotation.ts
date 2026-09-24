import { invariant, record } from '../errors.ts';
import type { ContextUsageSnapshot, ControllerRef } from './runtime.ts';

export function reached80(usedTokens: bigint, contextWindowTokens: bigint): boolean {
  invariant(usedTokens >= 0n && contextWindowTokens > 0n, 'INVALID_USAGE');
  return usedTokens * 5n >= contextWindowTokens * 4n;
}

/** Only a sample belonging to the just-completed turn can authorize another turn. */
export function completedUsage(params: Record<string, unknown>, ref: ControllerRef, turnId: string,
  expectedWindow: number, now = Date.now()): ContextUsageSnapshot {
  invariant(params.threadId === ref.threadId && params.turnId === turnId, 'USAGE_IDENTITY_MISMATCH');
  const usage = record(params.tokenUsage), last = record(usage.last);
  const used = last.totalTokens, window = usage.modelContextWindow;
  invariant(typeof used === 'number' && Number.isSafeInteger(used) && used >= 0, 'INVALID_USAGE');
  invariant(typeof window === 'number' && Number.isSafeInteger(window) && window > 0, 'INVALID_USAGE');
  invariant(window === expectedWindow, 'CONTEXT_WINDOW_MISMATCH');
  return { threadId: ref.threadId, turnId, usedTokens: used, contextWindowTokens: window,
    origin: 'runtime', basis: 'last-completed-request-total', observedAt: now, validForGeneration: ref.generation };
}
