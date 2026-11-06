import { assertCanonicalMessages } from './types.js';
import type { ProviderAdapter, AdapterCapabilities } from './types.js';
import type { AgentMessage, } from '@nia-teams/ai/protocol';
import { mergeSystemInjectionsIntoFollowingMessage } from './system-injection.js';
import { renderAiPostContexts } from '@nia-teams/ai/protocol';
interface AnthropicMessage {
    role: 'user' | 'assistant' | 'system';
    content: string | AnthropicContentBlock[];
}
type AnthropicContentBlock = {
    type: 'image' | 'document';
    source: {
        type: 'base64';
        media_type: string;
        data: string;
    };
} | {
    type: 'text';
    text: string;
} | {
    type: 'thinking';
    thinking: string;
    signature?: string;
} | {
    type: 'tool_use';
    id: string;
    name: string;
    input: unknown;
} | {
    type: 'tool_result';
    tool_use_id: string;
    content: string;
    is_error?: boolean;
};
type MidConversationSystemBlock = {
    type: 'text';
    text: string;
} | {
    type: 'tool_addition';
    tool: {
        type: 'tool_reference';
        name: string;
    };
} | {
    type: 'tool_removal';
    tool: {
        type: 'tool_reference';
        name: string;
    };
};
export class AnthropicAdapter implements ProviderAdapter {
    fromStorage(messages: AgentMessage[], _systemPrompt: string, currentModel?: string, capabilities?: AdapterCapabilities): unknown[] {
        assertCanonicalMessages(messages);
        const supportsNative = capabilities?.supportsMidConversationTools === true;
        const sourceMessages = supportsNative
            ? messages
            : mergeSystemInjectionsIntoFollowingMessage(messages);
        const result: AnthropicMessage[] = [];
        for (const msg of sourceMessages) {
            let entry: AnthropicMessage;
            if (msg.type === 'event') {
                entry = { role: 'user', content: [
                        ...(msg.attachments ?? []).map((a): AnthropicContentBlock => ({ type: a.type, source: { type: 'base64', media_type: a.mediaType, data: a.data } })),
                        { type: 'text', text: [msg.content, renderAiPostContexts(msg.context)].filter(Boolean).join('\n\n') },
                    ] };
            }
            else if (msg.type === 'assistant') {
                const content: AnthropicContentBlock[] = [];
                const hasValidThinkingSignature = typeof msg.reasoningSignature === 'string' && msg.reasoningSignature.length > 100;
                const historicalModel = msg.usedFallbackModel ?? msg.model;
                const isCurrentModelThinking = !currentModel || !historicalModel || historicalModel === currentModel;
                if (msg.reasoning && hasValidThinkingSignature && isCurrentModelThinking) {
                    content.push({
                        type: 'thinking',
                        thinking: msg.reasoning,
                        signature: msg.reasoningSignature,
                    });
                }
                if (msg.content) {
                    content.push({ type: 'text', text: msg.content });
                }
                if (msg.toolCalls) {
                    for (const tc of msg.toolCalls) {
                        let input: unknown;
                        try {
                            input = JSON.parse(tc.arguments);
                        }
                        catch {
                            input = {};
                        }
                        content.push({ type: 'tool_use', id: tc.id, name: tc.name, input });
                    }
                }
                if (content.length === 0)
                    continue;
                entry = { role: 'assistant', content };
            }
            else if (msg.type === 'tool') {
                entry = {
                    role: 'user',
                    content: [
                        {
                            type: 'tool_result',
                            tool_use_id: msg.toolCallId,
                            content: [msg.content, renderAiPostContexts(msg.guidance)].filter(Boolean).join('\n\n'),
                            is_error: msg.isError || undefined,
                        },
                    ],
                };
            }
            else if (msg.type === 'system_injection') {
                const blocks: MidConversationSystemBlock[] = [];
                if (msg.blocks && msg.blocks.length > 0) {
                    for (const b of msg.blocks) {
                        if (b.type === 'text') {
                            blocks.push({ type: 'text', text: b.text });
                        }
                        else if (b.type === 'tool_addition') {
                            blocks.push({
                                type: 'tool_addition',
                                tool: { type: 'tool_reference', name: b.toolName },
                            });
                        }
                        else if (b.type === 'tool_removal') {
                            blocks.push({
                                type: 'tool_removal',
                                tool: { type: 'tool_reference', name: b.toolName },
                            });
                        }
                    }
                }
                else if (msg.content) {
                    blocks.push({ type: 'text', text: msg.content });
                }
                if (blocks.length === 0)
                    continue;
                result.push({ role: 'system', content: blocks as unknown as AnthropicContentBlock[] });
                continue;
            }
            else {
                continue;
            }
            const prev = result[result.length - 1];
            if (prev && prev.role === entry.role) {
                const prevBlocks = Array.isArray(prev.content)
                    ? prev.content
                    : [{ type: 'text' as const, text: prev.content }];
                const entryBlocks = Array.isArray(entry.content)
                    ? entry.content
                    : [{ type: 'text' as const, text: entry.content }];
                prev.content = [...prevBlocks, ...entryBlocks];
            }
            else {
                result.push(entry);
            }
        }
        return result;
    }
}
