import type { AgentMessage, SystemInjectionMessage } from '@nia-teams/ai/protocol';
export function renderSystemInjectionFallbackText(msg: SystemInjectionMessage): string {
    const lines: string[] = [];
    if (msg.blocks && msg.blocks.length > 0) {
        for (const b of msg.blocks) {
            if (b.type === 'text') {
                lines.push(b.text);
            }
            else if (b.type === 'tool_addition') {
                lines.push(`Tool \`${b.toolName}\` is now available and can be called directly.`);
            }
            else if (b.type === 'tool_removal') {
                lines.push(`Tool \`${b.toolName}\` is no longer available; do not call it.`);
            }
        }
    }
    else if (msg.content) {
        lines.push(msg.content);
    }
    return `<system-reminder>\n${lines.join('\n')}\n</system-reminder>`;
}
export function mergeSystemInjectionsIntoFollowingMessage(messages: AgentMessage[]): AgentMessage[] {
    const out: AgentMessage[] = [];
    let carry: string[] = [];
    const open = new Set<string>();
    const flushOnto = (msg: AgentMessage): AgentMessage => {
        const prefix = carry.join('\n\n') + '\n\n';
        carry = [];
        if (msg.type === 'event') {
            return { ...msg, content: prefix + msg.content };
        }
        out.push({
            type: 'event',
            eventType: 'system_injection.fallback',
            content: prefix.trimEnd(),
            timestamp: new Date(),
        });
        return msg;
    };
    for (const msg of messages) {
        if (msg.type === 'system_injection') {
            carry.push(renderSystemInjectionFallbackText(msg));
            continue;
        }
        const safeToFlush = carry.length > 0 && open.size === 0;
        out.push(safeToFlush ? flushOnto(msg) : msg);
        if (msg.type === 'assistant' && msg.toolCalls?.length) {
            for (const tc of msg.toolCalls)
                open.add(tc.id);
        }
        else if (msg.type === 'tool') {
            open.delete(msg.toolCallId);
        }
    }
    if (carry.length > 0) {
        out.push({
            type: 'event',
            eventType: 'system_injection.fallback',
            content: carry.join('\n\n'),
            timestamp: new Date(),
        });
    }
    return out;
}
