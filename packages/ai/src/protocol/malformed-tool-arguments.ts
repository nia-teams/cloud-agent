import type { LLMChatResponse } from './types.js';
export interface UpstreamRequestMeta {
    upstreamRequestId: string | null;
    upstreamCompletionId: string | null;
}
export class MalformedToolArgumentsError extends Error {
    readonly toolCallId: string;
    readonly toolName: string;
    readonly rawArguments: string;
    readonly upstreamRequestId: string | null;
    readonly upstreamCompletionId: string | null;
    readonly partialResponse?: LLMChatResponse;
    constructor(toolCallId: string, toolName: string, rawArguments: string, upstreamMeta: UpstreamRequestMeta = { upstreamRequestId: null, upstreamCompletionId: null }, partialResponse?: LLMChatResponse) {
        const preview = rawArguments.length > 80
            ? rawArguments.slice(0, 80) + '...'
            : rawArguments;
        super(`tool_call.arguments not valid JSON for tool=${toolName} id=${toolCallId} ` +
            `(length=${rawArguments.length}): ${JSON.stringify(preview)}`);
        this.name = 'MalformedToolArgumentsError';
        this.toolCallId = toolCallId;
        this.toolName = toolName;
        this.rawArguments = rawArguments;
        this.upstreamRequestId = upstreamMeta.upstreamRequestId;
        this.upstreamCompletionId = upstreamMeta.upstreamCompletionId;
        this.partialResponse = partialResponse;
    }
}
