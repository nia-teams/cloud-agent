import type { AgentMessage } from '../types.js';
import { hasPendingInputs } from './pending-inputs.js';
import { COL_SESSIONS } from './schema.js';
import type { DocStore } from './types.js';
export function isSessionSettled(tail: {
    type: AgentMessage['type'];
    toolCalls?: readonly unknown[] | null;
} | undefined, hasPending: boolean): boolean {
    if (hasPending)
        return false;
    if (!tail)
        return true;
    if (tail.type !== 'assistant')
        return false;
    if (tail.toolCalls && tail.toolCalls.length > 0)
        return false;
    return true;
}
export async function shouldRunTurn(store: DocStore, sessionId: string): Promise<boolean> {
    if (await hasPendingInputs(store, sessionId))
        return true;
    const doc = await store.findOne<{
        messages?: AgentMessage[];
    }>(COL_SESSIONS, { _id: sessionId }, { projection: { messages: 1 } as Record<string, 1> });
    const msgs = doc?.messages;
    const tail = msgs && msgs.length > 0 ? msgs[msgs.length - 1] : undefined;
    return !isSessionSettled(tail, false);
}
export function findOrphanSlicePoint(msgs: AgentMessage[]): number {
    let lastAssistantIdx = -1;
    let declaredToolIds = new Set<string>();
    const consumedToolIds = new Set<string>();
    for (let i = 0; i < msgs.length; i++) {
        const m = msgs[i];
        if (m.type === 'assistant') {
            if (lastAssistantIdx >= 0 && declaredToolIds.size > 0) {
                for (const id of declaredToolIds) {
                    if (!consumedToolIds.has(id)) {
                        return lastAssistantIdx;
                    }
                }
            }
            lastAssistantIdx = i;
            declaredToolIds = new Set(m.toolCalls?.map((tc) => tc.id) ?? []);
            consumedToolIds.clear();
            continue;
        }
        if (m.type === 'tool') {
            if (!declaredToolIds.has(m.toolCallId)) {
                return lastAssistantIdx >= 0 ? lastAssistantIdx : i;
            }
            consumedToolIds.add(m.toolCallId);
            continue;
        }
    }
    if (lastAssistantIdx >= 0 && declaredToolIds.size > 0) {
        for (const id of declaredToolIds) {
            if (!consumedToolIds.has(id))
                return lastAssistantIdx;
        }
    }
    return -1;
}
export function sanitizeOrphanToolCalls(messages: AgentMessage[]): AgentMessage[] {
    const index = findOrphanSlicePoint(messages);
    if (index < 0)
        return messages;
    let suffixStart = messages.length;
    while (suffixStart > index) {
        const message = messages[suffixStart - 1];
        if (message.type !== 'event' && message.type !== 'system_injection')
            break;
        suffixStart--;
    }
    return [...messages.slice(0, index), ...messages.slice(suffixStart)];
}
