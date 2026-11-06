import { describe, it, expect } from 'vitest';
import { AnthropicAdapter, OpenAIAdapter, GeminiAdapter, } from '../adapters/index.js';
import type { AgentMessage, AssistantMessage } from '@nia-teams/ai/protocol';
function userEvent(content: string): AgentMessage { return { type: 'event', eventType: 'user_message', content, timestamp: new Date() }; }
const sampleLog: AgentMessage[] = [
    userEvent('hi'),
    {
        type: 'assistant',
        content: null,
        toolCalls: [{ id: 'tc1', name: 'echo', arguments: '{"text":"hi"}' }],
        timestamp: new Date(),
    },
    {
        type: 'tool',
        toolCallId: 'tc1',
        content: 'echo:hi',
        timestamp: new Date(),
    },
];
describe('AnthropicAdapter', () => {
    it('produces alternating user/assistant with tool_use + tool_result blocks', () => {
        const out = new AnthropicAdapter().fromStorage(sampleLog, '') as Array<{
            role: string;
            content: Array<{
                type: string;
            }>;
        }>;
        expect(out.length).toBeGreaterThanOrEqual(2);
        expect(out[0].role).toBe('user');
        const assistant = out.find((m) => m.role === 'assistant');
        expect(assistant).toBeDefined();
        const blockTypes = assistant!.content.map((b) => b.type);
        expect(blockTypes).toContain('tool_use');
        const lastUser = out.filter((m) => m.role === 'user').slice(-1)[0];
        expect(lastUser.content.map((b) => b.type)).toContain('tool_result');
    });
    it('drops unsigned DeepSeek reasoning when continuing the history with Claude', () => {
        const log: AgentMessage[] = [
            userEvent('查一下'),
            {
                type: 'assistant',
                content: null,
                reasoning: 'DeepSeek internal reasoning must not become Anthropic thinking.',
                model: 'deepseek-v3.2',
                toolCalls: [{ id: 'tc-deepseek', name: 'lookup', arguments: '{"date":"2026-08-20"}' }],
                timestamp: new Date(),
            },
            { type: 'tool', toolCallId: 'tc-deepseek', content: 'ok', timestamp: new Date() },
        ];
        const out = new AnthropicAdapter().fromStorage(log, '', 'claude-opus-4-6') as Array<{
            role: string;
            content: Array<{
                type: string;
                thinking?: string;
                id?: string;
            }>;
        }>;
        const assistant = out.find((message) => message.role === 'assistant')!;
        expect(assistant.content.some((block) => block.type === 'thinking')).toBe(false);
        expect(assistant.content).toContainEqual(expect.objectContaining({ type: 'tool_use', id: 'tc-deepseek' }));
    });
    it('keeps signed thinking only for the current model', () => {
        const signature = `sig_${'x'.repeat(420)}`;
        const history = (model?: string): AgentMessage[] => [
            userEvent('hi'),
            {
                type: 'assistant',
                content: 'answer',
                reasoning: 'private reasoning',
                reasoningSignature: signature,
                model,
                timestamp: new Date(),
            },
        ];
        const adapter = new AnthropicAdapter();
        const current = adapter.fromStorage(history('claude-opus-4-6'), '', 'claude-opus-4-6') as Array<{
            role: string;
            content: Array<{
                type: string;
                signature?: string;
            }>;
        }>;
        expect(current[1].content[0]).toEqual(expect.objectContaining({ type: 'thinking', signature }));
        const otherModel = adapter.fromStorage(history('claude-sonnet-5'), '', 'claude-opus-4-6') as Array<{
            role: string;
            content: Array<{
                type: string;
            }>;
        }>;
        expect(otherModel[1].content.map((block) => block.type)).toEqual(['text']);
        const legacy = adapter.fromStorage(history(undefined), '', 'claude-opus-4-6') as Array<{
            role: string;
            content: Array<{
                type: string;
                signature?: string;
            }>;
        }>;
        expect(legacy[1].content[0]).toEqual(expect.objectContaining({ type: 'thinking', signature }));
        const fallbackHistory = history('claude-opus-4-6');
        const fallbackAssistant = fallbackHistory[1];
        if (fallbackAssistant.type !== 'assistant')
            throw new Error('test fixture must be assistant');
        fallbackAssistant.usedFallbackModel = 'claude-sonnet-5';
        const fallback = adapter.fromStorage(fallbackHistory, '', 'claude-opus-4-6') as Array<{
            role: string;
            content: Array<{
                type: string;
            }>;
        }>;
        expect(fallback[1].content.map((block) => block.type)).toEqual(['text']);
    });
    it('skips reasoning-only history when its thinking cannot be replayed', () => {
        const log: AgentMessage[] = [
            userEvent('first'),
            {
                type: 'assistant',
                content: null,
                reasoning: 'unsigned reasoning only',
                model: 'deepseek-v3.2',
                timestamp: new Date(),
            },
            userEvent('latest'),
        ];
        const out = new AnthropicAdapter().fromStorage(log, '', 'claude-opus-4-6') as Array<{
            role: string;
            content: string | Array<{
                type: string;
            }>;
        }>;
        expect(out.some((message) => message.role === 'assistant')).toBe(false);
        expect(out).toHaveLength(1);
        expect(out[0].role).toBe('user');
    });
});
describe('OpenAIAdapter', () => {
    it('emits role=tool message with tool_call_id matching assistant tool_calls', () => {
        const out = new OpenAIAdapter().fromStorage(sampleLog, '') as Array<{
            role: string;
            tool_calls?: Array<{
                id: string;
            }>;
            tool_call_id?: string;
        }>;
        const assistant = out.find((m) => m.role === 'assistant')!;
        expect(assistant.tool_calls?.[0].id).toBe('tc1');
        const toolMsg = out.find((m) => m.role === 'tool')!;
        expect(toolMsg.tool_call_id).toBe('tc1');
    });
    it('falls back to user message for orphan tool result', () => {
        const orphan: AgentMessage[] = [
            userEvent('hi'),
            { type: 'tool', toolCallId: 'orphan-tc', content: 'x', timestamp: new Date() },
        ];
        const out = new OpenAIAdapter().fromStorage(orphan, '') as Array<{
            role: string;
            content: string;
        }>;
        const trailing = out[out.length - 1];
        expect(trailing.role).toBe('user');
        expect(trailing.content).toContain('orphan-tc');
    });
});
describe('GeminiAdapter', () => {
    it('emits functionCall + functionResponse parts keyed by name', () => {
        const out = new GeminiAdapter().fromStorage(sampleLog, '') as Array<{
            role: string;
            parts: Array<{
                functionCall?: {
                    name: string;
                };
                functionResponse?: {
                    name: string;
                };
            }>;
        }>;
        const model = out.find((m) => m.role === 'model')!;
        expect(model.parts[0].functionCall?.name).toBe('echo');
        const lastUser = out.filter((m) => m.role === 'user').slice(-1)[0];
        expect(lastUser.parts[0].functionResponse?.name).toBe('echo');
    });
});
describe('ProviderAdapter · typed AI post-context projection', () => {
    const context: AgentMessage = {
        type: 'event',
        eventType: 'user_message',
        content: 'hello',
        context: [{ kind: 'text', text: 'Next step: deploy' }],
        timestamp: new Date(),
    };
    const tool: AgentMessage = {
        type: 'tool',
        toolCallId: 'tc1',
        content: 'result',
        guidance: [{ kind: 'text', text: 'Approval required' }],
        timestamp: new Date(),
    };
    it('renders typed context for Anthropic', () => {
        const out = new AnthropicAdapter().fromStorage([context, ...sampleLog.slice(1), tool], '') as Array<{
            content: unknown;
        }>;
        const text = JSON.stringify(out);
        expect(text).toContain('Next step: deploy');
        expect(text).toContain('Approval required');
    });
    it('renders typed context for OpenAI and Gemini', () => {
        expect(JSON.stringify(new OpenAIAdapter().fromStorage([context, ...sampleLog.slice(1), tool], ''))).toContain('Next step: deploy');
        expect(JSON.stringify(new GeminiAdapter().fromStorage([context, ...sampleLog.slice(1), tool], ''))).toContain('Approval required');
    });
});
const model = 'google/gemini-4-argon';
const mergedDetails = [
    { type: 'reasoning.text', text: 'First next', signature: 'opaque-text-signature', index: 0, format: 'google-gemini-v1', id: 'r0' },
    { type: 'reasoning.encrypted', data: 'opaque+signature/==', format: 'google-gemini-v1', id: 'call_echo', index: 1, future: { keep: [1, null, 'bytes'] } },
];
describe('OpenAIAdapter model-bound opaque details', () => {
    const adapter = new OpenAIAdapter();
    const stored: AssistantMessage = { type: 'assistant', content: null, timestamp: new Date(), model, reasoningDetails: mergedDetails };
    it('scrubs other model signatures without altering storage', () => {
        expect((adapter.fromStorage([stored], '', 'other-model')[0] as any).reasoning_details).toBeUndefined();
        expect(stored.reasoningDetails).toEqual(mergedDetails);
    });
    it('uses the fallback model identity, not the primary model', () => {
        const fallback = { ...stored, model: 'primary', usedFallbackModel: model };
        expect((adapter.fromStorage([fallback], '', 'primary')[0] as any).reasoning_details).toBeUndefined();
        expect((adapter.fromStorage([fallback], '', model)[0] as any).reasoning_details).toEqual(mergedDetails);
    });
    it('preserves unsigned reasoning.text for unknown/moonshot formats while stripping unsigned anthropic/gemini', () => {
        const kimiMsg: AssistantMessage = {
            type: 'assistant',
            content: null,
            reasoning: 'step 1 step 2',
            timestamp: new Date(),
            model: 'moonshotai/kimi-k3.1-pro',
            reasoningDetails: [{ type: 'reasoning.text', text: 'step 1 step 2', format: 'unknown', index: 0 }],
        };
        const wire = adapter.fromStorage([kimiMsg], '', 'moonshotai/kimi-k3.1-pro')[0] as any;
        expect(wire.reasoning_details).toEqual([{ type: 'reasoning.text', text: 'step 1 step 2', format: 'unknown', index: 0 }]);
        expect(wire.reasoning_content).toBe('step 1 step 2');
    });
});
describe('malformed canonical history conversion', () => {
    const history: AgentMessage[] = [
        userEvent('go'),
        { type: 'assistant', content: 'Updating', toolCalls: [
                { id: 'good', name: 'file_read', arguments: '{"text":"src/people.md"}' },
                { id: 'bad', name: 'file_write', arguments: '{}', malformedError: 'invalid json' },
            ], timestamp: new Date() },
        { type: 'tool', toolCallId: 'good', content: 'ok', timestamp: new Date() },
        { type: 'tool', toolCallId: 'bad', content: 'The tool was NOT executed', isError: true, timestamp: new Date() },
    ];
    it('OpenAI emits safe arguments without transient diagnostic fields', () => {
        const wire = new OpenAIAdapter().fromStorage(history, '', 'model') as any[];
        expect(wire[1].tool_calls[1].function.arguments).toBe('{}');
        expect(wire[1].tool_calls[1].malformedError).toBeUndefined();
    });
    it('Anthropic preserves sibling tool uses and paired results', () => {
        const wire = new AnthropicAdapter().fromStorage(history, '', 'claude-opus-4-6') as any[];
        const uses = wire[1].content.filter((block: any) => block.type === 'tool_use');
        expect(uses).toHaveLength(2);
        expect(uses[1]).toEqual({ type: 'tool_use', id: 'bad', name: 'file_write', input: {} });
        expect(wire[2].content).toEqual(expect.arrayContaining([
            expect.objectContaining({ type: 'tool_result', tool_use_id: 'good' }),
            expect.objectContaining({ type: 'tool_result', tool_use_id: 'bad', is_error: true }),
        ]));
    });
    it('Gemini preserves paired function calls and results', () => {
        const wire = new GeminiAdapter().fromStorage(history, '', 'gemini-3-pro') as any[];
        expect(wire[1].parts).toEqual(expect.arrayContaining([expect.objectContaining({ functionCall: expect.objectContaining({ name: 'file_write', args: {} }) })]));
        expect(wire[2].parts).toEqual(expect.arrayContaining([expect.objectContaining({ functionResponse: expect.objectContaining({ name: 'file_write' }) })]));
    });
});
describe('canonical ingress rejects the removed wire API', () => {
    it.each([new AnthropicAdapter(), new OpenAIAdapter(), new GeminiAdapter()])('rejects role-shaped messages instead of silently discarding them', adapter => {
        expect(() => adapter.fromStorage([{ role: 'user', content: 'lost input' }] as unknown as AgentMessage[], ''))
            .toThrow('requires canonical AgentMessage[]');
    });
});
