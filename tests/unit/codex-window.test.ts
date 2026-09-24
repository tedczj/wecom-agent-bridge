import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveWindowMetadata } from '../../src/codex-window.ts';

const metadata = (percent = 95, max = 872000) => ({ models: [{ slug: 'model', context_window: 272000, max_context_window: max, effective_context_window_percent: percent }] });
test('OFFLINE native window mapping: usable capacity becomes native total using observed metadata', () => {
  const result = resolveWindowMetadata(metadata(), 'model', 828400);
  assert.equal(result.nativeTotalTokens, 872000); assert.equal(result.effectivePercent, 95); assert.equal(result.usableTokens, 828400);
  assert.equal(resolveWindowMetadata(metadata(80, 1000), 'model', 799).nativeTotalTokens, 999);
  assert.equal(resolveWindowMetadata(metadata(100, 1000), 'model', 799).nativeTotalTokens, 799);
  assert.equal(resolveWindowMetadata(metadata(), 'model', 1).nativeTotalTokens, 2);
});
test('OFFLINE native window mapping: unsupported/unknown capacity never becomes a guessed or smaller window', () => {
  for (const value of [828401, 1000000, Number.MAX_SAFE_INTEGER]) assert.throws(() => resolveWindowMetadata(metadata(), 'model', value), /CONTEXT_WINDOW_MISMATCH/);
  for (const value of [0, -1, 1.1, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => resolveWindowMetadata(metadata(), 'model', value), /EXECUTION_CONTEXT_WINDOW/);
  for (const data of [{ models: [] }, { models: [{ slug: 'model' }] }, metadata(0), metadata(101), metadata(95, -1),
    { models: [...metadata().models, ...metadata().models] }]) assert.throws(() => resolveWindowMetadata(data, 'model', 1), /CODEX_WINDOW_METADATA_UNAVAILABLE/);
});
