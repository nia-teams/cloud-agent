import type { ILLMClient } from './protocol/index.js';
import type { Logger } from './logger.js';
export type DecisionQuestion = Record<string, unknown>;
export interface DecisionRequest {
    state: unknown;
    questions: Record<string, DecisionQuestion>;
    signal?: AbortSignal;
}
export interface DecisionUsage {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    usdCost?: number;
}
export interface DecisionResponse {
    model: string;
    answers: Record<string, unknown>;
    raw: Record<string, unknown>;
    usage?: DecisionUsage;
    latencyMs: number;
}
export interface DecisionClientOptions {
    client: ILLMClient;
    timeoutMs?: number;
    logger?: Logger;
}
export interface DecisionClient {
    decide(request: DecisionRequest): Promise<DecisionResponse>;
}
export class DecisionTimeoutError extends Error {
    constructor(readonly timeoutMs: number) { super(`Decision timed out after ${timeoutMs}ms`); this.name = 'DecisionTimeoutError'; }
}
function record(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new Error('Decision response must contain JSON objects');
    return value as Record<string, unknown>;
}
export function createDecisionClient({ client, timeoutMs = 15000, logger }: DecisionClientOptions): DecisionClient {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
        throw new Error('timeoutMs must be finite and positive');
    return { async decide(request) {
            const start = performance.now();
            request.signal?.throwIfAborted();
            const timeout = AbortSignal.timeout(timeoutMs);
            const signal = request.signal ? AbortSignal.any([request.signal, timeout]) : timeout;
            let onAbort: () => void = () => { };
            try {
                const result = await Promise.race([client.chat({
                        systemPrompt: 'Return JSON only: an object with an "answers" object answering the named questions about the state.',
                        messages: [{ type: 'event', eventType: 'user', timestamp: new Date(), content: JSON.stringify({ state: request.state, questions: request.questions }) }], signal,
                    }), new Promise<never>((_, reject) => { onAbort = () => reject(signal.reason); signal.addEventListener('abort', onAbort, { once: true }); if (signal.aborted)
                        onAbort(); })]);
                const raw = record(JSON.parse(result.content ?? ''));
                return { model: client.getModelName(), answers: record(raw.answers), raw, usage: result.usage ? { inputTokens: result.usage.promptTokens, outputTokens: result.usage.completionTokens, totalTokens: result.usage.promptTokens + result.usage.completionTokens, usdCost: result.usage.usdCost } : undefined, latencyMs: Math.round(performance.now() - start) };
            }
            catch (error) {
                if (request.signal?.aborted)
                    throw request.signal.reason;
                if (timeout.aborted)
                    throw new DecisionTimeoutError(timeoutMs);
                logger?.warn({ error }, 'Decision failed');
                throw error;
            }
            finally {
                signal.removeEventListener('abort', onAbort);
            }
        } };
}
