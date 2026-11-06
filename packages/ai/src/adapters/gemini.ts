import { assertCanonicalMessages } from './types.js';
import type { ProviderAdapter } from './types.js';
import type { AgentMessage, } from '@nia-teams/ai/protocol';
import { mergeSystemInjectionsIntoFollowingMessage } from './system-injection.js';
import { renderAiPostContexts } from '@nia-teams/ai/protocol';
interface GeminiPart {
    inlineData?: {
        mimeType: string;
        data: string;
    };
    text?: string;
    functionCall?: {
        name: string;
        args: Record<string, unknown>;
    };
    functionResponse?: {
        name: string;
        response: Record<string, unknown>;
    };
    thoughtSignature?: string;
}
interface GeminiContent {
    role: 'user' | 'model';
    parts: GeminiPart[];
}
export class GeminiAdapter implements ProviderAdapter {
    fromStorage(messages: AgentMessage[], _systemPrompt: string, _currentModel?: string): unknown[] {
        assertCanonicalMessages(messages);
        const result: GeminiContent[] = [];
        const flattened = mergeSystemInjectionsIntoFollowingMessage(messages);
        for (const msg of flattened) {
            if (msg.type === 'event') {
                this.pushMerged(result, {
                    role: 'user',
                    parts: [
                        ...(msg.attachments ?? []).map((a) => ({ inlineData: { mimeType: a.mediaType, data: a.data } })),
                        { text: [msg.content, renderAiPostContexts(msg.context)].filter(Boolean).join('\n\n') },
                    ],
                });
            }
            else if (msg.type === 'assistant') {
                const parts: GeminiPart[] = [];
                if (msg.content) {
                    const textPart: GeminiPart = { text: msg.content };
                    if (msg.reasoningSignature && !msg.toolCalls?.length) {
                        textPart.thoughtSignature = msg.reasoningSignature;
                    }
                    parts.push(textPart);
                }
                if (msg.toolCalls && msg.toolCalls.length > 0) {
                    for (let i = 0; i < msg.toolCalls.length; i++) {
                        const tc = msg.toolCalls[i];
                        let args: Record<string, unknown>;
                        try {
                            args = JSON.parse(tc.arguments);
                        }
                        catch {
                            args = {};
                        }
                        const fcPart: GeminiPart = {
                            functionCall: { name: tc.name, args },
                        };
                        if (msg.reasoningSignature && i === msg.toolCalls.length - 1) {
                            fcPart.thoughtSignature = msg.reasoningSignature;
                        }
                        parts.push(fcPart);
                    }
                }
                if (parts.length === 0) {
                    parts.push({ text: '' });
                }
                this.pushMerged(result, { role: 'model', parts });
            }
            else if (msg.type === 'tool') {
                const funcName = this.findToolCallName(messages, msg.toolCallId);
                let responseObj: Record<string, unknown>;
                if (msg.isError) {
                    responseObj = { error: msg.content };
                }
                else {
                    try {
                        responseObj = JSON.parse(msg.content);
                    }
                    catch {
                        responseObj = { content: msg.content };
                    }
                }
                const guidanceText = renderAiPostContexts(msg.guidance);
                this.pushMerged(result, {
                    role: 'user',
                    parts: [
                        {
                            functionResponse: { name: funcName, response: responseObj },
                        },
                        ...(guidanceText ? [{ text: guidanceText }] : []),
                    ],
                });
            }
        }
        return result;
    }
    private pushMerged(result: GeminiContent[], entry: GeminiContent): void {
        const prev = result[result.length - 1];
        if (prev && prev.role === entry.role) {
            prev.parts.push(...entry.parts);
        }
        else {
            result.push(entry);
        }
    }
    private findToolCallName(messages: AgentMessage[], toolCallId: string): string {
        for (let i = messages.length - 1; i >= 0; i--) {
            const msg = messages[i];
            if (msg.type === 'assistant' && msg.toolCalls) {
                const tc = msg.toolCalls.find((t) => t.id === toolCallId);
                if (tc)
                    return tc.name;
            }
        }
        if (toolCallId.startsWith('gemini:')) {
            const parts = toolCallId.split(':');
            if (parts.length >= 2)
                return parts[1];
        }
        return toolCallId;
    }
}
