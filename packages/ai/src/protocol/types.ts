export type AiPostContext = string | {
    kind: 'text';
    text: string;
} | {
    kind: 'tool_loop_warning';
    warningType: string;
    toolName: string;
    count: number;
    message?: string;
};
export interface ToolExecutionResult {
    content: string;
    guidance?: AiPostContext[];
}
export interface EventMessage {
    type: 'event';
    eventType: string;
    content: string;
    context?: AiPostContext[];
    attachments?: Array<{
        type: 'image' | 'document';
        mediaType: string;
        data: string;
    }>;
    meta?: Record<string, unknown>;
    timestamp: Date;
}
export interface AssistantMessage {
    type: 'assistant';
    content: string | null;
    toolCalls?: ToolCallRecord[];
    reasoning?: string;
    reasoningSignature?: string;
    reasoningDetails?: unknown[];
    model?: string;
    turnId?: string;
    timestamp: Date;
    stopReason?: 'end_turn' | 'tool_use' | 'max_tokens' | 'error' | 'refusal';
    usedFallbackModel?: string;
}
export interface ToolMessage {
    type: 'tool';
    toolCallId: string;
    content: string;
    guidance?: AiPostContext[];
    isError?: boolean;
    lazy?: boolean;
    turnId?: string;
    timestamp: Date;
}
export type SystemInjectionBlock = {
    type: 'text';
    text: string;
} | {
    type: 'tool_addition';
    toolName: string;
} | {
    type: 'tool_removal';
    toolName: string;
};
export interface SystemInjectionMessage {
    type: 'system_injection';
    content?: string;
    blocks?: SystemInjectionBlock[];
    kind: 'reminder' | 'tool_activation' | 'guardrail' | 'state_change';
    turnId?: string;
    timestamp: Date;
}
export type AgentMessage = EventMessage | AssistantMessage | ToolMessage | SystemInjectionMessage;
export interface ToolCallRecord {
    id: string;
    name: string;
    arguments: string;
    malformedError?: string;
}
export interface ToolDefinition {
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
    deferLoading?: boolean;
}
export interface StreamDelta {
    type: 'thinking' | 'text' | 'tool_use' | 'tool_input_start' | 'tool_input_delta';
    content: string;
    toolCallId?: string;
    toolName?: string;
    partialJson?: string;
}
export type ReasoningEffort = 'none' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export interface LLMChatRequest<TMessage = AgentMessage> {
    messages: TMessage[];
    tools?: ToolDefinition[];
    systemPrompt?: string;
    enableThinking?: boolean;
    thinkingBudget?: number;
    thinkingType?: 'enabled' | 'adaptive';
    effort?: ReasoningEffort;
    maxTokens?: number;
    onStreamDelta?: (delta: StreamDelta) => void;
    signal?: AbortSignal;
}
export interface ChatDefaults {
    enableThinking?: boolean;
    thinkingBudget?: number;
    thinkingType?: 'enabled' | 'adaptive';
    maxOutputTokens?: number;
    effort?: ReasoningEffort;
}
export interface LLMToolCall {
    id: string;
    name: string;
    arguments: string;
    malformedError?: string;
}
export interface LLMChatResponse {
    content: string | null;
    toolCalls?: LLMToolCall[];
    reasoning?: string;
    reasoningSignature?: string;
    reasoningDetails?: unknown[];
    stopReason: 'end_turn' | 'tool_use' | 'max_tokens' | 'error' | 'refusal';
    usage?: {
        promptTokens: number;
        contextTokens?: number;
        completionTokens: number;
        reasoningTokens?: number;
        cachedTokens?: number;
        cacheCreationTokens?: number;
        usdCost?: number;
    };
    upstreamRequestId?: string | null;
    upstreamCompletionId?: string | null;
    timings?: {
        ttftMs: number;
        generateMs: number;
        outputTokensPerSec?: number;
    };
    usedFallbackModel?: string;
}
export interface ILLMClient<TMessage = AgentMessage> {
    chat(request: LLMChatRequest<TMessage>): Promise<LLMChatResponse>;
    getProviderName(): string;
    getModelName(): string;
}
