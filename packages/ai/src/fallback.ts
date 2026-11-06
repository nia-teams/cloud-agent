import type { ILLMClient, LLMChatRequest, LLMChatResponse } from './protocol/index.js';
import { OpenAICompatibleHttpError, UpstreamStreamError } from './clients/openai.js';
import type { Logger } from './logger.js';
export type FallbackTarget = ILLMClient | (() => ILLMClient | Promise<ILLMClient>);
export interface FallbackOptions {
    network?: FallbackTarget[];
    policyViolation?: FallbackTarget;
    refusal?: FallbackTarget;
    logger?: Logger;
}
const resolve = (target: FallbackTarget): Promise<ILLMClient> => Promise.resolve(typeof target === 'function' ? target() : target);
async function retry(target: FallbackTarget, request: LLMChatRequest): Promise<LLMChatResponse> {
    request.signal?.throwIfAborted();
    const client = await resolve(target);
    request.signal?.throwIfAborted();
    const response = await client.chat(request);
    return { ...response, usedFallbackModel: response.usedFallbackModel ?? client.getModelName() };
}
function wrap(primary: ILLMClient, chat: ILLMClient['chat']): ILLMClient {
    return { chat, getModelName: () => primary.getModelName(), getProviderName: () => primary.getProviderName() };
}
export function withFallback(primary: ILLMClient, options: FallbackOptions): ILLMClient {
    let client = primary;
    if (options.network?.length) {
        const inner = client;
        client = wrap(inner, async (request) => {
            let emitted = false;
            const monitored: LLMChatRequest = { ...request, onStreamDelta: request.onStreamDelta ? delta => {
                    emitted = true;
                    request.onStreamDelta!(delta);
                } : undefined };
            try {
                return await inner.chat(monitored);
            }
            catch (error) {
                if (request.signal?.aborted || emitted || !isTransientChannelError(error))
                    throw error;
                const errors: unknown[] = [error];
                for (const target of options.network!) {
                    request.signal?.throwIfAborted();
                    try {
                        return await retry(target, monitored);
                    }
                    catch (failure) {
                        if (request.signal?.aborted || emitted)
                            throw failure;
                        errors.push(failure);
                        options.logger?.warn({ error: failure }, 'Fallback transport failed');
                    }
                }
                throw new AggregateError(errors, 'All transport attempts failed', { cause: error });
            }
        });
    }
    if (options.policyViolation) {
        const inner = client;
        client = wrap(inner, async (request) => {
            let emitted = false;
            const monitored = { ...request, onStreamDelta: request.onStreamDelta ? (delta: Parameters<NonNullable<LLMChatRequest['onStreamDelta']>>[0]) => { emitted = true; request.onStreamDelta!(delta); } : undefined };
            try {
                return await inner.chat(monitored);
            }
            catch (error) {
                if (request.signal?.aborted || emitted || !isUsagePolicyViolationError(error))
                    throw error;
                try {
                    return await retry(options.policyViolation!, request);
                }
                catch (failure) {
                    if (request.signal?.aborted)
                        throw failure;
                    options.logger?.warn({ error: failure }, 'Policy fallback failed');
                    throw error;
                }
            }
        });
    }
    if (options.refusal) {
        const inner = client;
        client = wrap(inner, async (request) => {
            const response = await inner.chat(request);
            if (response.stopReason !== 'refusal' || request.signal?.aborted)
                return response;
            try {
                return await retry(options.refusal!, request);
            }
            catch (error) {
                if (request.signal?.aborted)
                    throw error;
                options.logger?.warn({ error }, 'Refusal fallback failed');
                return response;
            }
        });
    }
    return client;
}
function isUsagePolicyViolationError(error: unknown): boolean {
    if (!(error instanceof OpenAICompatibleHttpError || error instanceof UpstreamStreamError)) {
        return false;
    }
    if (error.providerCode !== 'invalid_prompt')
        return false;
    const responseBody = error instanceof OpenAICompatibleHttpError ? error.responseBody : '';
    const text = `${error.message}\n${responseBody}`.toLowerCase();
    return /prompt[^\n]*(?:flagged|violat)[^\n]*usage[_ ]policy/.test(text) ||
        /usage[_ ]policy[^\n]*(?:flagged|violat)[^\n]*prompt/.test(text);
}
function walkErr(err: unknown): Array<Record<string, unknown>> {
    const chain: Array<Record<string, unknown>> = [];
    let node: unknown = err;
    for (let i = 0; i < 3; i++) {
        if (!node || typeof node !== 'object')
            break;
        chain.push(node as Record<string, unknown>);
        node = (node as {
            cause?: unknown;
        }).cause;
    }
    return chain;
}
function getErrName(err: unknown): string | undefined {
    for (const layer of walkErr(err)) {
        const name = layer.name;
        if (typeof name === 'string')
            return name;
    }
    return undefined;
}
function getErrStatus(err: unknown): number | undefined {
    for (const layer of walkErr(err)) {
        const s = (layer.status as number | undefined) ??
            (layer.statusCode as number | undefined) ??
            ((layer.response as {
                status?: number;
            } | undefined)?.status);
        if (typeof s === 'number')
            return s;
    }
    return undefined;
}
function getErrCode(err: unknown): string | undefined {
    for (const layer of walkErr(err)) {
        const code = layer.code;
        if (typeof code === 'string')
            return code;
    }
    return undefined;
}
function isTransientChannelError(err: unknown): boolean {
    if (!err || typeof err !== 'object')
        return false;
    const name = getErrName(err);
    if (name === 'AbortError')
        return false;
    const status = getErrStatus(err);
    if (typeof status === 'number') {
        if (status >= 500 && status < 600)
            return true;
        if (status === 429)
            return true;
        return false;
    }
    const code = getErrCode(err);
    if (code === 'ECONNRESET' ||
        code === 'ECONNREFUSED' ||
        code === 'ETIMEDOUT' ||
        code === 'EAI_AGAIN' ||
        code === 'UND_ERR_CONNECT_TIMEOUT' ||
        code === 'UND_ERR_HEADERS_TIMEOUT' ||
        code === 'UND_ERR_BODY_TIMEOUT' ||
        code === 'UND_ERR_SOCKET') {
        return true;
    }
    if (name === 'ConnectTimeoutError' ||
        name === 'HeadersTimeoutError' ||
        name === 'BodyTimeoutError' ||
        name === 'TimeoutError') {
        return true;
    }
    return false;
}
