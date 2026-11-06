export interface BaseEvent {
    turnId?: string;
    subagentToolCallId?: string;
    type: string;
    sessionId: string;
    timestamp: number;
}
export interface TurnEvent extends BaseEvent {
    turnId: string;
    subagentToolCallId?: string;
}
export interface TurnStartEvent extends TurnEvent {
    type: 'turn_start';
}
export interface ThinkingStartEvent extends TurnEvent {
    type: 'thinking_start';
}
export interface ThinkingDeltaEvent extends TurnEvent {
    type: 'thinking_delta';
    delta: string;
}
export interface ThinkingEndEvent extends TurnEvent {
    type: 'thinking_end';
}
export interface TextDeltaEvent extends TurnEvent {
    type: 'text_delta';
    delta: string;
}
export interface ToolInputStartEvent extends TurnEvent {
    type: 'tool_input_start';
    toolCallId: string;
    name: string;
}
export interface ToolCallStartEvent extends TurnEvent {
    type: 'tool_call_start';
    toolCallId: string;
    name: string;
    input: Record<string, unknown>;
}
export interface ToolInputDeltaEvent extends TurnEvent {
    type: 'tool_input_delta';
    toolCallId: string;
    partial_json: string;
}
export interface ToolCallEndEvent extends TurnEvent {
    type: 'tool_call_end';
    toolCallId: string;
    output?: string;
    error?: string;
    durationMs: number;
}
export interface TurnEndEvent extends TurnEvent {
    type: 'turn_end';
    inputTokens?: number;
    model?: string;
}
export interface UsageUpdateEvent extends TurnEvent {
    type: 'usage_update';
    inputTokens: number;
}
export interface UserMessageEvent extends BaseEvent {
    type: 'user_message';
    userId: string;
    userName: string;
    avatarUrl?: string;
    bio?: string;
    messageId: string;
    content: string;
    eventSource?: string;
    attachments?: Array<{
        url: string;
        name: string;
        mimeType: string;
        size: number;
    }>;
    metadata?: Record<string, unknown>;
}
export interface TurnErrorEvent extends TurnEvent {
    type: 'error';
    code: string;
    message: string;
    detail?: string;
}
export type ErrorEvent = TurnErrorEvent;
export interface SessionUpdateEvent extends BaseEvent {
    type: 'session_update';
    private?: boolean;
    lastMessage?: string;
    lastMessageUser?: string;
    title?: string | null;
    running?: boolean;
    backgroundTaskCount?: number;
    lastError?: null | {
        turnId: string;
        code: string;
        message: string;
        detail?: string;
        timestamp: number;
    };
}
export interface InterleaveStartEvent extends TurnEvent {
    type: 'interleave_start';
    messageIds?: string[];
}
export interface MessagesConsumedEvent extends BaseEvent {
    type: 'messages_consumed';
    messageIds: string[];
}
export interface MessageRevokedEvent extends BaseEvent {
    type: 'message_revoked';
    messageId: string;
    revokedBy: string;
}
export interface CustomAgentEvent extends BaseEvent {
    type: 'custom';
    name: string;
    data?: unknown;
}
export type StreamEvent = CustomAgentEvent | TurnStartEvent | ThinkingStartEvent | ThinkingDeltaEvent | ThinkingEndEvent | TextDeltaEvent | ToolInputStartEvent | ToolInputDeltaEvent | ToolCallStartEvent | ToolCallEndEvent | TurnEndEvent | UsageUpdateEvent | UserMessageEvent | TurnErrorEvent | SessionUpdateEvent | InterleaveStartEvent | MessagesConsumedEvent | MessageRevokedEvent;
export interface StreamSnapshot {
    type: 'snapshot';
    user?: Record<string, unknown>;
    team?: Record<string, unknown>;
    session: {
        _id: string;
        teamId?: string;
        title?: string | null;
        messages?: Array<Record<string, unknown>>;
        userProfiles?: Record<string, {
            name: string;
            avatarUrl?: string;
            bio?: string;
        }>;
        [key: string]: unknown;
    };
    extras?: Record<string, unknown>;
}
