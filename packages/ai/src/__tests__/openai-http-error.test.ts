import { describe, it, expect, vi, afterEach } from 'vitest';
import { OpenAIClient, OpenAICompatibleHttpError } from '../clients/openai.js';
function makeClient(apiKey = 'sk-must-not-leak') {
    return new OpenAIClient({
        apiKey,
        baseURL: 'http://fake',
        model: 'test-model',
        providerName: 'openai',
    });
}
function request(streaming: boolean) {
    return {
        messages: [{ type: 'event', content: 'hi', timestamp: 0 } as never],
        systemPrompt: '',
        tools: [],
        ...(streaming ? { onStreamDelta: () => { } } : {}),
    };
}
const originalFetch = globalThis.fetch;
afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
});
describe('OpenAIClient · HTTP errors preserve fallback metadata', () => {
    it.each([
        { name: 'non-streaming', streaming: false, message: /OpenAI-compatible API error: 429/ },
        { name: 'streaming', streaming: true, message: /OpenAI-compatible streaming API error: 429/ },
    ])('$name response keeps status, Retry-After, request ID, and body', async ({ streaming, message }) => {
        const responseBody = JSON.stringify({
            error: { code: '429001', message: 'RPM exceeded' },
        });
        globalThis.fetch = vi.fn().mockResolvedValue(new Response(responseBody, {
            status: 429,
            statusText: 'Too Many Requests',
            headers: {
                'retry-after': '2',
                'x-request-id': 'req-rate-limited',
            },
        }));
        const client = makeClient();
        const error = await client.chat(request(streaming)).catch((err: unknown) => err);
        expect(error).toBeInstanceOf(OpenAICompatibleHttpError);
        expect(error).toMatchObject({
            name: 'OpenAICompatibleHttpError',
            status: 429,
            statusCode: 429,
            response: { status: 429 },
            retryAfter: '2',
            upstreamRequestId: 'req-rate-limited',
            responseBody,
        });
        expect((error as Error).message).toMatch(message);
        expect((error as Error).message).toContain('429001');
        expect(JSON.stringify(error)).not.toContain('sk-must-not-leak');
    });
    it.each([
        { name: 'non-streaming', streaming: false },
        { name: 'streaming', streaming: true },
    ])('$name response preserves structured provider type and code', async ({ streaming }) => {
        const responseBody = JSON.stringify({
            error: {
                type: 'invalid_request_error',
                code: 'invalid_prompt',
                message: 'rejected',
            },
        });
        globalThis.fetch = vi.fn().mockResolvedValue(new Response(responseBody, { status: 400 }));
        const error = await makeClient().chat(request(streaming)).catch((err: unknown) => err);
        expect(error).toBeInstanceOf(OpenAICompatibleHttpError);
        expect(error).toMatchObject({
            status: 400,
            providerType: 'invalid_request_error',
            providerCode: 'invalid_prompt',
            responseBody,
        });
    });
    it('prefers nested provider metadata over an outer gateway transport code', async () => {
        const responseBody = JSON.stringify({
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
        });
        globalThis.fetch = vi.fn().mockResolvedValue(new Response(responseBody, { status: 400 }));
        const error = await makeClient().chat(request(true)).catch((err: unknown) => err);
        expect(error).toMatchObject({
            providerType: 'invalid_request_error',
            providerCode: 'invalid_prompt',
        });
    });
    it('preserves 5xx status without requiring optional headers', async () => {
        globalThis.fetch = vi.fn().mockResolvedValue(new Response('upstream unavailable', { status: 503 }));
        const error = await makeClient().chat(request(true)).catch((err: unknown) => err);
        expect(error).toBeInstanceOf(OpenAICompatibleHttpError);
        expect(error).toMatchObject({
            status: 503,
            statusCode: 503,
            response: { status: 503 },
            retryAfter: null,
            upstreamRequestId: null,
            responseBody: 'upstream unavailable',
        });
    });
    it('redacts credential-shaped body fields and bounds retained body size', async () => {
        const leakedSecret = 'sk-super-secret-value';
        const body = JSON.stringify({
            api_key: leakedSecret,
            client_secret: 'client-secret-value',
            refresh_token: 'refresh-token-value',
            private_key: 'private-key-value',
            authorization: `Bearer ${leakedSecret}`,
            detail: 'x'.repeat(20000),
        });
        globalThis.fetch = vi.fn().mockResolvedValue(new Response(body, { status: 429 }));
        const error = await makeClient(leakedSecret).chat(request(true)).catch((err: unknown) => err) as OpenAICompatibleHttpError;
        expect(error).toBeInstanceOf(OpenAICompatibleHttpError);
        expect(error.responseBody).not.toContain(leakedSecret);
        expect(error.responseBody).not.toContain('client-secret-value');
        expect(error.responseBody).not.toContain('refresh-token-value');
        expect(error.responseBody).not.toContain('private-key-value');
        expect(error.message).not.toContain(leakedSecret);
        expect(error.responseBody).toContain('[REDACTED]');
        expect(error.responseBody).toContain('[truncated');
        expect(error.responseBody.length).toBeLessThan(16500);
    });
});
