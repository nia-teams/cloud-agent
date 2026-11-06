import { canonicalFixture } from './fixtures/canonical.js';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { OpenAIClient, MalformedToolArgumentsError } from '../clients/openai.js';
function makeClient() {
    return new OpenAIClient({
        apiKey: 'test',
        baseURL: 'http://fake',
        model: 'test-model',
        providerName: 'openai',
    });
}
function makeToolCallSseStream(toolCalls: Array<{
    id: string;
    name: string;
    arguments: string;
}>): Response {
    const chunks: object[] = [];
    chunks.push({
        id: 'cmpl_1',
        model: 'test-model',
        object: 'chat.completion.chunk',
        choices: [{ index: 0, delta: { role: 'assistant' } }],
    });
    toolCalls.forEach((tc, idx) => {
        chunks.push({
            id: 'cmpl_1',
            model: 'test-model',
            object: 'chat.completion.chunk',
            choices: [
                {
                    index: 0,
                    delta: {
                        tool_calls: [
                            {
                                index: idx,
                                id: tc.id,
                                type: 'function',
                                function: { name: tc.name, arguments: tc.arguments },
                            },
                        ],
                    },
                },
            ],
        });
    });
    chunks.push({
        id: 'cmpl_1',
        model: 'test-model',
        object: 'chat.completion.chunk',
        choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    });
    const body = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n';
    return new Response(body, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
    });
}
let originalFetch: typeof globalThis.fetch;
beforeEach(() => {
    originalFetch = globalThis.fetch;
});
afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
});
describe('OpenAIClient · tool_call.arguments validation', () => {
    it('passes through valid JSON unchanged', async () => {
        globalThis.fetch = vi
            .fn()
            .mockResolvedValue(makeToolCallSseStream([{ id: 'a', name: 'do_thing', arguments: '{"k":"v"}' }]));
        const r = await makeClient().chat({
            messages: canonicalFixture([{ type: 'event', content: 'hi', timestamp: 0 } as never]),
            systemPrompt: '',
            tools: [],
            onStreamDelta: () => { },
        });
        expect(r.toolCalls).toHaveLength(1);
        expect(r.toolCalls?.[0].arguments).toBe('{"k":"v"}');
    });
    it('passes through empty object {} unchanged', async () => {
        globalThis.fetch = vi
            .fn()
            .mockResolvedValue(makeToolCallSseStream([{ id: 'a', name: 'do_thing', arguments: '{}' }]));
        const r = await makeClient().chat({
            messages: canonicalFixture([{ type: 'event', content: 'hi', timestamp: 0 } as never]),
            systemPrompt: '',
            tools: [],
            onStreamDelta: () => { },
        });
        expect(r.toolCalls?.[0].arguments).toBe('{}');
    });
    it('throws MalformedToolArgumentsError on unclosed brace (no autoclose on tool_call)', async () => {
        globalThis.fetch = vi
            .fn()
            .mockResolvedValue(makeToolCallSseStream([{ id: 'a', name: 'do_thing', arguments: '{"a":1' }]));
        await expect(makeClient().chat({
            messages: canonicalFixture([{ type: 'event', content: 'hi', timestamp: 0 } as never]),
            systemPrompt: '',
            tools: [],
            onStreamDelta: () => { },
        })).rejects.toBeInstanceOf(MalformedToolArgumentsError);
    });
    it('safely repairs trailing comma and bare control chars inside strings without autoclose', async () => {
        globalThis.fetch = vi
            .fn()
            .mockResolvedValue(makeToolCallSseStream([
            { id: 'a', name: 'do_thing', arguments: '{"a":1,}' },
            { id: 'b', name: 'write_file', arguments: '{"path":"a.txt","content":"line1\nline2",}' },
        ]));
        const r = await makeClient().chat({
            messages: canonicalFixture([{ type: 'event', content: 'hi', timestamp: 0 } as never]),
            systemPrompt: '',
            tools: [],
            onStreamDelta: () => { },
        });
        expect(r.toolCalls).toHaveLength(2);
        expect(JSON.parse(r.toolCalls![0].arguments)).toEqual({ a: 1 });
        expect(JSON.parse(r.toolCalls![1].arguments)).toEqual({ path: 'a.txt', content: 'line1\nline2' });
        expect(r.toolCalls![0].malformedError).toBeUndefined();
        expect(r.toolCalls![1].malformedError).toBeUndefined();
    });
    it('rejects truncated string arguments (no autoclose) and attaches partialResponse with sibling tool calls', async () => {
        globalThis.fetch = vi.fn().mockResolvedValue(makeToolCallSseStream([
            { id: 'call_ok', name: 'file_read', arguments: '{"path":"src/people.md"}' },
            {
                id: 'call_trunc',
                name: 'file_write',
                arguments: '{"path":"build/health-status.json","content":"{\\n  \\"subjects\\": [\\n    {\\n',
            },
        ]));
        let caught: MalformedToolArgumentsError | undefined;
        try {
            await makeClient().chat({
                messages: canonicalFixture([{ type: 'event', content: 'hi', timestamp: 0 } as never]),
                systemPrompt: '',
                tools: [],
                onStreamDelta: () => { },
            });
        }
        catch (e) {
            caught = e as MalformedToolArgumentsError;
        }
        expect(caught).toBeInstanceOf(MalformedToolArgumentsError);
        expect(caught?.toolCallId).toBe('call_trunc');
        expect(caught?.toolName).toBe('file_write');
        expect(caught?.partialResponse?.toolCalls).toHaveLength(2);
        expect(caught?.partialResponse?.toolCalls?.[0]).toEqual({
            id: 'call_ok',
            name: 'file_read',
            arguments: '{"path":"src/people.md"}',
        });
        expect(caught?.partialResponse?.toolCalls?.[1].id).toBe('call_trunc');
        expect(caught?.partialResponse?.toolCalls?.[1].name).toBe('file_write');
        expect(caught?.partialResponse?.toolCalls?.[1].arguments).toBe('{}');
        expect(caught?.partialResponse?.toolCalls?.[1].malformedError).toContain('tool_call.arguments not valid JSON for tool=file_write id=call_trunc');
        expect(caught?.partialResponse?.usage).toEqual({
            promptTokens: 1,
            completionTokens: 1,
            cachedTokens: undefined,
            reasoningTokens: undefined,
            usdCost: undefined,
        });
    });
    it('throws MalformedToolArgumentsError on `{}""` (trailing characters)', async () => {
        globalThis.fetch = vi
            .fn()
            .mockResolvedValue(makeToolCallSseStream([{ id: 'a', name: 'wait_user_reply', arguments: '{}""' }]));
        const promise = makeClient().chat({
            messages: canonicalFixture([{ type: 'event', content: 'hi', timestamp: 0 } as never]),
            systemPrompt: '',
            tools: [],
            onStreamDelta: () => { },
        });
        await expect(promise).rejects.toBeInstanceOf(MalformedToolArgumentsError);
        try {
            await promise;
        }
        catch (e) {
            const err = e as MalformedToolArgumentsError;
            expect(err.toolCallId).toBe('a');
            expect(err.toolName).toBe('wait_user_reply');
            expect(err.rawArguments).toBe('{}""');
        }
    });
    it('throws MalformedToolArgumentsError on totally garbage args', async () => {
        globalThis.fetch = vi
            .fn()
            .mockResolvedValue(makeToolCallSseStream([{ id: 'a', name: 'do_thing', arguments: 'lol not json' }]));
        await expect(makeClient().chat({
            messages: canonicalFixture([{ type: 'event', content: 'hi', timestamp: 0 } as never]),
            systemPrompt: '',
            tools: [],
            onStreamDelta: () => { },
        })).rejects.toBeInstanceOf(MalformedToolArgumentsError);
    });
    it('throws on first invalid tool_call even when others are fine (whole turn invalid)', async () => {
        globalThis.fetch = vi.fn().mockResolvedValue(makeToolCallSseStream([
            { id: 'a', name: 'ok', arguments: '{"x":1}' },
            { id: 'b', name: 'broken', arguments: '{}""' },
            { id: 'c', name: 'also_ok', arguments: '{"y":2}' },
        ]));
        const promise = makeClient().chat({
            messages: canonicalFixture([{ type: 'event', content: 'hi', timestamp: 0 } as never]),
            systemPrompt: '',
            tools: [],
            onStreamDelta: () => { },
        });
        await expect(promise).rejects.toBeInstanceOf(MalformedToolArgumentsError);
        try {
            await promise;
        }
        catch (e) {
            const err = e as MalformedToolArgumentsError;
            expect(err.toolCallId).toBe('b');
            expect(err.toolName).toBe('broken');
        }
    });
    it('returns multiple tool_calls verbatim when all are valid', async () => {
        globalThis.fetch = vi.fn().mockResolvedValue(makeToolCallSseStream([
            { id: 'a', name: 'ok', arguments: '{"x":1}' },
            { id: 'b', name: 'also_ok', arguments: '{"y":2}' },
        ]));
        const r = await makeClient().chat({
            messages: canonicalFixture([{ type: 'event', content: 'hi', timestamp: 0 } as never]),
            systemPrompt: '',
            tools: [],
            onStreamDelta: () => { },
        });
        expect(r.toolCalls).toHaveLength(2);
        expect(r.toolCalls?.[0].arguments).toBe('{"x":1}');
        expect(r.toolCalls?.[1].arguments).toBe('{"y":2}');
    });
    it('streaming attaches upstreamRequestId (x-oneapi-request-id) and upstreamCompletionId on error', async () => {
        const sse = makeToolCallSseStream([{ id: 'a', name: 'wait_user_reply', arguments: '{}""' }]);
        const sseWithHeaders = new Response(sse.body, {
            status: 200,
            headers: {
                'Content-Type': 'text/event-stream',
                'X-Oneapi-Request-Id': '20260617192050763233615Id047y4o',
            },
        });
        globalThis.fetch = vi.fn().mockResolvedValue(sseWithHeaders);
        const promise = makeClient().chat({
            messages: canonicalFixture([{ type: 'event', content: 'hi', timestamp: 0 } as never]),
            systemPrompt: '',
            tools: [],
            onStreamDelta: () => { },
        });
        await expect(promise).rejects.toBeInstanceOf(MalformedToolArgumentsError);
        try {
            await promise;
        }
        catch (e) {
            const err = e as MalformedToolArgumentsError;
            expect(err.upstreamRequestId).toBe('20260617192050763233615Id047y4o');
            expect(err.upstreamCompletionId).toBe('cmpl_1');
        }
    });
    it('streaming falls back to x-request-id then x-trace-id', async () => {
        const sse1 = makeToolCallSseStream([{ id: 'a', name: 't', arguments: '{}""' }]);
        const r1 = new Response(sse1.body, {
            status: 200,
            headers: {
                'Content-Type': 'text/event-stream',
                'X-Request-Id': 'uuid-r1',
                'X-Trace-Id': 'uuid-t1',
            },
        });
        globalThis.fetch = vi.fn().mockResolvedValue(r1);
        try {
            await makeClient().chat({
                messages: canonicalFixture([{ type: 'event', content: 'hi', timestamp: 0 } as never]),
                systemPrompt: '',
                tools: [],
                onStreamDelta: () => { },
            });
        }
        catch (e) {
            const err = e as MalformedToolArgumentsError;
            expect(err.upstreamRequestId).toBe('uuid-r1');
        }
        const sse2 = makeToolCallSseStream([{ id: 'a', name: 't', arguments: '{}""' }]);
        const r2 = new Response(sse2.body, {
            status: 200,
            headers: {
                'Content-Type': 'text/event-stream',
                'X-Trace-Id': 'uuid-t2',
            },
        });
        globalThis.fetch = vi.fn().mockResolvedValue(r2);
        try {
            await makeClient().chat({
                messages: canonicalFixture([{ type: 'event', content: 'hi', timestamp: 0 } as never]),
                systemPrompt: '',
                tools: [],
                onStreamDelta: () => { },
            });
        }
        catch (e) {
            const err = e as MalformedToolArgumentsError;
            expect(err.upstreamRequestId).toBe('uuid-t2');
        }
    });
});
describe('MalformedToolArgumentsError · constructor', () => {
    it('attaches structured fields and previews long input', () => {
        const longArgs = 'x'.repeat(200);
        const e = new MalformedToolArgumentsError('id1', 'fn', longArgs);
        expect(e.toolCallId).toBe('id1');
        expect(e.toolName).toBe('fn');
        expect(e.rawArguments).toBe(longArgs);
        expect(e.message).toContain('length=200');
        expect(e.message).toContain('"' + 'x'.repeat(80) + '..."');
    });
    it('does not truncate short input in the message', () => {
        const e = new MalformedToolArgumentsError('id1', 'fn', '{}""');
        expect(e.message).toContain('"{}\\"\\""');
    });
    it('defaults upstream meta to null when omitted (back-compat)', () => {
        const e = new MalformedToolArgumentsError('id1', 'fn', '{}""');
        expect(e.upstreamRequestId).toBeNull();
        expect(e.upstreamCompletionId).toBeNull();
    });
    it('exposes upstream meta when provided by lib internals', () => {
        const e = new MalformedToolArgumentsError('id1', 'fn', '{}""', {
            upstreamRequestId: '20260617192050763233615Id047y4o',
            upstreamCompletionId: 'fda30472-ea62-4ae6-8878-83e1024dfff5',
        });
        expect(e.upstreamRequestId).toBe('20260617192050763233615Id047y4o');
        expect(e.upstreamCompletionId).toBe('fda30472-ea62-4ae6-8878-83e1024dfff5');
    });
});
