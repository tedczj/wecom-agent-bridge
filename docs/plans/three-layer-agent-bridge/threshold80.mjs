// Reference helper for the frozen rule, not an implementation of the Bridge runtime.
// Only already-observed runtime context usage is accepted; no future-token argument.
export function reached80(usedTokens, contextWindowTokens) {
  const asCount = (value, name) => {
    if (typeof value === 'bigint') return value;
    if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
      throw new TypeError(`${name} must be a safe integer or bigint`);
    }
    return BigInt(value);
  };
  const used = asCount(usedTokens, 'usedTokens');
  const window = asCount(contextWindowTokens, 'contextWindowTokens');
  if (used < 0n || window <= 0n) throw new RangeError('INVALID_USAGE');
  return used * 5n >= window * 4n;
}
