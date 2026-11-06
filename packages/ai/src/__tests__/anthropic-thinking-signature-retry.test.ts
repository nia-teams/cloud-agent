import { canonicalFixture } from './fixtures/canonical.js';
import Anthropic from '@anthropic-ai/sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AnthropicClient } from '../clients/anthropic.js';
const daifengErrorMessage = 'content.4: Invalid `signature` in `thinking` block. The block is bound to a different conversation. Remove the block, or set `thinking.block_binding.prefix_mismatch_behavior` to "drop_block". That setting requires the `thinking-binding-controls-2026-08-01` value in the `anthropic-beta` header.';
const newApiWrappedErrorMessage = '400: {"error":{"type":"<nil>","message":"***.***.content.0: Invalid `signature` in `thinking` block (request id: 202610261914462519605838268d9d6cQYkd1Xx)"},"type":"error"} (request id: 202610261114415244371238268d9d66KAiq4Gs)';
const bedrockWrappedErrorMessage = '400: {"error":{"type":"<nil>","message":"InvokeModelWithResponseStream: operation error Bedrock Runtime: InvokeModelWithResponseStream, https response error StatusCode: 400, RequestID: eb560e56-6b9b-4383-a257-f94a1e0d98f4, ValidationException: ***.***.content.0: Invalid `signature` in `thinking` block. The block is bound to a different conversation. Remove the block, or set `thinking.block_binding.prefix_mismatch_behavior` to \\"drop_block\\". That setting requires the `thinking-binding-controls-2026-08-01` value in the `anthropic-beta` header. (request id: 202610261003165381544338268d9d6uqGEPAPw)"},"type":"error"}';
const officialErrorMessage = 'messages.1.content.0: Invalid `signature` in `thinking` block';
const reply = {
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    model: 'claude-opus-5-5',
    content: [{ type: 'text', text: 'ok' }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 1 },
};
const start = { type: 'message_start', message: { ...reply, content: [], stop_reason: null } };
const textStart = { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } };
const textDelta = { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } };
function sse(events: Array<{
    type: string;
}>): Response {
    return new Response(events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''), {
        headers: { 'content-type': 'text/event-stream' },
    });
}
function success(streaming: boolean): Response {
    return streaming
        ? sse([
            start,
            textStart,
            textDelta,
            { type: 'content_block_stop', index: 0 },
            { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } },
            { type: 'message_stop' },
        ])
        : new Response(JSON.stringify(reply), { headers: { 'content-type': 'application/json' } });
}
function failure(status = 400, body: unknown = { error: { type: 'invalid_request_error', message: daifengErrorMessage } }): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}
function setup(streaming: boolean) {
    const client = new AnthropicClient({
        apiKey: 'test',
        model: 'claude-opus-5-5',
        baseURL: 'http://newapi.test/v1',
        sessionId: 'sig-test-session',
    });
    const signal = new AbortController().signal;
    const onStreamDelta = vi.fn();
    const request = {
        messages: [
            { role: 'user' as const, content: 'first user prompt' },
            {
                role: 'assistant' as const,
                content: [
                    { type: 'thinking' as const, thinking: 'old antigravity thought', signature: 'Q0FRU0V3a0lDTUlQQ0FRU0V3a0lDTUlQQ0FRU0V3a0lDTUlQQ0FRU0V3a0lDTUlQQ0FRU0V3a0lDTUlQQ0FRU0V3a0lDTUlQQ0FRU0V3a0lDTUlQQ0FRU0V3a0lDTUlQ' },
                    { type: 'text' as const, text: 'assistant answer' },
                    { type: 'tool_use' as const, id: 'toolu_1', name: 'search', input: { q: 'abc' } },
                ],
            },
            {
                role: 'user' as const,
                content: [
                    { type: 'tool_result' as const, tool_use_id: 'toolu_1', content: 'found' },
                ],
            },
        ],
        systemPrompt: 'system',
        tools: [{ name: 'search', description: 'search', inputSchema: { type: 'object', properties: {} } }],
        signal,
        ...(streaming ? { onStreamDelta } : {}),
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
beforeEach(() => {
    vi.spyOn(globalThis, 'fetch');
});
afterEach(() => vi.restoreAllMocks());
describe.each([false, true])('bounded invalid thinking signature retry (stream=%s)', (streaming) => {
    it.each([
        { error: { type: 'invalid_request_error', message: daifengErrorMessage } },
        { error: { type: '400001', message: newApiWrappedErrorMessage }, type: 'error' },
        { error: { type: '400001', message: bedrockWrappedErrorMessage }, type: 'error' },
        { error: { type: 'invalid_request_error', message: officialErrorMessage } },
    ])('strips thinking blocks and retries once on observed signature error %j', async (body) => {
        const { client, request, onStreamDelta } = setup(streaming);
        const before = structuredClone(request.messages);
        const { fetch, payloads } = captureFetch((call) => {
            if (call === 1) {
                expect(onStreamDelta).not.toHaveBeenCalled();
                return failure(400, body);
            }
            expect(onStreamDelta).not.toHaveBeenCalled();
            return success(streaming);
        });
        expect((await client.chat({ ...request, messages: canonicalFixture(request.messages) })).content).toBe('ok');
        expect(fetch).toHaveBeenCalledTimes(2);
        expect(payloads[0].messages).toEqual([
            {
                role: 'user',
                content: [{ type: 'text', text: 'first user prompt', cache_control: { type: 'ephemeral' } }],
            },
            {
                role: 'assistant',
                content: [
                    { type: 'thinking', thinking: 'old antigravity thought', signature: 'Q0FRU0V3a0lDTUlQQ0FRU0V3a0lDTUlQQ0FRU0V3a0lDTUlQQ0FRU0V3a0lDTUlQQ0FRU0V3a0lDTUlQQ0FRU0V3a0lDTUlQQ0FRU0V3a0lDTUlQQ0FRU0V3a0lDTUlQ' },
                    { type: 'text', text: 'assistant answer' },
                    { type: 'tool_use', id: 'toolu_1', name: 'search', input: { q: 'abc' } },
                ],
            },
            {
                role: 'user',
                content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'found' }],
            },
        ]);
        expect(payloads[1].messages).toEqual([
            {
                role: 'user',
                content: [{ type: 'text', text: 'first user prompt', cache_control: { type: 'ephemeral' } }],
            },
            {
                role: 'assistant',
                content: [
                    { type: 'text', text: 'assistant answer' },
                    { type: 'tool_use', id: 'toolu_1', name: 'search', input: { q: 'abc' } },
                ],
            },
            {
                role: 'user',
                content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'found' }],
            },
        ]);
        expect(request.messages).toEqual(before);
    });
    it('drops thinking-only assistant message and merges newly adjacent user messages', async () => {
        const { client, onStreamDelta } = setup(streaming);
        const signal = new AbortController().signal;
        const request = {
            messages: [
                { role: 'user' as const, content: 'turn 1' },
                {
                    role: 'assistant' as const,
                    content: [{ type: 'thinking' as const, thinking: 'only thinking', signature: 'Q0FRU0V3a0lDTUlQQ0FRU0V3a0lDTUlQQ0FRU0V3a0lDTUlQQ0FRU0V3a0lDTUlQQ0FRU0V3a0lDTUlQQ0FRU0V3a0lDTUlQQ0FRU0V3a0lDTUlQQ0FRU0V3a0lDTUlQ' }],
                },
                { role: 'user' as const, content: 'turn 2' },
            ],
            signal,
            ...(streaming ? { onStreamDelta } : {}),
        };
        const { fetch, payloads } = captureFetch((call) => (call === 1 ? failure(400) : success(streaming)));
        expect((await client.chat({ ...request, messages: canonicalFixture(request.messages) })).content).toBe('ok');
        expect(fetch).toHaveBeenCalledTimes(2);
        expect(payloads[1].messages).toEqual([
            {
                role: 'user',
                content: [
                    { type: 'text', text: 'turn 1', cache_control: { type: 'ephemeral' } },
                    { type: 'text', text: 'turn 2' },
                ],
            },
        ]);
    });
    it('bounds repeated signature failures to at most two requests and propagates second error', async () => {
        const { client, request } = setup(streaming);
        const { fetch } = captureFetch(() => failure(400));
        const error = await client.chat({ ...request, messages: canonicalFixture(request.messages) }).catch((e) => e);
        expect(fetch).toHaveBeenCalledTimes(2);
        expect(error).toBeInstanceOf(Anthropic.BadRequestError);
    });
    it.each([
        [400, { error: { type: 'invalid_request_error', message: 'messages.0.content.0: Field required' } }],
        [400, { error: { type: 'invalid_request_error', message: 'thinking.budget_tokens: Input should be greater than 1024' } }],
        [403, { error: { type: 'permission_error', message: daifengErrorMessage } }],
        [429, { error: { type: 'rate_limit_error', message: daifengErrorMessage } }],
    ])('does not strip or retry on unrelated error %s / %j', async (status, body) => {
        const { client, request } = setup(streaming);
        const { fetch } = captureFetch(() => failure(status, body));
        const error = await client.chat({ ...request, messages: canonicalFixture(request.messages) }).catch((e) => e);
        expect(error.status).toBe(status);
        expect(fetch).toHaveBeenCalledTimes(1);
    });
    it('does not retry if request has no thinking blocks to strip', async () => {
        const { client, onStreamDelta } = setup(streaming);
        const request = {
            messages: [
                { role: 'user' as const, content: 'hi' },
                { role: 'assistant' as const, content: 'hello' },
                { role: 'user' as const, content: 'again' },
            ],
            ...(streaming ? { onStreamDelta } : {}),
        };
        const { fetch } = captureFetch(() => failure(400));
        await expect(client.chat({ ...request, messages: canonicalFixture(request.messages) })).rejects.toThrow();
        expect(fetch).toHaveBeenCalledTimes(1);
    });
});
