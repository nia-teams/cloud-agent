import { nanoid } from 'nanoid';
import type { AgentMessage } from '../types.js';
import type { DocStore, InjectMessageOptions, InjectMessageResult, PendingInput } from './types.js';
import { holderFilter } from './lock.js';
import { COL_SESSIONS } from './schema.js';
export async function enqueueInput(store: DocStore, opts: InjectMessageOptions): Promise<InjectMessageResult> {
    const messageId = opts.messageId ?? nanoid();
    const timestamp = Date.now();
    const input: PendingInput = {
        id: messageId,
        content: opts.content,
        userId: opts.userId,
        userName: opts.userName,
        avatarUrl: opts.avatarUrl,
        bio: opts.bio,
        eventSource: opts.eventSource,
        attachments: opts.attachments,
        metadata: opts.metadata,
        eventType: opts.eventType,
        timestamp,
    };
    await store.updateOne(COL_SESSIONS, { _id: opts.sessionId }, {
        $push: { pendingInputs: input },
        $inc: { inputGeneration: 1 },
        $set: { updatedAt: new Date(), autoRetryAttempt: 0 },
        $unset: {
            runtimeWakeRequestedAt: '',
            runtimeWakeSessionFilter: '',
            runtimeWakeRequestId: '',
        },
        $setOnInsert: { createdAt: new Date() },
    }, { upsert: true });
    return { messageId, timestamp };
}
export async function drainPendingInputs(store: DocStore, opts: {
    sessionId: string;
    holder: string;
}): Promise<PendingInput[]> {
    const before = await store.findOneAndUpdate<{
        pendingInputs?: PendingInput[];
    }>(COL_SESSIONS, holderFilter(opts.sessionId, opts.holder), { $set: { pendingInputs: [] } }, { returnDocument: 'before', projection: { pendingInputs: 1 } as Record<string, 1> });
    return before?.pendingInputs ?? [];
}
export async function hasPendingInputs(store: DocStore, sessionId: string): Promise<boolean> {
    const doc = await store.findOne(COL_SESSIONS, { _id: sessionId, 'pendingInputs.0': { $exists: true } }, { projection: { _id: 1 } as Record<string, 1> });
    return doc != null;
}
export const USER_MESSAGE_EVENT_TYPE = 'user_message';
export function pendingToAgentMessage(p: PendingInput): AgentMessage {
    const meta: Record<string, unknown> = {
        messageId: p.id,
        userId: p.userId,
        userName: p.userName,
    };
    if (p.avatarUrl !== undefined)
        meta.avatarUrl = p.avatarUrl;
    if (p.bio !== undefined)
        meta.bio = p.bio;
    if (p.eventSource !== undefined)
        meta.eventSource = p.eventSource;
    if (p.attachments !== undefined)
        meta.attachments = p.attachments;
    if (p.metadata)
        Object.assign(meta, p.metadata);
    const context = Array.isArray(meta.context) ? meta.context : undefined;
    if (context !== undefined)
        delete meta.context;
    return {
        type: 'event',
        eventType: p.eventType ?? USER_MESSAGE_EVENT_TYPE,
        content: p.content,
        ...(context ? { context } : {}),
        timestamp: new Date(p.timestamp ?? Date.now()),
        meta,
    };
}
