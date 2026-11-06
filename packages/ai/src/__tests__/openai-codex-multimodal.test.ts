import { canonicalFixture } from './fixtures/canonical.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OpenAIClient } from '../clients/openai.js';
let capturedBody: Record<string, any> | null;
let originalFetch: typeof globalThis.fetch;
beforeEach(() => {
    capturedBody = null;
    originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockImplementation((_url: string, init: RequestInit) => {
        capturedBody = JSON.parse(init.body as string);
        return Promise.resolve(new Response(JSON.stringify({
            id: 'cmpl_1',
            choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    });
});
afterEach(() => {
    globalThis.fetch = originalFetch;
});
function client(defaults = {}, supportsReasoningEffort = false) {
    return new OpenAIClient({
        apiKey: 'test', baseURL: 'http://fake', model: 'codex', defaults, supportsReasoningEffort,
    });
}
describe('OpenAIClient.chat — reasoning_effort-capable OpenAI-compatible transports', () => {
    it('capability=true: uses request effort and sends it as chat reasoning_effort', async () => {
        await client({}, true).chat({ messages: canonicalFixture([{ role: 'user', content: 'hi' }]), effort: 'high' });
        expect(capturedBody?.reasoning_effort).toBe('high');
    });
    it('capability=true: forwards none unchanged and suppresses generic thinking even when defaults enable it', async () => {
        await client({ enableThinking: true, thinkingType: 'adaptive', effort: 'medium' }, true).chat({
            messages: canonicalFixture([{ role: 'user', content: 'use the lookup tool' }]),
            effort: 'none',
            tools: [{ name: 'lookup', description: 'Lookup a value', inputSchema: { type: 'object' } }],
        });
        expect(capturedBody?.reasoning_effort).toBe('none');
        expect(capturedBody?.thinking).toBeUndefined();
        expect(capturedBody?.tools?.[0]?.function?.name).toBe('lookup');
    });
    it('capability=true: uses default effort, while request effort overrides the default', async () => {
        const c = client({ effort: 'low' }, true);
        await c.chat({ messages: canonicalFixture([{ role: 'user', content: 'first' }]) });
        expect(capturedBody?.reasoning_effort).toBe('low');
        await c.chat({ messages: canonicalFixture([{ role: 'user', content: 'second' }]), effort: 'xhigh' });
        expect(capturedBody?.reasoning_effort).toBe('xhigh');
    });
    it('does not send reasoning_effort without the explicit gateway capability', async () => {
        await client({ effort: 'low' }, false).chat({
            messages: canonicalFixture([{ role: 'user', content: 'default effort exists' }]),
        });
        expect(capturedBody?.reasoning_effort).toBeUndefined();
        await client().chat({
            messages: canonicalFixture([{ role: 'user', content: 'request effort exists' }]), effort: 'high',
        });
        expect(capturedBody?.reasoning_effort).toBeUndefined();
    });
    it('sends medium effort when configured for GLM-style latency control', async () => {
        await client({ effort: 'medium' }, true).chat({
            messages: canonicalFixture([{ role: 'user', content: 'extract this questionnaire' }]),
        });
        expect(capturedBody?.reasoning_effort).toBe('medium');
    });
    it('renders canonical image attachments and preserves the caller history', async () => {
        const messages = [{ type: 'event' as const, eventType: 'message', timestamp: new Date(0), content: 'inspect', attachments: [{ type: 'image' as const, mediaType: 'image/png', data: 'aGVsbG8=' }] }];
        const before = structuredClone(messages);
        await client().chat({ messages });
        expect(messages).toEqual(before);
        expect(capturedBody?.messages[0].content).toEqual([
            { type: 'image_url', image_url: { url: 'data:image/png;base64,aGVsbG8=' } },
            { type: 'text', text: 'inspect' },
        ]);
    });
    it('rejects canonical documents with an explicit unsupported error', async () => {
        await expect(client().chat({ messages: [{ type: 'event', eventType: 'message', timestamp: new Date(0), content: 'inspect', attachments: [{ type: 'document', mediaType: 'application/pdf', data: 'JVBERi0=' }] }] })).rejects.toThrow(/document attachments are unsupported/);
        expect(capturedBody).toBeNull();
    });
    it('replays canonical assistant tool calls and results', async () => {
        await client().chat({ messages: [
                { type: 'assistant', content: null, timestamp: new Date(0), toolCalls: [{ id: 'call_1', name: 'lookup', arguments: '{"id":1}' }] },
                { type: 'tool', timestamp: new Date(0), toolCallId: 'call_1', content: 'tool result' },
            ] });
        expect(capturedBody?.messages).toEqual([
            { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'lookup', arguments: '{"id":1}' } }] },
            { role: 'tool', tool_call_id: 'call_1', content: 'tool result' },
        ]);
    });
});
