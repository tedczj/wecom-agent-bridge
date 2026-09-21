import { DeliveryError, errorCode, invariant } from './errors.ts';
import type { Channel, Route } from './types.ts';
import type { Config } from './config.ts';
import type { Store } from './store.ts';
import { deadline } from './async.ts';
export function splitText(text: string, bytes: number): string[] {
    invariant(Number.isSafeInteger(bytes) && bytes >= 4, 'CHUNK_BUDGET');
    const result: string[] = [];
    let part = '';
    let size = 0;
    for (const cp of text) {
        const n = Buffer.byteLength(cp);
        if (size + n > bytes) {
            result.push(part);
            part = '';
            size = 0;
        }
        part += cp;
        size += n;
    }
    if (part || !result.length)
        result.push(part);
    return result;
}
export function boundedResult(text: string, cap: number): {
    text: string;
    truncated: boolean;
} {
    if (Buffer.byteLength(text) <= cap)
        return { text, truncated: false };
    const suffix = '\n[OUTPUT_TRUNCATED：结果超过保存上限]';
    return { text: splitText(text, cap - Buffer.byteLength(suffix))[0]! + suffix, truncated: true };
}
export function resultParts(taskId: string, text: string, bytes: number): string[] {
    const pieces = splitText(text, bytes - 96);
    return pieces.map((body, i) => {
        const next = i + 1 < pieces.length ? `\n下一段: /result ${taskId} ${i + 2}` : '';
        const rendered = `[${taskId.slice(0, 8)} ${i + 1}/${pieces.length}]\n${body}${next}`;
        invariant(Buffer.byteLength(rendered) <= bytes, 'REPLY_TOO_LARGE');
        return rendered;
    });
}
export class OutboxPump {
    private busy = false;
    private nextSend = 0;
    constructor(private store: Store, private channel: Channel, private config: Config['reply']) { }
    async tick(now = Date.now()): Promise<boolean> {
        if (this.busy || !this.channel.ready || now < this.nextSend)
            return false;
        const item = this.store.claimDelivery(now);
        if (!item)
            return false;
        this.busy = true;
        this.nextSend = now + this.config.minIntervalMs;
        try {
            await deadline(this.channel.send(JSON.parse(item.target_json) as Route, JSON.parse(item.body_json).text), this.config.sendTimeoutMs, 'SEND_TIMEOUT');
            this.store.deliveryState(item.delivery_id, 'sent');
        }
        catch (e) {
            const code = errorCode(e, 'SEND_UNKNOWN');
            if (e instanceof DeliveryError && e.disposition === 'not-sent')
                this.store.deliveryState(item.delivery_id, 'pending', code, now + 1000, true);
            else if (e instanceof DeliveryError && e.disposition === 'retryable' && item.attempts < 3)
                this.store.deliveryState(item.delivery_id, 'pending', code, now + 1000 * 2 ** item.attempts);
            else
                this.store.deliveryState(item.delivery_id, e instanceof DeliveryError && ['permanent', 'retryable'].includes(e.disposition) ? 'failed' : 'unknown', code);
        }
        finally {
            this.busy = false;
        }
        return true;
    }
}
