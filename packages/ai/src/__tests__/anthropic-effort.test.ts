import { canonicalFixture } from './fixtures/canonical.js';
import { describe, it, expect, vi } from 'vitest';
import { AnthropicClient } from '../clients/anthropic.js';
import type Anthropic from '@anthropic-ai/sdk';
import type { ReasoningEffort } from '../types.js';
function makeClientWithCapture(defaults?: {
    effort?: ReasoningEffort;
}) {
    const c = new AnthropicClient({
        apiKey: 'test',
        model: 'claude-sonnet-5',
        baseURL: 'http://fake',
        defaults,
    });
    const captured: Anthropic.MessageCreateParams[] = [];
    (c as any).client = {
        messages: {
            create: vi.fn().mockImplementation((params: Anthropic.MessageCreateParams) => {
                captured.push(JSON.parse(JSON.stringify(params)));
                return Promise.resolve({
                    id: 'msg_1',
                    model: 'claude-sonnet-5',
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
describe('AnthropicClient · output_config.effort passthrough', () => {
    it('per-call request.effort is sent as output_config.effort', async () => {
        const { client, captured } = makeClientWithCapture();
        await client.chat({ messages: canonicalFixture(baseMsg), systemPrompt: 's', effort: 'xhigh' });
        expect((captured[0] as unknown as Record<string, unknown>).output_config).toEqual({
            effort: 'xhigh',
        });
    });
    it('falls back to ModelConfig-derived defaults.effort when request.effort is undefined', async () => {
        const { client, captured } = makeClientWithCapture({ effort: 'low' });
        await client.chat({ messages: canonicalFixture(baseMsg), systemPrompt: 's' });
        expect((captured[0] as unknown as Record<string, unknown>).output_config).toEqual({
            effort: 'low',
        });
    });
    it('request.effort overrides defaults.effort', async () => {
        const { client, captured } = makeClientWithCapture({ effort: 'low' });
        await client.chat({ messages: canonicalFixture(baseMsg), systemPrompt: 's', effort: 'max' });
        expect((captured[0] as unknown as Record<string, unknown>).output_config).toEqual({
            effort: 'max',
        });
    });
    it('omits output_config entirely when neither request nor defaults set effort', async () => {
        const { client, captured } = makeClientWithCapture();
        await client.chat({ messages: canonicalFixture(baseMsg), systemPrompt: 's' });
        expect((captured[0] as unknown as Record<string, unknown>).output_config).toBeUndefined();
    });
    it('does not forward Codex-only effort none to Anthropic output_config', async () => {
        const { client, captured } = makeClientWithCapture({ effort: 'none' });
        await client.chat({ messages: canonicalFixture(baseMsg), systemPrompt: 's' });
        expect((captured[0] as unknown as Record<string, unknown>).output_config).toBeUndefined();
    });
});
