import type { ILLMClient, AgentMessage, AssistantMessage, ToolMessage, EventMessage, SystemInjectionMessage, SystemInjectionBlock, LLMChatRequest, LLMChatResponse, LLMToolCall, ToolDefinition, AiPostContext, ToolExecutionResult, } from '@nia-teams/ai/protocol';
import type { StreamEvent } from './protocol/events.js';
export type { AgentMessage, AssistantMessage, ToolMessage, EventMessage, SystemInjectionMessage, SystemInjectionBlock, LLMChatRequest, LLMChatResponse, LLMToolCall, ILLMClient, ToolDefinition, AiPostContext, ToolExecutionResult, };
export interface ConversationStore {
    loadAll(): Promise<AgentMessage[]>;
    fetchNew(): Promise<AgentMessage[]>;
    hasNew(): Promise<boolean>;
    persist(messages: AgentMessage[]): Promise<void>;
}
export interface ToolContext {
    executeSubagent?: (input: Record<string, unknown>) => ReturnType<Tool['execute']>;
    metadata: Record<string, unknown>;
    sessionId: string;
    turnId: string;
    toolCallId?: string;
    aiPostContext?: AiPostContext[];
    signal: AbortSignal;
    onEvent: (event: ToolEvent) => void;
    isDraining?: () => boolean;
    parentAssistantSnapshot?: AssistantMessage;
    activateTools?: (names: string[]) => void;
}
export interface Tool {
    concurrency?: 'parallel' | 'serial' | 'deferred';
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
    deferLoading?: boolean;
    execute(input: Record<string, unknown>, ctx: ToolContext): Promise<string | ToolExecutionResult>;
}
export type AgentEvent = StreamEvent;
export type ToolEvent = StreamEvent extends infer E ? E extends StreamEvent ? Omit<E, 'sessionId' | 'turnId' | 'timestamp'> : never : never;
export type AgentRuntimeRunOptions = RunOptions;
export interface Logger {
    debug: (obj: unknown, msg?: string) => void;
    info: (obj: unknown, msg?: string) => void;
    warn: (obj: unknown, msg?: string) => void;
    error: (obj: unknown, msg?: string) => void;
}
export const NOOP_LOGGER: Logger = {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
};
export type ExitState = {
    kind: 'done';
} | {
    kind: 'skip';
} | {
    kind: 'aborted';
} | {
    kind: 'error';
    error: Error;
};
export type ExitKind = ExitState['kind'];
export interface RuntimeState {
    readonly messages: readonly AgentMessage[];
    pending: AgentMessage[];
    systemPrompt: string;
    tools: Tool[];
    exit?: ExitState;
    metadata: Record<string, unknown>;
    readonly sessionId: string;
    readonly turnId: string;
    readonly loopIteration: number;
    readonly numLLMCalls: number;
    readonly newMessages: readonly AgentMessage[];
}
export interface AgentHooks {
    beforeTurn?: (state: RuntimeState) => void | Promise<void>;
    afterFetch?: (state: RuntimeState) => void | Promise<void>;
    afterLLM?: (state: RuntimeState) => void | Promise<void>;
    beforeExecTools?: (state: RuntimeState) => void | Promise<void>;
    afterExecTools?: (state: RuntimeState) => void | Promise<void>;
    afterPersist?: (state: RuntimeState) => void | Promise<void>;
    afterAssistantPersist?: (state: RuntimeState, msg: AssistantMessage) => void | Promise<void>;
    afterTurn?: (state: RuntimeState) => void | Promise<void>;
}
export type HookSlot = keyof AgentHooks;
export interface UsageEntry {
    keyId: string;
    sessionId: string;
    turnId: string;
    numLLMCalls: number;
    inputTokens: number;
    lastInputTokens: number;
    outputTokens: number;
    cachedTokens: number;
    cacheCreationTokens: number;
    reasoningTokens: number;
    usdCost: number;
    durationMs: number;
    exitKind: ExitKind;
    errorMessage?: string;
}
export interface UsageRecorder {
    record(entry: UsageEntry): Promise<void>;
}
export interface RuntimePluginContext {
    sessionId: string;
    turnId: string;
    logger: Logger;
}
export interface RuntimeToolCall {
    toolCallId: string;
    toolName: string;
    args: Record<string, unknown>;
}
export interface RuntimeToolResult extends ToolExecutionResult {
    isError?: boolean;
}
export interface RuntimePluginHooks {
    transformContext?: (ctx: {
        messages: readonly AgentMessage[];
        state: RuntimeState;
        model: string;
        contextWindow?: number;
    }) => readonly AgentMessage[] | Promise<readonly AgentMessage[]>;
    beforeToolCall?: (ctx: RuntimeToolCall) => RuntimeToolResult | void | Promise<RuntimeToolResult | void>;
    afterToolCall?: (ctx: RuntimeToolCall & {
        message: ToolMessage;
    }) => void | Promise<void>;
    afterToolBatch?: (state: RuntimeState) => void | Promise<void>;
}
export interface RuntimePlugin {
    name: string;
    create: (ctx: RuntimePluginContext) => RuntimePluginHooks;
    forSubagent?: () => RuntimePlugin | undefined;
}
export interface AgentRuntimeConfig {
    interleavePlaceholder?: string;
    store: ConversationStore;
    sessionId: string;
    usage?: UsageRecorder;
    plugins?: readonly RuntimePlugin[];
    maxLoopIterations?: number;
    llmCallTimeoutMs?: number;
    llmIdleTimeoutMs?: number;
    formatMessagesForLLM?: ((messages: AgentMessage[]) => Promise<AgentMessage[]>) | Array<(messages: AgentMessage[]) => Promise<AgentMessage[]>>;
    prefetchHook?: (sessionId: string) => Promise<void>;
    isDraining?: () => boolean;
    logger?: Logger;
}
export interface RunOptions {
    turnId?: string;
    client: ILLMClient;
    systemPrompt: string;
    tools: Tool[];
    contextWindow?: number;
    resolveToolDefinitions?: (names: string[]) => Tool[] | Promise<Tool[]>;
    keyId?: string;
    hooks?: AgentHooks | AgentHooks[];
    onEvent?: (event: AgentEvent) => void;
    abortSignal?: AbortSignal;
    metadata?: Record<string, unknown>;
    subagent?: {
        hostManagedTool?: boolean;
        profiles: SubagentProfile[];
        store: SubagentStore;
        subscribeCancel?: (handler: (toolCallId: string) => void) => Promise<() => Promise<void>>;
        publishChildEvent?: (toolCallId: string, event: AgentEvent) => void;
        checkpointChildEvents?: (toolCallId: string, turnId: string) => Promise<number | undefined>;
        inputOverride?: {
            resolveInput: (raw: {
                task: string;
                context?: string;
            }, ctx: ToolContext) => Promise<{
                task: string;
                context?: string;
            }>;
            taskDescription?: string;
            contextDescription?: string;
        };
        resultOverride?: (result: SubagentResultForFormat, ctx: ToolContext) => Promise<string>;
    };
}
export interface SubagentResultForFormat {
    status: 'complete' | 'error' | 'cancelled';
    content: string;
    toolCallId: string;
    mode: string;
    lastError?: {
        code: string;
        message: string;
        detail?: string;
    };
}
export interface SubagentUsageContext {
    sessionId: string;
    toolCallId: string;
    subagentId: string;
    parentTurnId: string;
    profileName: string;
}
export interface SubagentProfile {
    name: string;
    description: string;
    rolePrompt: string;
    tools: Tool[];
    client: ILLMClient;
    createUsageRecorder?: (context: SubagentUsageContext) => UsageRecorder;
    maxTurns?: number;
    resolveToolDefinitions?: (names: string[]) => Tool[] | Promise<Tool[]>;
    contextWindow?: number;
    deferredToolNames?: string[];
    modelTier?: string;
    profileVariant?: string;
    resolveVariant?: (context: SubagentProfileVariantContext) => SubagentProfile | Promise<SubagentProfile>;
}
export interface SubagentProfileVariantContext {
    sessionId: string;
    toolCallId: string;
    task: string;
    context?: string;
    resumeSource: 'fresh' | 'recovery' | 'explicit-resume';
    existingRunDoc?: SubagentRunDoc;
}
export interface SubagentRunDoc {
    subagentId: string;
    sessionId: string;
    parentTurnId: string;
    toolCallId: string;
    profileName: string;
    profileVariant?: string;
    task: string;
    messages: AgentMessage[];
    status: 'running' | 'complete' | 'cancelled' | 'error';
    resumedFrom?: string;
}
export interface ActiveSubagentTurn {
    parentTurnId: string;
    parentAssistantSnapshot: AssistantMessage;
    runIds: Array<string | {
        toHexString(): string;
    }>;
}
export interface SubagentStore {
    insertRun(input: {
        sessionId: string;
        parentTurnId: string;
        parentAssistantSnapshot: AssistantMessage;
        toolCallId: string;
        profileName: string;
        profileVariant?: string;
        task: string;
        resumedFrom?: string;
        initialMessages: AgentMessage[];
    }): Promise<{
        subagentId: string;
    }>;
    appendMessages(subagentId: string, msgs: AgentMessage[], replayThroughSeq?: number): Promise<void>;
    findByToolCallId(sessionId: string, toolCallId: string): Promise<SubagentRunDoc | null>;
    finalize(input: {
        subagentId: string;
        sessionId: string;
        status: 'complete' | 'cancelled' | 'error';
        lastError?: {
            code: string;
            message: string;
            detail?: string;
        };
    }): Promise<void>;
    readActiveSubagentTurn(sessionId: string): Promise<ActiveSubagentTurn | null>;
    updateLastBlock(subagentId: string, lastBlock: {
        type: 'tool_call';
        name: string;
        description?: string;
    }): Promise<void>;
}
