import { BridgeError } from './errors.ts';
export function aborted(signal: AbortSignal): Promise<never> {
    return new Promise((_, reject) => {
        if (signal.aborted)
            reject(new BridgeError('ABORTED'));
        else
            signal.addEventListener('abort', () => reject(new BridgeError('ABORTED')), { once: true });
    });
}
/** A cancellable race which removes its listener even when the operation wins. */
export async function withSignal<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
    let listener: () => void = () => { };
    const cancel = new Promise<never>((_, reject) => {
        listener = () => reject(new BridgeError('ABORTED'));
        if (signal.aborted)
            listener();
        else
            signal.addEventListener('abort', listener, { once: true });
    });
    try {
        return await Promise.race([work, cancel]);
    }
    finally {
        signal.removeEventListener('abort', listener);
    }
}
export async function deadline<T>(work: Promise<T>, ms: number, code: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new BridgeError(code)), ms); })]);
    }
    finally {
        clearTimeout(timer);
    }
}
