import { canonicalFixture } from './fixtures/canonical.js';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { OpenAIClient, UpstreamStreamError } from '../clients/openai.js';
function makeClient() {
    return new OpenAIClient({
        apiKey: 'test',
        baseURL: 'http://fake',
        model: 'test-model',
        providerName: 'openrouter',
    });
}
function makeSseStream(chunks: object[]): Response {
    const body = chunks
        .map((c) => `data: ${JSON.stringify(c)}\n\n`)
        .join('') + 'data: [DONE]\n\n';
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
describe('OpenAIClient streaming · upstream error chunk', () => {
    it('throws UpstreamStreamError when chunk carries `error` field', async () => {
        globalThis.fetch = vi.fn().mockResolvedValue(makeSseStream([
            {
                id: 'gen-1',
                model: 'xiaomi/mimo-v2.5-pro',
                provider: 'DeepInfra',
                choices: [],
                error: {
                    code: 502,
                    message: '{"error":{"message":"Unterminated string at line 1 column 13 (char 12)","type":"BadRequestError","code":400}}',
                },
            },
        ]));
        const client = makeClient();
        await expect(client.chat({
            messages: canonicalFixture([{ type: 'event', content: 'hi', timestamp: 0 } as never]),
            systemPrompt: '',
            tools: [],
            onStreamDelta: () => { },
        })).rejects.toBeInstanceOf(UpstreamStreamError);
    });
    it('preserves structured provider type and code from an error chunk', async () => {
        globalThis.fetch = vi.fn().mockResolvedValue(makeSseStream([
            {
                choices: [],
                error: {
                    type: 'invalid_request_error',
                    code: 'invalid_prompt',
                    message: 'rejected',
                },
            },
        ]));
        const error = await makeClient().chat({
            messages: canonicalFixture([{ type: 'event', content: 'hi', timestamp: 0 } as never]),
            systemPrompt: '',
            tools: [],
            onStreamDelta: () => { },
        }).catch((err: unknown) => err);
        expect(error).toBeInstanceOf(UpstreamStreamError);
        expect(error).toMatchObject({
            providerType: 'invalid_request_error',
            providerCode: 'invalid_prompt',
        });
    });
    it('prefers a nested provider code over an outer gateway transport code', async () => {
        globalThis.fetch = vi.fn().mockResolvedValue(makeSseStream([
            {
                choices: [],
                error: {
                    code: 502,
                    message: JSON.stringify({
                        error: {
                            type: 'invalid_request_error',
                            code: 'invalid_prompt',
                            message: 'rejected',
                        },
                    }),
                },
            },
        ]));
        const error = await makeClient().chat({
            messages: canonicalFixture([{ type: 'event', content: 'hi', timestamp: 0 } as never]),
            systemPrompt: '',
            tools: [],
            onStreamDelta: () => { },
        }).catch((err: unknown) => err);
        expect(error).toMatchObject({
            providerType: 'invalid_request_error',
            providerCode: 'invalid_prompt',
        });
    });
    it('keeps an outer numeric code when there is no nested provider envelope', async () => {
        globalThis.fetch = vi.fn().mockResolvedValue(makeSseStream([{ choices: [], error: { code: 502, message: 'upstream failed' } }]));
        const error = await makeClient().chat({
            messages: canonicalFixture([{ type: 'event', content: 'hi', timestamp: 0 } as never]),
            systemPrompt: '',
            tools: [],
            onStreamDelta: () => { },
        }).catch((err: unknown) => err);
        expect(error).toMatchObject({ providerCode: 502 });
    });
    it('error message preserves upstream code and message', async () => {
        globalThis.fetch = vi.fn().mockResolvedValue(makeSseStream([
            {
                choices: [],
                error: { code: 429, message: 'rate limited' },
            },
        ]));
        const client = makeClient();
        await expect(client.chat({
            messages: canonicalFixture([{ type: 'event', content: 'hi', timestamp: 0 } as never]),
            systemPrompt: '',
            tools: [],
            onStreamDelta: () => { },
        })).rejects.toThrow(/code=429.*rate limited/);
    });
    it('rejects a stream with no completed choice', async () => {
        globalThis.fetch = vi.fn().mockResolvedValue(makeSseStream([
            { id: 'gen-2', choices: [], usage: { prompt_tokens: 5, completion_tokens: 0, total_tokens: 5 } },
        ]));
        const client = makeClient();
        const result = client.chat({
            messages: canonicalFixture([{ type: 'event', content: 'hi', timestamp: 0 } as never]),
            systemPrompt: '',
            tools: [],
            onStreamDelta: () => { },
        });
        await expect(result).rejects.toThrow(/missing finish_reason/);
    });
    it('rejects malformed event JSON instead of discarding a possible argument fragment', async () => {
        const body = 'data: {not-json\n\n' +
            'data: ' +
            JSON.stringify({
                choices: [{ index: 0, delta: { content: 'hello' }, finish_reason: null }],
            }) +
            '\n\n' +
            'data: ' +
            JSON.stringify({
                choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
                usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
            }) +
            '\n\n' +
            'data: [DONE]\n\n';
        globalThis.fetch = vi.fn().mockResolvedValue(new Response(body, {
            status: 200,
            headers: { 'Content-Type': 'text/event-stream' },
        }));
        const client = makeClient();
        const result = client.chat({
            messages: canonicalFixture([{ type: 'event', content: 'hi', timestamp: 0 } as never]),
            systemPrompt: '',
            tools: [],
            onStreamDelta: () => { },
        });
        await expect(result).rejects.toThrow(/Invalid JSON in upstream SSE event/);
    });
});
