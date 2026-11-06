import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpenAIClient } from '../clients/openai.js';
const originalFetch = globalThis.fetch;
afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
});
function makeRequest(streaming: boolean) {
    return {
        messages: [{ type: 'event', content: 'hello', timestamp: 0 } as never],
        systemPrompt: '',
        tools: [],
        ...(streaming ? { onStreamDelta: () => { } } : {}),
    };
}
describe('OpenAIClient · extra headers', () => {
    it.each([
        { name: 'non-streaming', streaming: false },
        { name: 'streaming', streaming: true },
    ])('sends configured headers on $name requests', async ({ streaming }) => {
        globalThis.fetch = vi.fn().mockResolvedValue(new Response('{"error":{"message":"stop after capture"}}', { status: 400 }));
        const client = new OpenAIClient({
            apiKey: 'test-key',
            baseURL: 'http://llmapi.test/v1',
            model: 'test-model',
            providerName: 'openai',
            extraHeaders: { 'X-Session-ID': '507f1f77bcf86cd799439011' },
        });
        await client.chat(makeRequest(streaming)).catch(() => undefined);
        expect(globalThis.fetch).toHaveBeenCalledTimes(1);
        const [url, init] = vi.mocked(globalThis.fetch).mock.calls[0]!;
        expect(url).toBe('http://llmapi.test/v1/chat/completions');
        const headers = new Headers(init?.headers);
        expect(headers.get('X-Session-ID')).toBe('507f1f77bcf86cd799439011');
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        expect(body.stream).toBe(streaming ? true : undefined);
    });
});
