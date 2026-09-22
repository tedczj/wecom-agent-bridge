/** Only allowlisted error codes cross the transport/log boundary. */
export class BridgeError extends Error {
  constructor(readonly code: string) { super(code); this.name = 'BridgeError'; }
}
export class BackendStateUnknown extends BridgeError {
  constructor() { super('BACKEND_STATE_UNKNOWN'); }
}
export class DeliveryError extends BridgeError {
  constructor(code: string, readonly disposition: 'not-sent' | 'retryable' | 'permanent' | 'unknown') { super(code); }
}
export function errorCode(error: unknown, fallback = 'INTERNAL_ERROR'): string {
  return error instanceof BridgeError && /^[A-Z0-9_]{1,80}$/.test(error.code) ? error.code : fallback;
}
export function invariant(value: unknown, code: string): asserts value { if (!value) throw new BridgeError(code); }
export function record(value: unknown): Record<string, unknown> {
  invariant(value !== null && typeof value === 'object' && !Array.isArray(value), 'INVALID_OBJECT');
  return value as Record<string, unknown>;
}
export function log(event: string, fields: { taskId?: string; code?: string; state?: string; bytes?: number } = {}): void {
  // stdout belongs exclusively to the local JSONL protocol.
  process.stderr.write(JSON.stringify({ event: /^[a-z0-9_.-]+$/.test(event) ? event : 'event',
    taskId: fields.taskId?.match(/^[0-9a-f-]{8,36}$/)?.[0],
    code: fields.code?.match(/^[A-Z0-9_]{1,80}$/)?.[0],
    state: fields.state?.match(/^[a-z_]{1,30}$/)?.[0], bytes: fields.bytes }) + '\n');
}
