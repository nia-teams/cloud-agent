import { canonicalFixture } from './fixtures/canonical.js';
import Anthropic from '@anthropic-ai/sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AnthropicClient } from '../clients/anthropic.js';
const parameterMessage = 'Invalid request parameters. Please check your input and try again.';
const parameterError = { error: { code: '403001', message: parameterMessage } };
const actualParameterMessage = parameterMessage + ' (request id: 202610100826047966290518268d9d65JluEQ1h)';
const actualParameterError = { error: { code: '403001', message: actualParameterMessage } };
const intlParameterError = { error: { type: 'AccessDeniedException', message: parameterMessage }, type: 'error' };
const actualIntlParameterMessage = parameterMessage + ' (request id: 202610261047344399825518268d9d6mevUqcWF)';
const actualIntlParameterError = { error: { type: 'AccessDeniedException', message: actualIntlParameterMessage }, type: 'error' };
const reply = {
    id: 'msg_test', type: 'message', role: 'assistant', model: 'claude-opus-4-6-tx',
    content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 1 },
};
const start = { type: 'message_start', message: { ...reply, content: [], stop_reason: null } };
const textStart = { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } };
const textDelta = { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } };
function sse(events: Array<{
    type: string;
}>): Response {
    return new Response(events.map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''), {
        headers: { 'content-type': 'text/event-stream' },
    });
}
function success(streaming: boolean): Response {
    return streaming ? sse([
        start, textStart, textDelta,
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } },
        { type: 'message_stop' },
    ]) : new Response(JSON.stringify(reply), { headers: { 'content-type': 'application/json' } });
}
function failure(status = 403, body: unknown = parameterError): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}
function setup(streaming: boolean) {
    const client = new AnthropicClient({
        apiKey: 'test', model: 'claude-opus-4-6-tx', baseURL: 'http://newapi.test/v1',
        sessionId: 'cache-test-session', extraHeaders: { 'Tx-User-Session-Id': 'cache-test-session' }, supportsMidConversationTools: true,
    });
    const signal = new AbortController().signal;
    const onStreamDelta = vi.fn();
    const request = {
        messages: [
            { role: 'user' as const, content: 'old' },
            { role: 'assistant' as const, content: 'previous' },
            { role: 'system' as const, content: 'mid-conversation' },
            { role: 'user' as const, content: 'latest' },
        ],
        systemPrompt: 'system',
        tools: [{ name: 'search', description: 'search', inputSchema: { type: 'object', properties: {} } }],
        signal, ...(streaming ? { onStreamDelta } : {}),
    };
    return { client, request, onStreamDelta };
}
function captureFetch(respond: (call: number) => Response | Promise<Response>) {
    const payloads: Record<string, unknown>[] = [];
    const options: RequestInit[] = [];
    const urls: string[] = [];
    const fetch = vi.mocked(globalThis.fetch).mockImplementation(async (url, init) => {
        urls.push(String(url));
        payloads.push(JSON.parse(init!.body as string));
        options.push(init!);
        return respond(payloads.length);
    });
    return { fetch, payloads, options, urls };
}
beforeEach(() => { vi.spyOn(globalThis, 'fetch'); });
afterEach(() => vi.restoreAllMocks());
describe.each([false, true])('bounded root cache retry (stream=%s)', streaming => {
    it.each([
        [403, parameterError],
        [403, { error: { code: 403001, message: parameterMessage } }],
        [403, actualParameterError],
        [403, { error: { code: 403001, message: actualParameterMessage } }],
        [403, { error: { code: '403001', message: parameterMessage + ' (request id: A)' } }],
        [400, intlParameterError],
        [400, actualIntlParameterError],
        [400, { error: { type: 'AccessDeniedException', message: parameterMessage } }],
        [400, { type: 'AccessDeniedException', message: parameterMessage }],
        [400, { error: { type: 'AccessDeniedException', message: parameterMessage + ' (request id: B)' }, type: 'error' }],
    ] as const)('retries exact upstream parameter error %s / %j without changing any other payload/header', async (status, body) => {
        const { client, request, onStreamDelta } = setup(streaming);
        const before = structuredClone({ messages: request.messages, tools: request.tools });
        const { fetch, payloads, options, urls } = captureFetch(call => {
            if (call === 1) {
                expect(onStreamDelta).not.toHaveBeenCalled();
                return failure(status, body);
            }
            expect(onStreamDelta).not.toHaveBeenCalled();
            return success(streaming);
        });
        expect((await client.chat({ ...request, messages: canonicalFixture(request.messages) })).content).toBe('ok');
        expect(fetch).toHaveBeenCalledTimes(2);
        const { cache_control, ...withoutRoot } = payloads[0];
        expect(cache_control).toEqual({ type: 'ephemeral' });
        expect(payloads[1]).toEqual(withoutRoot);
        expect(payloads[1]).not.toHaveProperty('cache_control');
        expect(urls[0]).toBe(urls[1]);
        expect(new Headers(options[0].headers)).toEqual(new Headers(options[1].headers));
        expect(new Headers(options[1].headers).get('Tx-User-Session-Id')).toBe('cache-test-session');
        expect(new Headers(options[1].headers).get('anthropic-beta')).toBe('mid-conversation-tool-changes-2026-07-01');
        expect(options.every(o => o.signal instanceof AbortSignal && !o.signal.aborted)).toBe(true);
        expect({ messages: request.messages, tools: request.tools }).toEqual(before);
        expect(request.signal.aborted).toBe(false);
    });
    it('bounds repeated parameter failures to two requests and propagates second error', async () => {
        const { client, request } = setup(streaming);
        const { fetch } = captureFetch(call => failure(403, { ...parameterError, attempt: call }));
        const error = await client.chat({ ...request, messages: canonicalFixture(request.messages) }).catch(e => e);
        expect(fetch).toHaveBeenCalledTimes(2);
        expect(error).toBeInstanceOf(Anthropic.PermissionDeniedError);
        expect(error.error).toEqual({ ...parameterError, attempt: 2 });
    });
    it('bounds repeated 400 AccessDeniedException parameter failures to two requests and propagates second error', async () => {
        const { client, request } = setup(streaming);
        const { fetch } = captureFetch(call => failure(400, { ...intlParameterError, attempt: call }));
        const error = await client.chat({ ...request, messages: canonicalFixture(request.messages) }).catch(e => e);
        expect(fetch).toHaveBeenCalledTimes(2);
        expect(error).toBeInstanceOf(Anthropic.BadRequestError);
        expect(error.error).toEqual({ ...intlParameterError, attempt: 2 });
    });
    it('chains root-cache strip and invalid-thinking-signature strip cleanly across both streaming modes', async () => {
        const { client, onStreamDelta } = setup(streaming);
        const signal = new AbortController().signal;
        const requestWithThinking = {
            messages: [
                { role: 'user' as const, content: 'turn 1' },
                {
                    role: 'assistant' as const,
                    content: [
                        { type: 'thinking' as const, thinking: 'cross-model thought', signature: 'Q0FRU0V3a0lDTUlQQ0FRU0V3a0lDTUlQQ0FRU0V3a0lDTUlQQ0FRU0V3a0lDTUlQQ0FRU0V3a0lDTUlQQ0FRU0V3a0lDTUlQQ0FRU0V3a0lDTUlQQ0FRU0V3a0lDTUlQ' },
                        { type: 'text' as const, text: 'assistant reply' },
                    ],
                },
                { role: 'user' as const, content: 'turn 2' },
            ],
            systemPrompt: 'system',
            tools: [{ name: 'search', description: 'search', inputSchema: { type: 'object', properties: {} } }],
            signal,
            ...(streaming ? { onStreamDelta } : {}),
        };
        const { fetch, payloads } = captureFetch(call => {
            if (call === 1)
                return failure(400, actualIntlParameterError);
            if (call === 2) {
                return failure(400, {
                    error: {
                        type: 'invalid_request_error',
                        message: 'messages.1.content.0: Invalid `signature` in `thinking` block',
                    },
                });
            }
            return success(streaming);
        });
        expect((await client.chat({ ...requestWithThinking, messages: canonicalFixture(requestWithThinking.messages) })).content).toBe('ok');
        expect(fetch).toHaveBeenCalledTimes(3);
        expect(payloads[0]).toHaveProperty('cache_control', { type: 'ephemeral' });
        expect(payloads[1]).not.toHaveProperty('cache_control');
        expect(payloads[2]).not.toHaveProperty('cache_control');
        expect(payloads[2].messages).toEqual([
            {
                role: 'user',
                content: [{ type: 'text', text: 'turn 1', cache_control: { type: 'ephemeral' } }],
            },
            {
                role: 'assistant',
                content: [{ type: 'text', text: 'assistant reply' }],
            },
            { role: 'user', content: [{ type: 'text', text: 'turn 2' }] },
        ]);
    });
    it('propagates a different second failure normally', async () => {
        const { client, request } = setup(streaming);
        const { fetch } = captureFetch(call => call === 1 ? failure() : failure(400, { error: { message: 'second rejection' } }));
        const error = await client.chat({ ...request, messages: canonicalFixture(request.messages) }).catch(e => e);
        expect(fetch).toHaveBeenCalledTimes(2);
        expect(error.status).toBe(400);
        expect(error.error.error.message).toBe('second rejection');
    });
    it.each([
        [403, { error: { code: '403002', message: parameterMessage } }],
        [403, { error: { code: '403001', message: 'Permission denied' } }],
        ...[
            parameterMessage + ' ',
            parameterMessage + '\n',
            parameterMessage + ' unrelated suffix',
            parameterMessage + ' (request id: )',
            parameterMessage + ' (request id: abc-123)',
            parameterMessage + ' (request id: abc_123)',
            parameterMessage + ' (request id: abc 123)',
            parameterMessage + ' (request id: abc123 )',
            parameterMessage + ' (request id:  abc123)',
            parameterMessage + '  (request id: abc123)',
            parameterMessage + '\t(request id: abc123)',
            parameterMessage + ' (request id: abc123',
            'prefix ' + actualParameterMessage,
            actualParameterMessage + ' unrelated suffix',
            actualParameterMessage + ' (request id: abc123)',
            actualParameterMessage + ' ',
            actualParameterMessage + '\t',
            actualParameterMessage + '\n',
            actualParameterMessage + '\r\n',
        ].map(message => [403, { error: { code: '403001', message } }]),
        [403, { error: { message: parameterMessage } }],
        [403, { error: { code: 'invalid_api_key', message: 'Invalid API key' } }],
        [403, { error: { code: '403002', message: actualParameterMessage } }],
        [403, intlParameterError],
        [403, actualIntlParameterError],
        [400, actualParameterError],
        [400, parameterError],
        [400, { error: { type: 'invalid_request_error', message: parameterMessage }, type: 'error' }],
        [400, { error: { type: 'AccessDeniedException', message: 'Access denied' }, type: 'error' }],
        [400, { error: { type: 'AccessDeniedException', message: parameterMessage + ' unrelated suffix' }, type: 'error' }],
        [400, { error: { type: 'AccessDeniedException', message: parameterMessage + ' (request id: abc-123)' }, type: 'error' }],
        [429, parameterError],
        [429, actualIntlParameterError],
    ])('does not retry unrelated HTTP rejection %s / %j', async (status, body) => {
        const { client, request } = setup(streaming);
        const { fetch, payloads } = captureFetch(() => failure(status, body));
        const error = await client.chat({ ...request, messages: canonicalFixture(request.messages) }).catch(e => e);
        expect(error.status).toBe(status);
        expect(fetch).toHaveBeenCalledTimes(1);
        expect(payloads[0]).toHaveProperty('cache_control');
    });
    it('does not retry if aborted after the qualifying rejection', async () => {
        const { client, request } = setup(streaming);
        const controller = new AbortController();
        const { fetch } = captureFetch(() => {
            controller.abort();
            return failure();
        });
        await expect(client.chat({ ...request, signal: controller.signal, messages: canonicalFixture(request.messages) })).rejects.toThrow();
        expect(fetch).toHaveBeenCalledTimes(1);
    });
    it('forwards caller abort to the second attempt', async () => {
        const { client, request } = setup(streaming);
        const controller = new AbortController();
        const { fetch, options } = captureFetch(call => {
            if (call === 1)
                return failure();
            return new Promise<Response>((_resolve, reject) => {
                options[1].signal!.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
                controller.abort();
            });
        });
        await expect(client.chat({ ...request, signal: controller.signal, messages: canonicalFixture(request.messages) })).rejects.toThrow(/abort/i);
        expect(fetch).toHaveBeenCalledTimes(2);
        expect(options[1].signal!.aborted).toBe(true);
    });
});
describe('stream errors are not replayed', () => {
    it.each([false, true])('never retries accepted SSE error (partial text=%s)', async (partial) => {
        const { client, request, onStreamDelta } = setup(true);
        const { fetch } = captureFetch(() => sse([
            ...(partial ? [start, textStart, textDelta] : []),
            { type: 'error', error: { type: 'permission_error', code: '403001', message: parameterMessage } },
        ]));
        await expect(client.chat({ ...request, messages: canonicalFixture(request.messages) })).rejects.toThrow(parameterMessage);
        expect(fetch).toHaveBeenCalledTimes(1);
        if (partial)
            expect(onStreamDelta).toHaveBeenCalledWith({ type: 'text', content: 'ok' });
        else
            expect(onStreamDelta).not.toHaveBeenCalled();
    });
    it.each([false, true])('never retries accepted SSE AccessDeniedException error (partial text=%s)', async (partial) => {
        const { client, request, onStreamDelta } = setup(true);
        const { fetch } = captureFetch(() => sse([
            ...(partial ? [start, textStart, textDelta] : []),
            { type: 'error', error: { type: 'AccessDeniedException', message: actualIntlParameterMessage } },
        ]));
        await expect(client.chat({ ...request, messages: canonicalFixture(request.messages) })).rejects.toThrow(parameterMessage);
        expect(fetch).toHaveBeenCalledTimes(1);
        if (partial)
            expect(onStreamDelta).toHaveBeenCalledWith({ type: 'text', content: 'ok' });
        else
            expect(onStreamDelta).not.toHaveBeenCalled();
    });
});
