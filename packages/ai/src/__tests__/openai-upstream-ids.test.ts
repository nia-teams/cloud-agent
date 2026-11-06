import { canonicalFixture } from './fixtures/canonical.js';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { OpenAIClient } from '../clients/openai.js';
function makeClient() {
    return new OpenAIClient({
        apiKey: 'test',
        baseURL: 'http://fake',
        model: 'test-model',
        providerName: 'openrouter',
    });
}
function makeStream(chunks: object[]): Response {
    const body = chunks
        .map((c) => `data: ${JSON.stringify(c)}\n\n`)
        .join('') + 'data: [DONE]\n\n';
    return new Response(body, {
        status: 200,
        headers: {
            'Content-Type': 'text/event-stream',
            'X-Oneapi-Request-Id': 'gw-req-7777',
        },
    });
}
describe('OpenAIClient · upstream id propagation on success', () => {
    let originalFetch: typeof globalThis.fetch;
    beforeEach(() => {
        originalFetch = globalThis.fetch;
    });
    afterEach(() => {
        globalThis.fetch = originalFetch;
    });
    it('streaming success surfaces upstreamRequestId + upstreamCompletionId on LLMChatResponse', async () => {
        const client = makeClient();
        const stream = makeStream([
            { id: 'cmpl-zzz-1', model: 'mimo-x', choices: [{ index: 0, delta: { content: 'hi' } }] },
            { id: 'cmpl-zzz-1', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 1 } },
        ]);
        (globalThis.fetch as unknown) = (async () => stream) as typeof fetch;
        const resp = await client.chat({
            messages: canonicalFixture([]),
            systemPrompt: '',
            onStreamDelta: () => { },
        });
        expect(resp.upstreamRequestId).toBe('gw-req-7777');
        expect(resp.upstreamCompletionId).toBe('cmpl-zzz-1');
        expect(resp.content).toBe('hi');
    });
    it('non-streaming success surfaces upstreamRequestId + upstreamCompletionId', async () => {
        const client = makeClient();
        const body = JSON.stringify({
            id: 'cmpl-non-stream-9',
            choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'ok' } }],
            usage: { prompt_tokens: 5, completion_tokens: 1 },
        });
        const response = new Response(body, {
            status: 200,
            headers: {
                'Content-Type': 'application/json',
                'X-Oneapi-Request-Id': 'gw-req-non-stream-1',
            },
        });
        (globalThis.fetch as unknown) = (async () => response) as typeof fetch;
        const resp = await client.chat({ messages: canonicalFixture([]), systemPrompt: '', onStreamDelta: undefined });
        expect(resp.upstreamRequestId).toBe('gw-req-non-stream-1');
        expect(resp.upstreamCompletionId).toBe('cmpl-non-stream-9');
    });
});
