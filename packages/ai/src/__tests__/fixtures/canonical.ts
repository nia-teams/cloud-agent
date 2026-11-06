import type { AgentMessage } from '@nia-teams/ai/protocol';
export function canonicalFixture(messages: any[]): AgentMessage[] {
    return messages.flatMap((m): any[] => {
        if (m.type)
            return [m];
        const blocks = Array.isArray(m.content) ? m.content : [];
        const content = typeof m.content === 'string' ? m.content : blocks.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n');
        const timestamp = new Date(0);
        if (m.role === 'system')
            return [{ type: 'system_injection', content, blocks: blocks.length ? blocks.map((b: any) => b.type === 'tool_addition' || b.type === 'tool_removal' ? { type: b.type, toolName: b.tool.name } : b) : undefined, timestamp }];
        if (m.role === 'tool')
            return [{ type: 'tool', toolCallId: m.tool_call_id, content, timestamp }];
        if (m.role === 'assistant')
            return [{ type: 'assistant', content, timestamp,
                    reasoning: m.reasoning_content ?? blocks.find((b: any) => b.type === 'thinking')?.thinking,
                    reasoningSignature: blocks.find((b: any) => b.type === 'thinking')?.signature,
                    reasoningDetails: m.reasoning_details,
                    toolCalls: m.tool_calls?.map((t: any) => ({ id: t.id, name: t.function.name, arguments: t.function.arguments })) ?? (blocks.some((b: any) => b.type === 'tool_use') ? blocks.filter((b: any) => b.type === 'tool_use').map((b: any) => ({ id: b.id, name: b.name, arguments: JSON.stringify(b.input) })) : undefined),
                }];
        const results = blocks.filter((b: any) => b.type === 'tool_result').map((b: any) => ({ type: 'tool', toolCallId: b.tool_use_id, content: b.content, isError: b.is_error, timestamp }));
        const attachments = blocks.filter((b: any) => b.type === 'image' || b.type === 'document').map((b: any) => ({ type: b.type, mediaType: b.source.media_type, data: b.source.data }));
        for (const b of blocks.filter((b: any) => b.type === 'image_url')) {
            const match = /^data:([^;]+);base64,(.*)$/.exec(b.image_url.url);
            if (!match)
                throw new Error('Test fixture requires a base64 image');
            attachments.push({ type: 'image', mediaType: match[1], data: match[2] });
        }
        return [...(content || attachments.length || !results.length ? [{ type: 'event', content, eventType: 'message', timestamp, ...(attachments.length ? { attachments } : {}) }] : []), ...results];
    });
}
