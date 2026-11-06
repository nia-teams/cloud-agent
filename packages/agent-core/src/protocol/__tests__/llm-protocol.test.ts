import { describe, expect, it } from 'vitest';
import { MalformedToolArgumentsError, renderAiPostContexts } from '../llm-protocol.js';
import type { ILLMClient, LLMChatResponse, UpstreamRequestMeta } from '../llm-protocol.js';
describe('shared LLM protocol', () => {
    it('allows a caller-provided client without any registry or SDK', async () => {
        const client: ILLMClient = {
            getProviderName: () => 'caller',
            getModelName: () => 'mock',
            chat: async () => ({ content: 'ok', stopReason: 'end_turn' }),
        };
        expect((await client.chat({ messages: [] })).content).toBe('ok');
    });
    it('preserves error metadata and the exact partial response for recovery', () => {
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
    it('keeps context rendering and empty rendering unchanged', () => {
        const context = { kind: 'text', text: 'continue' } as const;
        expect(renderAiPostContexts(undefined)).toBe('');
        expect(renderAiPostContexts([context, context])).toBe('continue\n\ncontinue');
    });
});
