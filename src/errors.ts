/** Only codes created here may be logged or sent remotely; never stringify SDK errors. */
export class BridgeError extends Error {
    readonly code: string;
    constructor(code: string) { super(code); this.name = 'BridgeError'; this.code = code; }
}
export class BackendStateUnknown extends BridgeError {
    constructor() { super('BACKEND_STATE_UNKNOWN'); }
}
export class DeliveryError extends BridgeError {
    readonly disposition: 'not-sent' | 'retryable' | 'permanent' | 'unknown';
    constructor(code: string, disposition: DeliveryError['disposition']) { super(code); this.disposition = disposition; }
}
export function errorCode(error: unknown, fallback = 'INTERNAL_ERROR'): string {
    return error instanceof BridgeError && /^[A-Z0-9_]{1,80}$/.test(error.code) ? error.code : fallback;
}
export function invariant(value: unknown, code: string): asserts value {
    if (!value)
        throw new BridgeError(code);
}
export function record(value: unknown): Record<string, unknown> {
    invariant(value !== null && typeof value === 'object' && !Array.isArray(value), 'INVALID_OBJECT');
    return value as Record<string, unknown>;
}
export function log(event: string, fields: {
    taskId?: string;
    code?: string;
    state?: string;
    bytes?: number;
} = {}): void {
    // Deliberately do not accept generic objects: errors may carry HTTP credentials.
    const out = { event: /^[a-z0-9_.-]+$/.test(event) ? event : 'event',
        taskId: fields.taskId?.match(/^[0-9a-f-]{8,36}$/)?.[0],
        code: fields.code?.match(/^[A-Z0-9_]{1,80}$/)?.[0],
        state: fields.state?.match(/^[a-z_]{1,30}$/)?.[0], bytes: fields.bytes };
    process.stdout.write(JSON.stringify(out) + '\n');
}
