import { randomUUID } from 'node:crypto';
import type { Dispatcher } from 'undici';
import { GeminiAdapter } from '../adapters/gemini.js';
import type { ILLMClient, LLMChatRequest, LLMChatResponse, LLMToolCall, StreamDelta, ChatDefaults, } from '../types.js';
import { scopeLogger, type Logger } from '../logger.js';
const UNSUPPORTED_SCHEMA_FIELDS = Object.freeze(['additionalProperties', '$schema', 'default']);
function stripUnsupportedSchemaFields(schema: unknown): unknown {
    if (schema === null || schema === undefined || typeof schema !== 'object') {
        return schema;
    }
    if (Array.isArray(schema)) {
        return schema.map(stripUnsupportedSchemaFields);
    }
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(schema as Record<string, unknown>)) {
        if (UNSUPPORTED_SCHEMA_FIELDS.includes(key))
            continue;
        result[key] = stripUnsupportedSchemaFields(value);
    }
    return result;
}
interface GeminiPart {
    text?: string;
    functionCall?: {
        name: string;
        args: Record<string, unknown>;
        id?: string;
    };
    functionResponse?: {
        name: string;
        response: Record<string, unknown>;
    };
    thoughtSignature?: string;
    thought?: boolean;
}
interface GeminiContent {
    role: 'user' | 'model';
    parts: GeminiPart[];
}
interface GeminiStreamChunk {
    candidates?: Array<{
        content?: {
            role?: string;
            parts?: GeminiPart[];
        };
        finishReason?: string | null;
    }>;
    usageMetadata?: {
        promptTokenCount?: number;
        candidatesTokenCount?: number;
        thoughtsTokenCount?: number;
    };
}
export interface GeminiClientOptions {
    /** API-key header by default; select bearer for gateways requiring token authentication. */
    authHeader?: 'x-goog-api-key' | 'bearer';
    extraHeaders?: Record<string, string>;
    dispatcher?: Dispatcher;
    logger?: Logger;
    apiKey: string;
    model: string;
    baseURL?: string;
    sessionId?: string;
    defaults?: ChatDefaults;
}
export class GeminiClient implements ILLMClient {
    private extraHeaders: Record<string, string>;
    private dispatcher?: Dispatcher;
    private apiKey: string;
    private authHeader: 'x-goog-api-key' | 'bearer';
    private model: string;
    private baseURL: string;
    private sessionId?: string;
    private defaults: ChatDefaults;
    private readonly log: Logger;
    private fetch(url: string, init: RequestInit): Promise<Response> {
        if (this.dispatcher) Object.assign(init, { dispatcher: this.dispatcher });
        return fetch(url, init);
    }
    constructor(options: GeminiClientOptions) {
        this.extraHeaders = options.extraHeaders ?? {};
        this.dispatcher = options.dispatcher;
        this.log = scopeLogger(options.logger, 'gemini-client');
        this.apiKey = options.apiKey;
        this.authHeader = options.authHeader ?? 'x-goog-api-key';
        this.model = options.model;
        this.baseURL = (options.baseURL || 'https://generativelanguage.googleapis.com').replace(/\/+$/, '');
        this.sessionId = options.sessionId;
        this.defaults = options.defaults ?? {};
    }
    async chat(request: LLMChatRequest): Promise<LLMChatResponse> {
        const providerMessages = new GeminiAdapter().fromStorage(request.messages, request.systemPrompt ?? '', this.model);
        const { tools, systemPrompt, onStreamDelta, signal, } = request;
        const enableThinking = request.enableThinking ?? this.defaults.enableThinking;
        const thinkingBudget = request.thinkingBudget ?? this.defaults.thinkingBudget;
        const maxTokens = request.maxTokens ?? this.defaults.maxOutputTokens;
        const requestBody: Record<string, unknown> = {
            contents: providerMessages as GeminiContent[],
            generationConfig: {
                maxOutputTokens: maxTokens || 65536,
            },
        };
        if (systemPrompt) {
            requestBody.systemInstruction = {
                parts: [{ text: systemPrompt }],
            };
        }
        if (tools && tools.length > 0) {
            requestBody.tools = [
                {
                    functionDeclarations: tools.map((t) => ({
                        name: t.name,
                        description: t.description,
                        parameters: stripUnsupportedSchemaFields(t.inputSchema),
                    })),
                },
            ];
        }
        if (enableThinking) {
            (requestBody.generationConfig as Record<string, unknown>).thinkingConfig = {
                thinkingBudget: thinkingBudget || 8000,
                includeThoughts: true,
            };
        }
        if (onStreamDelta) {
            return this.chatStreaming(requestBody, onStreamDelta, signal);
        }
        return this.chatNonStreaming(requestBody, signal);
    }
    private async chatNonStreaming(requestBody: Record<string, unknown>, signal?: AbortSignal): Promise<LLMChatResponse> {
        const url = `${this.baseURL}/v1beta/models/${this.model}:generateContent`;
        const response = await this.fetch(url, {
            method: 'POST',
            headers: {
                ...this.extraHeaders,
                'Content-Type': 'application/json',
                ...(this.authHeader === 'bearer'
                    ? { Authorization: `Bearer ${this.apiKey}` }
                    : { 'x-goog-api-key': this.apiKey }),
            },
            body: JSON.stringify(requestBody),
            signal,
        });
        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Gemini API error: ${response.status} ${errorText}`);
        }
        const data = (await response.json()) as GeminiStreamChunk;
        return this.parseChunkResponse(data);
    }
    private async chatStreaming(requestBody: Record<string, unknown>, onStreamDelta: (delta: StreamDelta) => void, signal?: AbortSignal): Promise<LLMChatResponse> {
        const url = `${this.baseURL}/v1beta/models/${this.model}:streamGenerateContent?alt=sse`;
        const response = await this.fetch(url, {
            method: 'POST',
            headers: {
                ...this.extraHeaders,
                'Content-Type': 'application/json',
                ...(this.authHeader === 'bearer'
                    ? { Authorization: `Bearer ${this.apiKey}` }
                    : { 'x-goog-api-key': this.apiKey }),
            },
            body: JSON.stringify(requestBody),
            signal,
        });
        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Gemini streaming API error: ${response.status} ${errorText}`);
        }
        const reader = response.body?.getReader();
        if (!reader)
            throw new Error('No response body');
        const decoder = new TextDecoder();
        let buffer = '';
        let content = '';
        let reasoning = '';
        const toolCalls: LLMToolCall[] = [];
        let thoughtSignature = '';
        let finishReason = '';
        let promptTokens = 0;
        let completionTokens = 0;
        const processLine = (line: string) => {
            if (!line.startsWith('data: '))
                return;
            const data = line.slice(6).trim();
            if (!data || data === '[DONE]')
                return;
            try {
                const chunk = JSON.parse(data) as GeminiStreamChunk;
                if (!chunk.candidates && !chunk.usageMetadata)
                    return;
                if (chunk.usageMetadata) {
                    promptTokens = chunk.usageMetadata.promptTokenCount ?? promptTokens;
                    completionTokens = chunk.usageMetadata.candidatesTokenCount ?? completionTokens;
                }
                const candidate = chunk.candidates?.[0];
                if (candidate?.finishReason) {
                    finishReason = candidate.finishReason;
                }
                if (!candidate?.content?.parts)
                    return;
                for (const part of candidate.content.parts) {
                    if (part.thoughtSignature) {
                        thoughtSignature = part.thoughtSignature;
                    }
                    if (part.thought) {
                        if (part.text) {
                            reasoning += part.text;
                            onStreamDelta({ type: 'thinking', content: part.text });
                        }
                    }
                    else if (part.text) {
                        content += part.text;
                        onStreamDelta({ type: 'text', content: part.text });
                    }
                    if (part.functionCall) {
                        const fc = part.functionCall;
                        const id = fc.id ?? randomUUID();
                        toolCalls.push({
                            id,
                            name: fc.name,
                            arguments: JSON.stringify(fc.args || {}),
                        });
                    }
                }
            }
            catch {
            }
        };
        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done)
                    break;
                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n');
                buffer = lines.pop() || '';
                for (const line of lines) {
                    processLine(line);
                }
            }
            if (buffer.trim()) {
                processLine(buffer);
            }
        }
        finally {
            reader.releaseLock();
        }
        let stopReason: LLMChatResponse['stopReason'] = 'end_turn';
        if (toolCalls.length > 0) {
            stopReason = 'tool_use';
        }
        else if (finishReason === 'MAX_TOKENS') {
            stopReason = 'max_tokens';
        }
        return {
            content: content || null,
            toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
            reasoning: reasoning || undefined,
            reasoningSignature: thoughtSignature || undefined,
            stopReason,
            usage: {
                promptTokens,
                completionTokens,
            },
        };
    }
    private parseChunkResponse(data: GeminiStreamChunk): LLMChatResponse {
        const candidate = data.candidates?.[0];
        if (!candidate?.content?.parts) {
            throw new Error('Gemini returned empty response (no candidates)');
        }
        let content = '';
        let reasoning = '';
        const toolCalls: LLMToolCall[] = [];
        let thoughtSignature = '';
        for (const part of candidate.content.parts) {
            if (part.thoughtSignature)
                thoughtSignature = part.thoughtSignature;
            if (part.thought) {
                if (part.text)
                    reasoning += part.text;
            }
            else if (part.text) {
                content += part.text;
            }
            if (part.functionCall) {
                const fc = part.functionCall;
                toolCalls.push({
                    id: fc.id ?? randomUUID(),
                    name: fc.name,
                    arguments: JSON.stringify(fc.args || {}),
                });
            }
        }
        let stopReason: LLMChatResponse['stopReason'] = 'end_turn';
        if (toolCalls.length > 0)
            stopReason = 'tool_use';
        else if (candidate.finishReason === 'MAX_TOKENS')
            stopReason = 'max_tokens';
        return {
            content: content || null,
            toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
            reasoning: reasoning || undefined,
            reasoningSignature: thoughtSignature || undefined,
            stopReason,
            usage: data.usageMetadata
                ? {
                    promptTokens: data.usageMetadata.promptTokenCount || 0,
                    completionTokens: data.usageMetadata.candidatesTokenCount || 0,
                }
                : undefined,
        };
    }
    getProviderName(): string {
        return 'gemini';
    }
    getModelName(): string {
        return this.model;
    }
}
