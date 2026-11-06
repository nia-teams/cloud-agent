import { vi } from 'vitest';
import type { AgentMessage, ConversationStore, ILLMClient, LLMChatResponse, Tool, UsageEntry, UsageRecorder, } from '../index.js';
import type { LLMChatRequest, StreamDelta } from '../protocol/llm-protocol.js';
export interface ScriptedResponse {
    content?: string | null;
    toolCalls?: Array<{
        id: string;
        name: string;
        arguments: string;
    }>;
    reasoning?: string;
    reasoningSignature?: string;
    stopReason?: 'end_turn' | 'tool_use' | 'max_tokens' | 'error';
    usage?: LLMChatResponse['usage'];
    throws?: Error;
    streamDeltas?: StreamDelta[];
}
export class MockLLMClient implements ILLMClient {
    public calls: LLMChatRequest[] = [];
    private idx = 0;
    constructor(private readonly responses: ScriptedResponse[], private readonly providerName = 'mock', private readonly modelName = 'mock-model-1') { }
    async chat(request: LLMChatRequest): Promise<LLMChatResponse> {
        this.calls.push(request);
        const r = this.responses[this.idx];
        if (!r) {
            throw new Error(`MockLLMClient: ran out of scripted responses (call #${this.idx + 1})`);
        }
        this.idx++;
        if (r.streamDeltas && request.onStreamDelta) {
            for (const d of r.streamDeltas)
                request.onStreamDelta(d);
        }
        if (r.throws)
            throw r.throws;
        return {
            content: r.content ?? null,
            toolCalls: r.toolCalls,
            reasoning: r.reasoning,
            reasoningSignature: r.reasoningSignature,
            stopReason: r.stopReason ?? (r.toolCalls?.length ? 'tool_use' : 'end_turn'),
            usage: r.usage ?? {
                promptTokens: 100,
                completionTokens: 20,
            },
        };
    }
    getProviderName(): string {
        return this.providerName;
    }
    getModelName(): string {
        return this.modelName;
    }
    reset(responses: ScriptedResponse[]): void {
        (this.responses as ScriptedResponse[]).length = 0;
        (this.responses as ScriptedResponse[]).push(...responses);
        this.idx = 0;
        this.calls.length = 0;
    }
}
export class MemoryStore implements ConversationStore {
    public stored: AgentMessage[] = [];
    public inbox: AgentMessage[] = [];
    constructor(initial: AgentMessage[] = []) {
        this.stored = [...initial];
    }
    async loadAll(): Promise<AgentMessage[]> {
        return this.stored.slice();
    }
    async fetchNew(): Promise<AgentMessage[]> {
        const out = this.inbox;
        this.inbox = [];
        this.stored.push(...out);
        return out;
    }
    async hasNew(): Promise<boolean> {
        return this.inbox.length > 0;
    }
    async persist(messages: AgentMessage[]): Promise<void> {
        this.stored.push(...messages);
    }
    enqueue(...msgs: AgentMessage[]): void {
        this.inbox.push(...msgs);
    }
}
export class CapturingUsageRecorder implements UsageRecorder {
    public entries: UsageEntry[] = [];
    async record(entry: UsageEntry): Promise<void> {
        this.entries.push(entry);
    }
}
export function makeEchoTool(name = 'echo'): Tool & {
    calls: Array<{
        input: Record<string, unknown>;
    }>;
} {
    const calls: Array<{
        input: Record<string, unknown>;
    }> = [];
    const tool: Tool & {
        calls: typeof calls;
    } = {
        name,
        description: 'Echoes its `text` input',
        inputSchema: {
            type: 'object',
            properties: { text: { type: 'string' } },
            required: ['text'],
        },
        calls,
        execute: vi.fn(async (input: Record<string, unknown>) => {
            calls.push({ input });
            return `echo:${input.text}`;
        }) as unknown as Tool['execute'],
    };
    return tool;
}
export function makeFailingTool(name = 'fail'): Tool {
    return {
        name,
        description: 'Always fails',
        inputSchema: { type: 'object', properties: {} },
        execute: vi.fn(async () => {
            throw new Error('intentional failure');
        }) as unknown as Tool['execute'],
    };
}
export function userEvent(content: string, userId = 'u1'): AgentMessage {
    return {
        type: 'event',
        eventType: 'message.received',
        content,
        meta: { userId },
        timestamp: new Date(),
    };
}
