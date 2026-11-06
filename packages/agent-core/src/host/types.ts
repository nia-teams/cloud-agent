import type { SnapshotReply } from '../protocol/snapshot-stream.js';
import type { AgentMessage, AgentEvent, Tool, AgentHooks, ILLMClient, Logger, SubagentProfile, UsageRecorder, } from '../types.js';
import type { CronConfig, CronHandle, ScheduledTaskConfig, } from './cron/types.js';
export interface DocStore {
    insertOne<T extends Record<string, unknown>>(collection: string, doc: T): Promise<void>;
    updateOne(collection: string, filter: Record<string, unknown>, update: Record<string, unknown>, opts?: {
        upsert?: boolean;
    }): Promise<{
        matchedCount: number;
        modifiedCount: number;
        upserted: boolean;
    }>;
    findOne<T = Record<string, unknown>>(collection: string, filter: Record<string, unknown>, opts?: {
        projection?: Record<string, 0 | 1>;
    }): Promise<T | null>;
    find<T = Record<string, unknown>>(collection: string, filter: Record<string, unknown>, opts?: {
        projection?: Record<string, 0 | 1>;
        sort?: Record<string, 1 | -1>;
        limit?: number;
    }): Promise<T[]>;
    findOneAndUpdate<T = Record<string, unknown>>(collection: string, filter: Record<string, unknown>, update: Record<string, unknown>, opts?: {
        upsert?: boolean;
        returnDocument?: 'before' | 'after';
        projection?: Record<string, 0 | 1>;
    }): Promise<T | null>;
    deleteMany(collection: string, filter: Record<string, unknown>): Promise<{
        deletedCount: number;
    }>;
}
export interface PubSub {
    publish(channel: string, payload: string): Promise<void>;
    subscribe(channel: string, handler: (payload: string) => void): Promise<() => Promise<void>>;
    psubscribe(pattern: string, handler: (channel: string, payload: string) => void): Promise<() => Promise<void>>;
}
export interface PendingInput {
    id: string;
    content: string;
    userId: string;
    userName: string;
    avatarUrl?: string;
    bio?: string;
    eventSource?: string;
    attachments?: unknown[];
    context?: import('../protocol/llm-protocol.js').AiPostContext[];
    metadata?: Record<string, unknown>;
    eventType?: string;
    timestamp?: number;
}
export interface InjectMessageOptions extends Omit<PendingInput, 'id' | 'timestamp'> {
    sessionId: string;
    messageId?: string;
}
export interface InjectMessageResult {
    messageId: string;
    timestamp: number;
}
export interface OpenSnapshotStreamOptions {
    format?: 'ndjson' | 'sse';
    sessionId: string;
    buildSnapshot?: () => Promise<unknown> | unknown;
    extraHeaders?: Record<string, string>;
    onSnapshotComplete?: (stats: {
        rawBytes: number;
        gzipBytes: number;
        snapshotMs: number;
    }) => Promise<void> | void;
    onClose?: () => Promise<void> | void;
}
export interface AgentConfig {
    client: ILLMClient;
    systemPrompt: string;
    tools: Tool[];
    resolveToolDefinitions?: (names: string[]) => Tool[] | Promise<Tool[]>;
    contextWindow?: number;
    keyId?: string;
    guardrailConfig?: import('../builtins/guardrail.js').GuardrailConfigOverride;
    hooks?: AgentHooks | AgentHooks[];
    formatMessagesForLLM?: ((messages: AgentMessage[]) => Promise<AgentMessage[]>) | Array<(messages: AgentMessage[]) => Promise<AgentMessage[]>>;
    usage?: UsageRecorder;
    largeToolResult?: import('../builtins/large-tool-result.js').LargeToolResultOptions;
    prefetchHook?: (sessionId: string) => Promise<void>;
    subagentProfiles?: SubagentProfile[];
    subagentHostManagedTool?: boolean;
    subagentInputOverride?: NonNullable<import('../types.js').RunOptions['subagent']>['inputOverride'];
    subagentResultOverride?: NonNullable<import('../types.js').RunOptions['subagent']>['resultOverride'];
}
export type ResolveAgentConfig = (sessionId: string) => Promise<AgentConfig> | AgentConfig;
export interface AgentHostConfig {
    docStore: DocStore;
    pubSub: PubSub;
    logger?: Logger;
    contextPruning?: boolean;
    resolveAgentConfig: ResolveAgentConfig;
    onEvent?: (event: {
        sessionId: string;
        turnId: string;
        event: AgentEvent;
    }) => void | Promise<void>;
    onTurnReleased?: (event: {
        sessionId: string;
        turnId: string;
        holder: string;
    }) => Promise<void> | void;
}
export interface InternalTimings {
    lockTtlMs: number;
    lockRenewMs: number;
    scanIntervalMs: number;
    drainTimeoutMs: number;
    maxLoopIterations: number;
    llmCallTimeoutMs: number;
    llmIdleTimeoutMs: number;
    preTurnStallMs: number;
    inTurnStallMs: number;
    channelPrefix: string;
    eventsTtlSeconds: number;
}
export const INTERNAL_TIMINGS: InternalTimings = {
    lockTtlMs: 60000,
    lockRenewMs: 20000,
    scanIntervalMs: 60000,
    drainTimeoutMs: 290000,
    maxLoopIterations: 200,
    llmCallTimeoutMs: 20 * 60000,
    llmIdleTimeoutMs: 5 * 60000,
    preTurnStallMs: 90000,
    inTurnStallMs: 25 * 60000,
    channelPrefix: '',
    eventsTtlSeconds: 86400,
};
export interface AgentHost {
    start(): Promise<void>;
    stop(): Promise<void>;
    injectMessage(opts: InjectMessageOptions): Promise<InjectMessageResult>;
    wakeUp(sessionId: string, opts?: {
        sessionFilter?: Record<string, unknown>;
    }): Promise<boolean>;
    openSnapshotStream(reply: SnapshotReply, opts: OpenSnapshotStreamOptions): Promise<void>;
    replayEvents(sessionId: string, sinceEventId: number): Promise<string[]>;
    getCurrentSeq(sessionId: string): Promise<number>;
    broadcastChannel(sessionId: string): string;
    subagentBroadcastChannel(sessionId: string, toolCallId: string): string;
    subagentEventStreamId(sessionId: string, toolCallId: string): string;
    publish(sessionId: string, payload: string): Promise<void>;
    subscribeBroadcast(sessionId: string, handler: (payload: string) => void): Promise<() => Promise<void>>;
    startCron<P = unknown>(config: CronConfig<P>): CronHandle;
    startScheduledTask(config: ScheduledTaskConfig): CronHandle;
}
