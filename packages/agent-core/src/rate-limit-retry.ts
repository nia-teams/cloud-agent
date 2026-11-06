import { setTimeout } from 'node:timers/promises';
export function isRateLimitError(error: unknown): boolean {
    const seen = new Set<unknown>();
    let current = error;
    while (current && typeof current === 'object' && !seen.has(current)) {
        seen.add(current);
        const value = current as {
            status?: unknown;
            statusCode?: unknown;
            response?: {
                status?: unknown;
            };
            message?: unknown;
            cause?: unknown;
        };
        if (value.status === 429 || value.statusCode === 429 || value.response?.status === 429)
            return true;
        if (typeof value.message === 'string' && /\b429\b/.test(value.message))
            return true;
        current = value.cause;
    }
    return false;
}
export function rateLimitDelayMs(error: unknown, now = Date.now()): number | null {
    const seen = new Set<unknown>();
    let current = error;
    while (current && typeof current === 'object' && !seen.has(current)) {
        seen.add(current);
        const value = current as {
            retryAfter?: unknown;
            headers?: Headers | Record<string, unknown>;
            cause?: unknown;
        };
        const headers = value.headers;
        const raw = value.retryAfter ?? (headers && typeof (headers as Headers).get === 'function'
            ? (headers as Headers).get('retry-after')
            : headers ? Object.entries(headers).find(([key]) => key.toLowerCase() === 'retry-after')?.[1] : undefined);
        if (typeof raw === 'string' || typeof raw === 'number') {
            const text = String(raw).trim();
            const seconds = /^\d+(?:\.\d+)?$/.test(text) ? Number(text) : NaN;
            const delay = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(text) - now;
            if (Number.isFinite(delay) && delay >= 0)
                return delay <= 300000 ? delay : null;
        }
        current = value.cause;
    }
    return 60000;
}
export async function waitForRateLimit(delayMs: number, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    await setTimeout(delayMs, undefined, { signal });
    signal.throwIfAborted();
}
