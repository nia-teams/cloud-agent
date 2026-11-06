import { canonicalFixture } from './fixtures/canonical.js';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AnthropicClient } from '../clients/anthropic.js';
import type Anthropic from '@anthropic-ai/sdk';
function makeClientWithCapture() {
    const c = new AnthropicClient({
        apiKey: 'test',
        model: 'claude-opus-4-6-bc-east',
        baseURL: 'http://fake',
    });
    const captured: Anthropic.MessageCreateParams[] = [];
    (c as any).client = {
        messages: {
            create: vi.fn().mockImplementation((params: Anthropic.MessageCreateParams) => {
                captured.push(JSON.parse(JSON.stringify(params)));
                return Promise.resolve({
                    id: 'msg_1',
                    model: 'claude-opus-4-6',
                    role: 'assistant',
                    type: 'message',
                    content: [{ type: 'text', text: 'ok' }],
                    stop_reason: 'end_turn',
                    stop_sequence: null,
                    usage: { input_tokens: 10, output_tokens: 1 },
                });
            }),
        },
    };
    return { client: c, captured };
}
function countCacheControl(params: Anthropic.MessageCreateParams): number {
    let n = (params as Anthropic.MessageCreateParams & {
        cache_control?: unknown;
    }).cache_control ? 1 : 0;
    if (Array.isArray(params.system)) {
        for (const s of params.system) {
            if ('cache_control' in s && s.cache_control)
                n++;
        }
    }
    if (params.tools) {
        for (const t of params.tools as Array<{
            cache_control?: unknown;
        }>) {
            if (t.cache_control)
                n++;
        }
    }
    for (const m of params.messages) {
        if (typeof m.content === 'string')
            continue;
        if (!Array.isArray(m.content))
            continue;
        for (const b of m.content) {
            if (b && typeof b === 'object' && 'cache_control' in b && (b as {
                cache_control?: unknown;
            }).cache_control)
                n++;
        }
    }
    return n;
}
describe('AnthropicClient · cache_control 隔离与防累积', () => {
    beforeEach(() => {
        vi.restoreAllMocks();
    });
    it.each([false, true])('SDK success retains automatic and explicit breakpoints (stream=%s)', async (streaming) => {
        const captured: Anthropic.MessageCreateParams[] = [];
        const reply = {
            id: 'msg_cache_test', type: 'message', role: 'assistant', model: 'claude-opus-4-6',
            content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', stop_sequence: null,
            usage: { input_tokens: 10, output_tokens: 1 },
        };
        vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
            const body = JSON.parse(init!.body as string);
            captured.push(body);
            expect(body.stream === true).toBe(streaming);
            if (!streaming)
                return new Response(JSON.stringify(reply), {
                    headers: { 'content-type': 'application/json' },
                });
            const events = [
                { type: 'message_start', message: { ...reply, content: [], stop_reason: null } },
                { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
                { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } },
                { type: 'content_block_stop', index: 0 },
                { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } },
                { type: 'message_stop' },
            ];
            return new Response(events.map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''), {
                headers: { 'content-type': 'text/event-stream' },
            });
        });
        const client = new AnthropicClient({
            apiKey: 'test', model: 'claude-opus-4-6', baseURL: 'http://fake',
            supportsDeferLoading: true,
        });
        const staleMarker = { type: 'ephemeral' as const, ttl: '1h' as const };
        const messages: Anthropic.MessageParam[] = [
            { role: 'user', content: [{ type: 'text', text: 'oldest', cache_control: staleMarker }] },
            { role: 'assistant', content: 'reply' },
            { role: 'user', content: [
                    { type: 'text', text: 'prefix', cache_control: staleMarker },
                    { type: 'text', text: 'second-to-last' },
                ] },
            { role: 'assistant', content: 'reply again' },
            { role: 'user', content: [{ type: 'text', text: 'latest', cache_control: staleMarker }] },
        ];
        const tools = [
            { name: 'first', description: 'first', inputSchema: { type: 'object', properties: {} } },
            { name: 'last_eager', description: 'last eager', inputSchema: { type: 'object', properties: {} } },
            { name: 'deferred', description: 'deferred', inputSchema: { type: 'object', properties: {} }, deferLoading: true },
        ];
        const request = { messages, tools, systemPrompt: 'system prompt' };
        const before = structuredClone(request);
        function freeze(value: unknown): void {
            if (value && typeof value === 'object') {
                Object.values(value).forEach(freeze);
                Object.freeze(value);
            }
        }
        freeze(request);
        const onStreamDelta = vi.fn();
        for (let i = 0; i < 2; i++) {
            const response = await client.chat({ ...request, ...(streaming ? { onStreamDelta } : {}), messages: canonicalFixture(request.messages) });
            expect(response.content).toBe('ok');
            expect(request).toEqual(before);
        }
        expect(captured).toHaveLength(2);
        if (streaming)
            expect(onStreamDelta).toHaveBeenCalled();
        for (const payload of captured) {
            expect(payload).toHaveProperty('cache_control', { type: 'ephemeral' });
            expect(payload.system).toEqual([{ type: 'text', text: 'system prompt', cache_control: { type: 'ephemeral' } }]);
            expect(payload.tools?.[0]).not.toHaveProperty('cache_control');
            expect(payload.tools?.[1]).toHaveProperty('cache_control', { type: 'ephemeral' });
            expect(payload.tools?.[2]).toHaveProperty('defer_loading', true);
            expect(payload.tools?.[2]).not.toHaveProperty('cache_control');
            expect(payload.messages).toEqual([
                { role: 'user', content: [{ type: 'text', text: 'oldest' }] },
                { role: 'assistant', content: [{ type: 'text', text: 'reply' }] },
                { role: 'user', content: [{ type: 'text', text: 'prefix\nsecond-to-last', cache_control: { type: 'ephemeral' } }] },
                { role: 'assistant', content: [{ type: 'text', text: 'reply again' }] },
                { role: 'user', content: [{ type: 'text', text: 'latest' }] },
            ]);
            expect(countCacheControl(payload)).toBe(4);
        }
    });
    it('chat() 不 mutate 调用方传进来的 messages 数组（slot 替换）', async () => {
        const { client } = makeClientWithCapture();
        const userMsg = { role: 'user' as const, content: 'first turn' };
        const messages: Anthropic.MessageParam[] = [
            userMsg,
            { role: 'assistant', content: 'hi' },
            { role: 'user', content: 'second turn' },
            { role: 'assistant', content: 'hello' },
            { role: 'user', content: 'third turn' },
        ];
        const before = JSON.parse(JSON.stringify(messages));
        await client.chat({ messages: canonicalFixture(messages) });
        expect(messages).toEqual(before);
        expect(messages[0]).toBe(userMsg);
    });
    it('chat() 不 mutate 嵌套的 content blocks 数组', async () => {
        const { client } = makeClientWithCapture();
        const block = { type: 'text' as const, text: 'hi' };
        const blocks = [block];
        const messages: Anthropic.MessageParam[] = [
            { role: 'user', content: blocks },
            { role: 'assistant', content: 'a' },
            { role: 'user', content: 'follow up' },
        ];
        await client.chat({ messages: canonicalFixture(messages) });
        expect(messages[0].content).toBe(blocks);
        expect(blocks[0]).toBe(block);
        expect(block).not.toHaveProperty('cache_control');
    });
    it('调用方传进来的 messages 已带 cache_control 时，发出去的请求里被 strip', async () => {
        const { client, captured } = makeClientWithCapture();
        const polluted: Anthropic.MessageParam[] = [
            {
                role: 'user',
                content: [
                    { type: 'text', text: 'old turn 1', cache_control: { type: 'ephemeral' } } as never,
                ],
            },
            { role: 'assistant', content: 'response 1' },
            {
                role: 'user',
                content: [
                    {
                        type: 'tool_result',
                        tool_use_id: 't1',
                        content: 'done',
                        cache_control: { type: 'ephemeral' },
                    } as never,
                ],
            },
            { role: 'assistant', content: 'response 2' },
            { role: 'user', content: 'latest turn' },
        ];
        await client.chat({ messages: canonicalFixture(polluted) });
        const sent = captured[0];
        expect(countCacheControl(sent)).toBeLessThanOrEqual(4);
        expect((polluted[0].content as Array<{
            cache_control?: unknown;
        }>)[0].cache_control).toEqual({ type: 'ephemeral' });
    });
    it('多次 chat() 调用相同 messages 数组，每次都不超过 4 个 cache_control（防累积回归）', async () => {
        const { client, captured } = makeClientWithCapture();
        const messages: Anthropic.MessageParam[] = [
            { role: 'user', content: 'turn 1' },
            { role: 'assistant', content: 'a' },
            { role: 'user', content: 'turn 2' },
        ];
        for (let i = 0; i < 5; i++) {
            messages.push({ role: 'assistant', content: `r${i}` });
            messages.push({ role: 'user', content: `turn ${i + 3}` });
            await client.chat({
                messages: canonicalFixture(messages),
                systemPrompt: 'sys',
                tools: [
                    { name: 'a', description: 'a', inputSchema: { type: 'object', properties: {} } },
                    { name: 'b', description: 'b', inputSchema: { type: 'object', properties: {} } },
                ],
            });
        }
        for (const params of captured) {
            expect(countCacheControl(params)).toBeLessThanOrEqual(4);
        }
    });
});
