export const COL_SESSIONS = 'sessions';
export const COL_EVENTS = 'events';
export const COL_SUBAGENT_RUNS = 'subagent_runs';
export function eventSeqCounterId(sessionId: string): string {
    return `eventseq:${sessionId}`;
}
export function triggerChannel(prefix: string, sessionId: string): string {
    return `${prefix}trigger:session:${sessionId}`;
}
export function triggerPattern(prefix: string): string {
    return `${prefix}trigger:session:*`;
}
export function broadcastChannel(prefix: string, sessionId: string): string {
    return `${prefix}broadcast:session:${sessionId}`;
}
export function subagentEventStreamId(sessionId: string, toolCallId: string): string {
    return `subagent:${sessionId}:${toolCallId}`;
}
export function subagentBroadcastChannel(prefix: string, sessionId: string, toolCallId: string): string {
    return `${prefix}broadcast:subagent:${sessionId}:${toolCallId}`;
}
export const REQUIRED_INDEXES: Array<{
    collection: string;
    spec: Record<string, 1 | -1>;
    opts?: {
        unique?: boolean;
        ttlSeconds?: number;
        partialFilter?: Record<string, unknown>;
    };
}> = [
    {
        collection: COL_EVENTS,
        spec: { sessionId: 1, seq: 1 },
    },
    {
        collection: COL_EVENTS,
        spec: { sessionId: 1, turnId: 1 },
    },
    {
        collection: COL_EVENTS,
        spec: { createdAt: 1 },
        opts: { ttlSeconds: 86400 },
    },
    {
        collection: COL_SESSIONS,
        spec: { 'pendingInputs.0': 1 },
        opts: { partialFilter: { 'pendingInputs.0': { $exists: true } } },
    },
    {
        collection: COL_SESSIONS,
        spec: { runtimeWakeRequestedAt: 1, 'activeRun.expiresAt': 1 },
        opts: { partialFilter: { runtimeWakeRequestedAt: { $exists: true } } },
    },
    {
        collection: COL_SUBAGENT_RUNS,
        spec: { sessionId: 1, toolCallId: 1 },
    },
];
