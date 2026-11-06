import type { TurnStartEvent, ThinkingStartEvent, ThinkingDeltaEvent, ThinkingEndEvent, TextDeltaEvent, ToolInputStartEvent, ToolInputDeltaEvent, ToolCallStartEvent, ToolCallEndEvent, TurnEndEvent, UsageUpdateEvent, UserMessageEvent, TurnErrorEvent, SessionUpdateEvent, InterleaveStartEvent, MessagesConsumedEvent, MessageRevokedEvent, } from './events.js';
interface TurnHeader {
    sessionId: string;
    turnId: string;
    subagentToolCallId?: string;
    timestamp?: number;
}
interface SessionHeader {
    sessionId: string;
    timestamp?: number;
}
const ts = (t?: number) => t ?? Date.now();
export function buildTurnStart(h: TurnHeader): TurnStartEvent {
    return {
        type: 'turn_start',
        sessionId: h.sessionId,
        turnId: h.turnId,
        subagentToolCallId: h.subagentToolCallId,
        timestamp: ts(h.timestamp),
    };
}
export function buildThinkingStart(h: TurnHeader): ThinkingStartEvent {
    return {
        type: 'thinking_start',
        sessionId: h.sessionId,
        turnId: h.turnId,
        subagentToolCallId: h.subagentToolCallId,
        timestamp: ts(h.timestamp),
    };
}
export function buildThinkingDelta(h: TurnHeader & {
    delta: string;
}): ThinkingDeltaEvent {
    return {
        type: 'thinking_delta',
        sessionId: h.sessionId,
        turnId: h.turnId,
        subagentToolCallId: h.subagentToolCallId,
        delta: h.delta,
        timestamp: ts(h.timestamp),
    };
}
export function buildThinkingEnd(h: TurnHeader): ThinkingEndEvent {
    return {
        type: 'thinking_end',
        sessionId: h.sessionId,
        turnId: h.turnId,
        subagentToolCallId: h.subagentToolCallId,
        timestamp: ts(h.timestamp),
    };
}
export function buildTextDelta(h: TurnHeader & {
    delta: string;
}): TextDeltaEvent {
    return {
        type: 'text_delta',
        sessionId: h.sessionId,
        turnId: h.turnId,
        subagentToolCallId: h.subagentToolCallId,
        delta: h.delta,
        timestamp: ts(h.timestamp),
    };
}
export function buildToolInputStart(h: TurnHeader & {
    toolCallId: string;
    name: string;
}): ToolInputStartEvent {
    return {
        type: 'tool_input_start',
        sessionId: h.sessionId,
        turnId: h.turnId,
        subagentToolCallId: h.subagentToolCallId,
        toolCallId: h.toolCallId,
        name: h.name,
        timestamp: ts(h.timestamp),
    };
}
export function buildToolInputDelta(h: TurnHeader & {
    toolCallId: string;
    partial_json: string;
}): ToolInputDeltaEvent {
    return {
        type: 'tool_input_delta',
        sessionId: h.sessionId,
        turnId: h.turnId,
        subagentToolCallId: h.subagentToolCallId,
        toolCallId: h.toolCallId,
        partial_json: h.partial_json,
        timestamp: ts(h.timestamp),
    };
}
export function buildToolCallStart(h: TurnHeader & {
    toolCallId: string;
    name: string;
    input: Record<string, unknown>;
}): ToolCallStartEvent {
    return {
        type: 'tool_call_start',
        sessionId: h.sessionId,
        turnId: h.turnId,
        subagentToolCallId: h.subagentToolCallId,
        toolCallId: h.toolCallId,
        name: h.name,
        input: h.input,
        timestamp: ts(h.timestamp),
    };
}
export function buildToolCallEnd(h: TurnHeader & {
    toolCallId: string;
    durationMs: number;
    output?: string;
    error?: string;
}): ToolCallEndEvent {
    return {
        type: 'tool_call_end',
        sessionId: h.sessionId,
        turnId: h.turnId,
        subagentToolCallId: h.subagentToolCallId,
        toolCallId: h.toolCallId,
        durationMs: h.durationMs,
        output: h.output,
        error: h.error,
        timestamp: ts(h.timestamp),
    };
}
export function buildTurnEnd(h: TurnHeader & {
    model?: string;
    inputTokens?: number;
}): TurnEndEvent {
    return {
        type: 'turn_end',
        sessionId: h.sessionId,
        turnId: h.turnId,
        subagentToolCallId: h.subagentToolCallId,
        model: h.model,
        inputTokens: h.inputTokens,
        timestamp: ts(h.timestamp),
    };
}
export function buildUsageUpdate(h: TurnHeader & {
    inputTokens: number;
}): UsageUpdateEvent {
    return {
        type: 'usage_update',
        sessionId: h.sessionId,
        turnId: h.turnId,
        subagentToolCallId: h.subagentToolCallId,
        inputTokens: h.inputTokens,
        timestamp: ts(h.timestamp),
    };
}
export interface BuildUserMessageInput extends SessionHeader {
    userId: string;
    userName: string;
    messageId: string;
    content: string;
    avatarUrl?: string;
    bio?: string;
    eventSource?: string;
    attachments?: UserMessageEvent['attachments'];
    metadata?: Record<string, unknown>;
}
export function buildUserMessage(h: BuildUserMessageInput): UserMessageEvent {
    return {
        type: 'user_message',
        sessionId: h.sessionId,
        timestamp: ts(h.timestamp),
        userId: h.userId,
        userName: h.userName,
        avatarUrl: h.avatarUrl,
        bio: h.bio,
        messageId: h.messageId,
        content: h.content,
        eventSource: h.eventSource,
        attachments: h.attachments,
        metadata: h.metadata,
    };
}
export function buildTurnError(h: TurnHeader & {
    code: string;
    message: string;
    detail?: string;
}): TurnErrorEvent {
    return {
        type: 'error',
        sessionId: h.sessionId,
        turnId: h.turnId,
        subagentToolCallId: h.subagentToolCallId,
        code: h.code,
        message: h.message,
        detail: h.detail,
        timestamp: ts(h.timestamp),
    };
}
export interface BuildSessionUpdateInput extends SessionHeader {
    title?: string | null;
    running?: boolean;
    backgroundTaskCount?: number;
    lastError?: SessionUpdateEvent['lastError'];
    private?: boolean;
    lastMessage?: string;
    lastMessageUser?: string;
}
export function buildSessionUpdate(h: BuildSessionUpdateInput): SessionUpdateEvent {
    return {
        type: 'session_update',
        sessionId: h.sessionId,
        timestamp: ts(h.timestamp),
        title: h.title,
        running: h.running,
        backgroundTaskCount: h.backgroundTaskCount,
        lastError: h.lastError,
        private: h.private,
        lastMessage: h.lastMessage,
        lastMessageUser: h.lastMessageUser,
    };
}
export function buildInterleaveStart(h: TurnHeader & {
    messageIds?: string[];
}): InterleaveStartEvent {
    return {
        type: 'interleave_start',
        sessionId: h.sessionId,
        turnId: h.turnId,
        subagentToolCallId: h.subagentToolCallId,
        messageIds: h.messageIds,
        timestamp: ts(h.timestamp),
    };
}
export function buildMessagesConsumed(h: SessionHeader & {
    messageIds: string[];
}): MessagesConsumedEvent {
    return {
        type: 'messages_consumed',
        sessionId: h.sessionId,
        timestamp: ts(h.timestamp),
        messageIds: h.messageIds,
    };
}
export function buildMessageRevoked(h: SessionHeader & {
    messageId: string;
    revokedBy: string;
}): MessageRevokedEvent {
    return {
        type: 'message_revoked',
        sessionId: h.sessionId,
        timestamp: ts(h.timestamp),
        messageId: h.messageId,
        revokedBy: h.revokedBy,
    };
}
