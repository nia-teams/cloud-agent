import { canonicalFixture } from './fixtures/canonical.js';
import { describe, expect, it, vi } from 'vitest';
vi.mock('../models.js', () => { throw new Error('protocol loaded model registry'); });
vi.mock('../factory.js', () => { throw new Error('protocol loaded client factory'); });
vi.mock('../clients/openai.js', () => { throw new Error('protocol loaded OpenAI transport'); });
vi.mock('openai', () => { throw new Error('protocol loaded OpenAI SDK'); });
vi.mock('@anthropic-ai/sdk', () => { throw new Error('protocol loaded Anthropic SDK'); });
import { MalformedToolArgumentsError, renderAiPostContext, renderAiPostContexts } from '../protocol/index.js';
import type { ILLMClient, LLMChatResponse, UpstreamRequestMeta } from '../protocol/index.js';
describe('protocol-only entry point', () => {
    it('renders context without loading registry, clients, or drivers', () => {
        const context = { kind: 'text', text: 'next' } as const;
        expect(renderAiPostContext(context)).toBe('next');
        expect(renderAiPostContexts([context, context])).toBe('next\n\nnext');
        expect(renderAiPostContexts(undefined)).toBe('');
    });
    it('preserves malformed-tool recovery metadata and partial response', () => {
        const partial: LLMChatResponse = { content: null, toolCalls: [], stopReason: 'tool_use' };
        const meta: UpstreamRequestMeta = { upstreamRequestId: 'request', upstreamCompletionId: 'completion' };
        const error = new MalformedToolArgumentsError('call', 'tool', '{', meta, partial);
        expect(error).toBeInstanceOf(Error);
        expect(error.name).toBe('MalformedToolArgumentsError');
        expect(error.toolCallId).toBe('call');
        expect(error.toolName).toBe('tool');
        expect(error.rawArguments).toBe('{');
        expect(error.upstreamRequestId).toBe('request');
        expect(error.upstreamCompletionId).toBe('completion');
        expect(error.partialResponse).toBe(partial);
    });
    it('exposes a structurally implementable client contract', async () => {
        const client: ILLMClient = {
            getProviderName: () => 'test',
            getModelName: () => 'test',
            chat: async () => ({ content: 'ok', stopReason: 'end_turn' }),
        };
        expect((await client.chat({ messages: canonicalFixture([]) })).content).toBe('ok');
    });
});
