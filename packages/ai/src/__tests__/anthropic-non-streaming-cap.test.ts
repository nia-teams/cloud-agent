import { canonicalFixture } from './fixtures/canonical.js';
import { describe, it, expect, vi } from 'vitest';
import { AnthropicClient } from '../clients/anthropic.js';
import type Anthropic from '@anthropic-ai/sdk';
function makeClientWithCapture(defaults?: {
    maxOutputTokens?: number;
}) {
    const c = new AnthropicClient({
        apiKey: 'test',
        model: 'claude-opus-4-6',
        baseURL: 'http://fake',
        defaults: defaults ?? { maxOutputTokens: 128000 },
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
const baseMsg: Anthropic.MessageParam[] = [{ role: 'user', content: 'hi' }];
describe('AnthropicClient · non-streaming max_tokens cap', () => {
    it('caps ModelConfig default 128k → 16384 in non-streaming call', async () => {
        const { client, captured } = makeClientWithCapture({ maxOutputTokens: 128000 });
        await client.chat({ messages: canonicalFixture(baseMsg), systemPrompt: 's' });
        expect(captured[0].max_tokens).toBe(16384);
    });
    it('does NOT cap when onStreamDelta is provided (streaming path)', async () => {
        const { client, captured } = makeClientWithCapture({ maxOutputTokens: 128000 });
        (client as any).chatStreaming = vi
            .fn()
            .mockImplementation((params: Anthropic.MessageCreateParams) => {
            captured.push(JSON.parse(JSON.stringify(params)));
            return Promise.resolve({
                content: 'ok',
                toolCalls: [],
                stopReason: 'end_turn',
                usage: { inputTokens: 10, outputTokens: 1 },
            });
        });
        await client.chat({
            messages: canonicalFixture(baseMsg),
            systemPrompt: 's',
            onStreamDelta: () => { },
        });
        expect(captured[0].max_tokens).toBe(128000);
    });
    it('does NOT cap when caller explicitly passes maxTokens (non-streaming, explicit)', async () => {
        const { client, captured } = makeClientWithCapture({ maxOutputTokens: 128000 });
        await client.chat({
            messages: canonicalFixture(baseMsg),
            systemPrompt: 's',
            maxTokens: 50000,
        });
        expect(captured[0].max_tokens).toBe(50000);
    });
    it('leaves small ModelConfig default untouched', async () => {
        const { client, captured } = makeClientWithCapture({ maxOutputTokens: 8000 });
        await client.chat({ messages: canonicalFixture(baseMsg), systemPrompt: 's' });
        expect(captured[0].max_tokens).toBe(8000);
    });
    it('leaves boundary value (16384) untouched', async () => {
        const { client, captured } = makeClientWithCapture({ maxOutputTokens: 16384 });
        await client.chat({ messages: canonicalFixture(baseMsg), systemPrompt: 's' });
        expect(captured[0].max_tokens).toBe(16384);
    });
    it('falls back to 16384 when no defaults at all (constructor without defaults)', async () => {
        const c = new AnthropicClient({
            apiKey: 'test',
            model: 'claude-opus-4-6',
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
        await c.chat({ messages: canonicalFixture(baseMsg), systemPrompt: 's' });
        expect(captured[0].max_tokens).toBe(16384);
    });
});
