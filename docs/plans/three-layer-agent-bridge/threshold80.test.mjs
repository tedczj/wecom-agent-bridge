import test from 'node:test';
import assert from 'node:assert/strict';
import { reached80 } from './threshold80.mjs';
test('fixed 1M window, exact 80% boundaries', () => {
  assert.equal(reached80(799999, 1000000), false);
  assert.equal(reached80(800000, 1000000), true);
  assert.equal(reached80(800001, 1000000), true);
  assert.equal(reached80(0, 1000000), false);
});
test('reject unknown/invalid counts rather than estimating', () => {
  for (const value of [undefined, null, NaN, Infinity, 1.2, '800000']) {
    assert.throws(() => reached80(value, 1000000));
  }
  assert.throws(() => reached80(-1, 1000000));
  assert.throws(() => reached80(1, 0));
});
test('integer arithmetic works without float rounding', () => {
  assert.equal(reached80(4n, 5n), true);
  assert.equal(reached80(3n, 5n), false);
});
