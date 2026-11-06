import { afterEach, describe, expect, it, vi } from 'vitest';
import { GeminiClient } from '../clients/gemini.js';
import type { AgentMessage } from '../protocol/index.js';

afterEach(() => vi.unstubAllGlobals());
const messages: AgentMessage[] = [
    { type: 'event', eventType: 'user', content: 'hello', timestamp: new Date(0) },
    { type: 'assistant', content: null, timestamp: new Date(0) },
    { type: 'tool', toolCallId: 'call', content: 'done', timestamp: new Date(0) },
];

describe('Gemini authentication and older-model tool calls', () => {
    it.each([undefined, 'x-goog-api-key', 'bearer'] as const)('uses authHeader=%s for non-streaming and streaming chat', async authHeader => {
        const requests: RequestInit[] = [];
        vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
            requests.push(init);
            const chunk = { candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }] };
            const streaming = url.includes(':streamGenerateContent');
            return new Response(streaming ? `data: ${JSON.stringify(chunk)}\n\n` : JSON.stringify(chunk), {
                headers: { 'Content-Type': streaming ? 'text/event-stream' : 'application/json' },
            });
        }));
        const client = new GeminiClient({ apiKey: 'AIza-test-key', model: 'gemini-test', authHeader, extraHeaders: { 'X-Custom': 'custom' } });
        expect((await client.chat({ messages })).content).toBe('ok');
        await client.chat({ messages: [], onStreamDelta() {} });
        expect(requests).toHaveLength(2);
        for (const request of requests) {
            const headers = new Headers(request.headers);
            expect(headers.get('x-custom')).toBe('custom');
            expect(headers.get('x-goog-api-key')).toBe(authHeader === 'bearer' ? null : 'AIza-test-key');
            expect(headers.get('authorization')).toBe(authHeader === 'bearer' ? 'Bearer AIza-test-key' : null);
        }

    });
    it.each([false, true])('generates UUIDs only for missing functionCall.id (streaming=%s)', async streaming => {
        const chunk = { candidates: [{ content: { parts: [
            { functionCall: { name: 'lookup', args: { key: 1 } } },
            { functionCall: { name: 'lookup', args: { key: 2 } } },
            { functionCall: { id: 'provider-call-id', name: 'lookup', args: {} } },
        ] }, finishReason: 'STOP' }] };
        vi.stubGlobal('fetch', vi.fn(async () => new Response(streaming ? `data: ${JSON.stringify(chunk)}\n\n` : JSON.stringify(chunk), {
            headers: { 'Content-Type': streaming ? 'text/event-stream' : 'application/json' },
        })));
        const client = new GeminiClient({ apiKey: 'key', model: 'older-model' });
        const result = await client.chat({ messages: [], ...(streaming ? { onStreamDelta() {} } : {}) });
        expect(result.stopReason).toBe('tool_use');
        expect(result.toolCalls).toHaveLength(3);
        const ids = result.toolCalls!.map(call => call.id);
        expect(ids[0]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
        expect(ids[1]).not.toBe(ids[0]);
        expect(ids[2]).toBe('provider-call-id');
    });
});
