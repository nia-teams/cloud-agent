import { randomBytes } from 'node:crypto';
import type { AgentMessage, AssistantMessage, SubagentStore, SubagentRunDoc, ActiveSubagentTurn, } from '../types.js';
import type { DocStore } from './types.js';
import { COL_SESSIONS, COL_SUBAGENT_RUNS } from './schema.js';
interface SubagentRunRow extends Record<string, unknown> {
    _id: string | {
        toHexString(): string;
    };
    sessionId: string | {
        toHexString(): string;
    };
    parentTurnId: string;
    toolCallId: string;
    profileName: string;
    profileVariant?: string;
    task: string;
    messages: AgentMessage[];
    status: 'running' | 'complete' | 'cancelled' | 'error';
    resumedFrom?: string;
    createdAt: Date;
    updatedAt: Date;
    lastBlock?: {
        type: 'tool_call';
        name: string;
        description?: string;
    };
    lastError?: {
        code: string;
        message: string;
        detail?: string;
    };
    replayThroughSeq?: number;
}
interface SessionActiveSubagentTurnDoc extends Record<string, unknown> {
    activeSubagentTurn?: ActiveSubagentTurn;
}
export function createDocStoreSubagentStore(docStore: DocStore): SubagentStore {
    return {
        async insertRun(input) {
            const now = new Date();
            const subagentOid = randomBytes(12).toString('hex');
            const sessionOid = input.sessionId;
            const doc: SubagentRunRow = {
                _id: subagentOid,
                sessionId: sessionOid,
                parentTurnId: input.parentTurnId,
                toolCallId: input.toolCallId,
                profileName: input.profileName,
                ...(input.profileVariant ? { profileVariant: input.profileVariant } : {}),
                task: input.task,
                messages: [...input.initialMessages],
                status: 'running',
                createdAt: now,
                updatedAt: now,
                ...(input.resumedFrom ? { resumedFrom: input.resumedFrom } : {}),
            };
            await docStore.insertOne<SubagentRunRow>(COL_SUBAGENT_RUNS, doc);
            const claim = await docStore.updateOne(COL_SESSIONS, { _id: input.sessionId, activeSubagentTurn: { $exists: false } }, {
                $set: {
                    activeSubagentTurn: {
                        parentTurnId: input.parentTurnId,
                        parentAssistantSnapshot: input.parentAssistantSnapshot,
                        runIds: [subagentOid],
                    },
                },
            });
            if (claim.modifiedCount === 0) {
                await docStore.updateOne(COL_SESSIONS, { _id: input.sessionId }, { $addToSet: { 'activeSubagentTurn.runIds': subagentOid } });
            }
            return { subagentId: subagentOid };
        },
        async appendMessages(subagentId, msgs, replayThroughSeq) {
            if (msgs.length === 0)
                return;
            await docStore.updateOne(COL_SUBAGENT_RUNS, { _id: subagentId }, {
                $push: { messages: { $each: msgs } },
                $set: {
                    updatedAt: new Date(),
                    ...(replayThroughSeq !== undefined ? { replayThroughSeq } : {}),
                },
            });
        },
        async findByToolCallId(sessionId, toolCallId) {
            const row = await docStore.findOne<SubagentRunRow>(COL_SUBAGENT_RUNS, { sessionId: sessionId, toolCallId });
            if (!row)
                return null;
            return toRunDoc(row);
        },
        async finalize(input) {
            const now = new Date();
            const subagentOid = input.subagentId;
            const setFields: Record<string, unknown> = {
                status: input.status,
                updatedAt: now,
            };
            if (input.lastError) {
                setFields.lastError = input.lastError;
            }
            await docStore.updateOne(COL_SUBAGENT_RUNS, { _id: subagentOid }, { $set: setFields });
            await docStore.updateOne(COL_SESSIONS, { _id: input.sessionId }, { $pull: { 'activeSubagentTurn.runIds': subagentOid } });
            await docStore.updateOne(COL_SESSIONS, {
                _id: input.sessionId,
                'activeSubagentTurn.runIds': { $size: 0 },
            }, { $unset: { activeSubagentTurn: '' } });
        },
        async readActiveSubagentTurn(sessionId) {
            const doc = await docStore.findOne<SessionActiveSubagentTurnDoc>(COL_SESSIONS, { _id: sessionId }, { projection: { activeSubagentTurn: 1 } });
            return doc?.activeSubagentTurn ?? null;
        },
        async updateLastBlock(subagentId, lastBlock) {
            await docStore.updateOne(COL_SUBAGENT_RUNS, { _id: subagentId }, { $set: { lastBlock, updatedAt: new Date() } });
        },
    };
}
function toRunDoc(row: SubagentRunRow): SubagentRunDoc {
    return {
        subagentId: typeof row._id === 'string' ? row._id : row._id.toHexString(),
        sessionId: typeof row.sessionId === 'string' ? row.sessionId : row.sessionId.toHexString(),
        parentTurnId: row.parentTurnId,
        toolCallId: row.toolCallId,
        profileName: row.profileName,
        ...(row.profileVariant ? { profileVariant: row.profileVariant } : {}),
        task: row.task,
        messages: row.messages,
        status: row.status,
        ...(row.resumedFrom ? { resumedFrom: row.resumedFrom } : {}),
    };
}
export const SUBAGENT_CANCEL_CHANNEL_PREFIX = 'subagent-cancel:';
