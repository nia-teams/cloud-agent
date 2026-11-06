import type { ConversationStore, AgentMessage } from '../types.js';
import type { DocStore, PendingInput } from './types.js';
import { holderFilter } from './lock.js';
import { pendingToAgentMessage } from './pending-inputs.js';
import { COL_SESSIONS } from './schema.js';
export interface CreateConversationStoreOpts {
    store: DocStore;
    sessionId: string;
    holder: string;
    renewTtlMs: number;
    onLockLost: () => void;
    getDraining?: () => boolean;
}
export function createConversationStore(opts: CreateConversationStoreOpts): ConversationStore {
    const { store, sessionId, holder, renewTtlMs, onLockLost, getDraining } = opts;
    return {
        async loadAll(): Promise<AgentMessage[]> {
            const doc = await store.findOne<{
                messages?: AgentMessage[];
            }>(COL_SESSIONS, { _id: sessionId }, { projection: { messages: 1 } as Record<string, 1> });
            return doc?.messages ?? [];
        },
        async fetchNew(): Promise<AgentMessage[]> {
            while (!getDraining?.()) {
                const doc = await store.findOne<{
                    pendingInputs?: PendingInput[];
                    activeRun?: {
                        holder: string;
                    } | null;
                }>(COL_SESSIONS, { _id: sessionId }, { projection: { pendingInputs: 1, activeRun: 1 } as Record<string, 1> });
                if (doc === null)
                    return [];
                if (doc.activeRun?.holder !== holder) {
                    onLockLost();
                    return [];
                }
                const batch = doc.pendingInputs ?? [];
                if (batch.length === 0)
                    return [];
                const messages = batch.map(pendingToAgentMessage);
                const result = await store.updateOne(COL_SESSIONS, { ...holderFilter(sessionId, holder), pendingInputs: batch }, {
                    $push: { messages: { $each: messages } as unknown as AgentMessage },
                    $set: {
                        pendingInputs: [],
                        'activeRun.expiresAt': new Date(Date.now() + renewTtlMs),
                        updatedAt: new Date(),
                    },
                });
                if (result.modifiedCount === 1)
                    return messages;
            }
            return [];
        },
        async hasNew(): Promise<boolean> {
            if (getDraining?.())
                return false;
            const doc = await store.findOne(COL_SESSIONS, { _id: sessionId, 'pendingInputs.0': { $exists: true } }, { projection: { _id: 1 } as Record<string, 1> });
            return doc != null;
        },
        async persist(messages: AgentMessage[]): Promise<void> {
            if (messages.length === 0)
                return;
            const expiresAt = new Date(Date.now() + renewTtlMs);
            const result = await store.updateOne(COL_SESSIONS, holderFilter(sessionId, holder), {
                $push: { messages: { $each: messages } as unknown as AgentMessage },
                $set: { 'activeRun.expiresAt': expiresAt, updatedAt: new Date() },
            });
            if (result.modifiedCount !== 1) {
                onLockLost();
                throw new Error('Conversation lock lost during persist');
            }
        },
    };
}
