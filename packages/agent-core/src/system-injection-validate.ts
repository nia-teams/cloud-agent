import type { AgentMessage } from './types.js';
export type SystemInjectionPlacementError = 'first_message' | 'not_after_user_or_tool_result' | 'mid_batch_tool_result';
function findOpenToolCallIds(messages: readonly AgentMessage[]): Set<string> {
    const open = new Set<string>();
    for (const msg of messages) {
        if (msg.type === 'assistant' && msg.toolCalls?.length) {
            for (const tc of msg.toolCalls)
                open.add(tc.id);
        }
        else if (msg.type === 'tool') {
            open.delete(msg.toolCallId);
        }
    }
    return open;
}
export interface SystemInjectionPlacementResult {
    ok: boolean;
    error?: SystemInjectionPlacementError;
    message?: string;
}
export function validateSystemInjectionPlacement(existingMessages: readonly AgentMessage[]): SystemInjectionPlacementResult {
    if (existingMessages.length === 0) {
        return {
            ok: false,
            error: 'first_message',
            message: 'SystemInjection cannot be the first message in a session — there must be at least one prior event/tool/assistant message to anchor it to.',
        };
    }
    const tail = existingMessages[existingMessages.length - 1];
    if (tail.type !== 'event' && tail.type !== 'tool') {
        return {
            ok: false,
            error: 'not_after_user_or_tool_result',
            message: `SystemInjection must immediately follow a user message (type:'event') or a tool result (type:'tool') — tail message is type:'${tail.type}'.`,
        };
    }
    if (tail.type === 'tool') {
        const openIds = findOpenToolCallIds(existingMessages);
        if (openIds.size > 0) {
            return {
                ok: false,
                error: 'mid_batch_tool_result',
                message: `SystemInjection cannot be written right after tool_use '${tail.toolCallId}' — its batch still has ${openIds.size} sibling tool_use id(s) awaiting a result (${[...openIds].join(', ')}). Wait until the whole parallel batch closes before injecting.`,
            };
        }
    }
    return { ok: true };
}
