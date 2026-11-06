import { assertCanonicalMessages } from './types.js';
import type { ProviderAdapter } from './types.js';
import type { AgentMessage, AssistantMessage, } from '@nia-teams/ai/protocol';
import { mergeSystemInjectionsIntoFollowingMessage } from './system-injection.js';
import { renderAiPostContexts } from '@nia-teams/ai/protocol';
interface OpenAIMessage {
    role: 'system' | 'user' | 'assistant' | 'tool';
    content: string | null | Array<{
        type: 'text';
        text: string;
    } | {
        type: 'image_url';
        image_url: {
            url: string;
        };
    } | {
        type: 'file';
        file: {
            file_data: string;
            filename: string;
        };
    }>;
    tool_calls?: Array<{
        id: string;
        type: 'function';
        function: {
            name: string;
            arguments: string;
        };
    }>;
    tool_call_id?: string;
    reasoning_content?: string;
    reasoning_details?: AssistantMessage['reasoningDetails'];
}
export class OpenAIAdapter implements ProviderAdapter {
    constructor(private readonly target: 'chat' | 'responses' = 'chat') { }
    fromStorage(messages: AgentMessage[], _systemPrompt: string, currentModel?: string): unknown[] {
        assertCanonicalMessages(messages);
        const result: OpenAIMessage[] = [];
        const flattened = mergeSystemInjectionsIntoFollowingMessage(messages);
        for (const msg of flattened) {
            if (msg.type === 'event') {
                const text = [msg.content, renderAiPostContexts(msg.context)].filter(Boolean).join('\n\n');
                if (this.target === 'chat' && msg.attachments?.some((a) => a.type === 'document')) {
                    throw new Error('OpenAIAdapter: document attachments are unsupported by the OpenAI-compatible chat converter; use an Anthropic or Gemini client for document input.');
                }
                result.push({ role: 'user', content: msg.attachments?.length ? [
                        ...msg.attachments.map((a) => a.type === 'document'
                            ? { type: 'file' as const, file: { file_data: `data:${a.mediaType};base64,${a.data}`, filename: 'document.pdf' } }
                            : { type: 'image_url' as const, image_url: { url: `data:${a.mediaType};base64,${a.data}` } }),
                        { type: 'text', text },
                    ] : text });
            }
            else if (msg.type === 'assistant') {
                const assistantMsg: OpenAIMessage = {
                    role: 'assistant',
                    content: msg.content,
                };
                if (msg.toolCalls && msg.toolCalls.length > 0) {
                    assistantMsg.tool_calls = msg.toolCalls.map((tc) => ({
                        id: tc.id,
                        type: 'function' as const,
                        function: { name: tc.name, arguments: tc.arguments },
                    }));
                }
                const isCurrentModel = !currentModel || !msg.model || msg.model === currentModel;
                const reasoningModel = msg.usedFallbackModel ?? msg.model;
                let validReasoningDetails: unknown[] | undefined;
                if (msg.reasoningDetails && (!currentModel || !reasoningModel || reasoningModel === currentModel)) {
                    validReasoningDetails = msg.reasoningDetails.filter((detail) => {
                        if (!detail || typeof detail !== 'object' || Array.isArray(detail))
                            return true;
                        const d = detail as Record<string, unknown>;
                        if (d.type !== 'reasoning.text')
                            return true;
                        const format = typeof d.format === 'string' ? d.format : 'anthropic-claude-v1';
                        if (format !== 'anthropic-claude-v1' && format !== 'google-gemini-v1')
                            return true;
                        return Boolean(d.signature);
                    });
                    if (validReasoningDetails.length > 0 || msg.reasoningDetails.length === 0) {
                        assistantMsg.reasoning_details = validReasoningDetails;
                    }
                }
                const hasStructuredReasoningDetail = Boolean(validReasoningDetails?.some((detail) => {
                    if (!detail || typeof detail !== 'object' || Array.isArray(detail))
                        return false;
                    const t = (detail as {
                        type?: unknown;
                    }).type;
                    return typeof t === 'string' && t.startsWith('reasoning.');
                }));
                if (msg.reasoning && isCurrentModel && (!msg.reasoningDetails || hasStructuredReasoningDetail || !validReasoningDetails)) {
                    assistantMsg.reasoning_content = msg.reasoning;
                }
                result.push(assistantMsg);
            }
            else if (msg.type === 'tool') {
                let hasMatchingAssistant = false;
                for (let i = result.length - 1; i >= 0; i--) {
                    const prevMsg = result[i];
                    if (prevMsg.role === 'assistant' && prevMsg.tool_calls?.length) {
                        hasMatchingAssistant = prevMsg.tool_calls.some((tc) => tc.id === msg.toolCallId);
                        break;
                    }
                    if (prevMsg.role === 'user')
                        break;
                }
                if (hasMatchingAssistant) {
                    result.push({
                        role: 'tool',
                        tool_call_id: msg.toolCallId,
                        content: [msg.content, renderAiPostContexts(msg.guidance)].filter(Boolean).join('\n\n'),
                    });
                }
                else {
                    const toolResultText = `[Tool Result ${msg.toolCallId}]${msg.isError ? ' [Error]' : ''}\n${msg.content}`;
                    result.push({ role: 'user', content: toolResultText });
                }
            }
        }
        return result;
    }
}
