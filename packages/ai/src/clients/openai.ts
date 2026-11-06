import { OpenAIAdapter } from '../adapters/openai.js';
import { MalformedToolArgumentsError, type UpstreamRequestMeta } from '../malformed-tool-arguments.js';
export { MalformedToolArgumentsError, type UpstreamRequestMeta } from '../malformed-tool-arguments.js';
import OpenAI from 'openai';
import type { Fetch } from 'openai/core';
import { _iterSSEMessages } from 'openai/streaming';
import { ChatCompletionStream } from 'openai/lib/ChatCompletionStream';
import type { Dispatcher } from 'undici';
import { createProxyDispatcher } from '../proxy-dispatcher.js';
import { repairToolInputJson } from './tool-input-repair.js';
import type { ILLMClient, LLMChatRequest, LLMChatResponse, LLMToolCall, StreamDelta, ChatDefaults, } from '../types.js';
export interface UpstreamErrorMetadata {
    upstreamRequestId?: string | null;
    upstreamCompletionId?: string | null;
    providerType?: string;
    providerCode?: string | number;
}
export class OpenAIStreamProtocolError extends Error {
    readonly upstreamRequestId: string | null;
    readonly upstreamCompletionId: string | null;
    constructor(message: string, meta: UpstreamRequestMeta) {
        super(message);
        this.name = 'OpenAIStreamProtocolError';
        this.upstreamRequestId = meta.upstreamRequestId;
        this.upstreamCompletionId = meta.upstreamCompletionId;
    }
}
export class UpstreamStreamError extends Error {
    readonly upstreamRequestId?: string | null;
    readonly upstreamCompletionId?: string | null;
    readonly providerType?: string;
    readonly providerCode?: string | number;
    constructor(message: string, metadata: UpstreamErrorMetadata = {}) {
        super(message);
        this.name = 'UpstreamStreamError';
        this.upstreamRequestId = metadata.upstreamRequestId;
        this.upstreamCompletionId = metadata.upstreamCompletionId;
        this.providerType = metadata.providerType;
        this.providerCode = metadata.providerCode;
    }
}
const MAX_UPSTREAM_ERROR_BODY_LENGTH = 16384;
export async function readBoundedErrorBody(response: Response, signal?: AbortSignal): Promise<string> {
    const reader = response.body?.getReader();
    if (!reader)
        return '';
    const decoder = new TextDecoder();
    let length = 0;
    let body = '';
    let truncated = false;
    const abort = () => { void reader.cancel(signal?.reason).catch(() => { }); };
    signal?.addEventListener('abort', abort, { once: true });
    try {
        while (length <= MAX_UPSTREAM_ERROR_BODY_LENGTH) {
            signal?.throwIfAborted();
            const { done, value } = await reader.read();
            signal?.throwIfAborted();
            if (done)
                break;
            const remaining = MAX_UPSTREAM_ERROR_BODY_LENGTH - length;
            body += decoder.decode(value.subarray(0, Math.max(0, remaining)), { stream: true });
            length += value.byteLength;
            if (length > MAX_UPSTREAM_ERROR_BODY_LENGTH) {
                truncated = true;
                break;
            }
        }
        body += decoder.decode();
        return body + (truncated ? '\n...[truncated upstream error body]' : '');
    }
    finally {
        signal?.removeEventListener('abort', abort);
        void reader.cancel().catch(() => { });
        reader.releaseLock();
    }
}
export function sanitizeUpstreamErrorBody(body: string): string {
    const truncated = body.length > MAX_UPSTREAM_ERROR_BODY_LENGTH;
    let safe = body.slice(0, MAX_UPSTREAM_ERROR_BODY_LENGTH);
    safe = safe
        .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
        .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, 'sk-[REDACTED]')
        .replace(/("(?:api[_-]?key|api[_-]?secret|access[_-]?token|refresh[_-]?token|id[_-]?token|client[_-]?secret|private[_-]?key|authorization|password|secret|token)"\s*:\s*)"(?:\\.|[^"\\])*"/gi, '$1"[REDACTED]"');
    return truncated
        ? `${safe}\n...[truncated ${body.length - MAX_UPSTREAM_ERROR_BODY_LENGTH} chars]`
        : safe;
}
export function parseUpstreamErrorMetadata(value: unknown, depth = 0): UpstreamErrorMetadata {
    if (!value || typeof value !== 'object')
        return {};
    const envelope = value as Record<string, unknown>;
    const error = envelope.error && typeof envelope.error === 'object'
        ? envelope.error as Record<string, unknown>
        : envelope;
    const providerType = typeof error.type === 'string' ? error.type : undefined;
    const providerCode = typeof error.code === 'string' || typeof error.code === 'number'
        ? error.code
        : undefined;
    if (depth < 2 && typeof error.message === 'string') {
        try {
            const nested = parseUpstreamErrorMetadata(JSON.parse(error.message), depth + 1);
            return {
                providerType: nested.providerType ?? providerType,
                providerCode: nested.providerCode ?? providerCode,
            };
        }
        catch {
        }
    }
    return { providerType, providerCode };
}
export function parseUpstreamErrorBodyMetadata(body: string): UpstreamErrorMetadata {
    try {
        return parseUpstreamErrorMetadata(JSON.parse(body));
    }
    catch {
        return {};
    }
}
export class OpenAICompatibleHttpError extends Error {
    readonly status: number;
    readonly statusCode: number;
    readonly response: {
        status: number;
    };
    readonly responseBody: string;
    readonly retryAfter: string | null;
    readonly upstreamRequestId: string | null;
    readonly providerType?: string;
    readonly providerCode?: string | number;
    constructor(options: {
        message: string;
        status: number;
        responseBody: string;
        retryAfter?: string | null;
        upstreamRequestId?: string | null;
        providerType?: string;
        providerCode?: string | number;
    }) {
        super(options.message);
        this.name = 'OpenAICompatibleHttpError';
        this.status = options.status;
        this.statusCode = options.status;
        this.response = { status: options.status };
        this.responseBody = options.responseBody;
        this.retryAfter = options.retryAfter ?? null;
        this.upstreamRequestId = options.upstreamRequestId ?? null;
        this.providerType = options.providerType;
        this.providerCode = options.providerCode;
    }
}
export interface OpenAIClientOptions {
    apiKey: string;
    model: string;
    baseURL?: string;
    providerName?: string;
    supportsThinking?: boolean;
    supportsReasoningEffort?: boolean;
    reasoningFormat?: 'openai' | 'reasoning_object' | 'thinking_object' | 'enable_thinking';
    httpProxy?: string;
    dispatcher?: Dispatcher;
    includeUsageCost?: boolean;
    extraHeaders?: Record<string, string>;
    defaults?: ChatDefaults;
}
export interface OpenAITextBlock {
    type: 'text';
    text: string;
    cache_control?: {
        type: 'ephemeral';
    };
}
export interface OpenAIImageUrlBlock {
    type: 'image_url';
    image_url: {
        url: string;
        [key: string]: unknown;
    };
}
export interface OpenAIFileBlock {
    type: 'file';
    file: {
        file_data: string;
        filename?: string;
        [key: string]: unknown;
    };
}
export interface AnthropicBase64ImageBlock {
    type: 'image';
    source: {
        type: 'base64';
        media_type: string;
        data: string;
    };
}
export interface AnthropicBase64DocumentBlock {
    type: 'document';
    source: {
        type: 'base64';
        media_type: string;
        data: string;
    };
    filename?: string;
}
type OpenAIContentPart = OpenAITextBlock | OpenAIImageUrlBlock | OpenAIFileBlock;
type CompatibleContentPart = OpenAIContentPart | AnthropicBase64ImageBlock | AnthropicBase64DocumentBlock;
interface OpenAIMessageParam {
    role: 'system' | 'user' | 'assistant' | 'tool';
    content: string | CompatibleContentPart[] | null;
    tool_calls?: Array<{
        id: string;
        type: 'function';
        function: {
            name: string;
            arguments: string;
        };
    }>;
    tool_call_id?: string;
    reasoning_content?: string;
    reasoning_details?: unknown[];
}
function invalidContentPart(messageIndex: number, partIndex: number, reason: string): Error {
    return new Error(`[@nia-teams/ai] OpenAIClient cannot normalize messages[${messageIndex}].content[${partIndex}]: ${reason}`);
}
function normalizeMessages(messages: readonly OpenAIMessageParam[]): OpenAIMessageParam[] {
    return messages.map((message, messageIndex) => {
        if (!Array.isArray(message.content)) {
            return { ...message };
        }
        const content = message.content.map((part, partIndex): OpenAIContentPart => {
            if (!part || typeof part !== 'object' || !('type' in part)) {
                throw invalidContentPart(messageIndex, partIndex, 'part must be an object with a string type');
            }
            if (part.type === 'text') {
                if (typeof part.text !== 'string') {
                    throw invalidContentPart(messageIndex, partIndex, 'text part requires a string text field');
                }
                return { ...part, ...(part.cache_control ? { cache_control: { ...part.cache_control } } : {}) };
            }
            if (part.type === 'image_url') {
                if (!part.image_url || typeof part.image_url.url !== 'string') {
                    throw invalidContentPart(messageIndex, partIndex, 'image_url part requires image_url.url');
                }
                return { ...part, image_url: { ...part.image_url } };
            }
            if (part.type === 'file') {
                if (!part.file || typeof part.file.file_data !== 'string') {
                    throw invalidContentPart(messageIndex, partIndex, 'file part requires file.file_data');
                }
                return { ...part, file: { ...part.file } };
            }
            if (part.type === 'image' || part.type === 'document') {
                const source = part.source;
                if (!source || source.type !== 'base64' || typeof source.media_type !== 'string' || typeof source.data !== 'string') {
                    throw invalidContentPart(messageIndex, partIndex, `${part.type} part requires source:{type:'base64',media_type,data}`);
                }
                const dataUrl = `data:${source.media_type};base64,${source.data}`;
                if (part.type === 'image') {
                    return { type: 'image_url', image_url: { url: dataUrl } };
                }
                return {
                    type: 'file',
                    file: { file_data: dataUrl, filename: typeof part.filename === 'string' ? part.filename : 'document.pdf' },
                };
            }
            throw invalidContentPart(messageIndex, partIndex, `unsupported part type ${JSON.stringify((part as {
                type: unknown;
            }).type)}`);
        });
        return { ...message, content };
    });
}
function applyPromptCacheBreakpoints(messages: OpenAIMessageParam[]): void {
    const system = messages.find((m) => m.role === 'system');
    if (system && typeof system.content === 'string' && system.content.length > 0) {
        system.content = [{ type: 'text', text: system.content, cache_control: { type: 'ephemeral' } }];
    }
    for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i];
        if (m.role !== 'user' && m.role !== 'tool')
            continue;
        if (typeof m.content === 'string' && m.content.length > 0) {
            m.content = [{ type: 'text', text: m.content, cache_control: { type: 'ephemeral' } }];
            break;
        }
        if (Array.isArray(m.content) && m.content.length > 0) {
            const last = m.content[m.content.length - 1];
            if (last && last.type === 'text') {
                last.cache_control = { type: 'ephemeral' };
            }
            break;
        }
    }
}
export class OpenAIClient implements ILLMClient {
    private model: string;
    private providerName: string;
    private supportsThinking: boolean;
    private supportsReasoningEffort: boolean;
    private reasoningFormat?: OpenAIClientOptions['reasoningFormat'];
    private baseURL?: string;
    private apiKey: string;
    private proxyAgent?: Dispatcher;
    private readonly ownedProxyAgent?: Dispatcher;
    private includeUsageCost: boolean;
    private extraHeaders: Record<string, string>;
    private defaults: ChatDefaults;
    constructor(options: OpenAIClientOptions) {
        this.ownedProxyAgent = options.dispatcher ? undefined : createProxyDispatcher(options.httpProxy);
        this.proxyAgent = options.dispatcher ?? this.ownedProxyAgent;
        this.includeUsageCost = options.includeUsageCost ?? false;
        this.extraHeaders = options.extraHeaders ?? {};
        this.defaults = options.defaults ?? {};
        this.model = options.model;
        this.providerName = options.providerName || 'openai';
        this.supportsThinking = options.supportsThinking ?? false;
        this.supportsReasoningEffort = options.supportsReasoningEffort ?? false;
        this.reasoningFormat = options.reasoningFormat;
        this.baseURL = options.baseURL;
        this.apiKey = options.apiKey;
    }
    async chat(request: LLMChatRequest): Promise<LLMChatResponse> {
        const providerMessages = new OpenAIAdapter().fromStorage(request.messages, request.systemPrompt ?? '', this.model);
        const { tools, systemPrompt, onStreamDelta, signal, } = request;
        const enableThinking = request.enableThinking ?? this.defaults.enableThinking;
        const thinkingBudget = request.thinkingBudget ?? this.defaults.thinkingBudget;
        const thinkingType = request.thinkingType ?? this.defaults.thinkingType;
        const maxTokens = request.maxTokens ?? this.defaults.maxOutputTokens;
        const effort = request.effort ?? this.defaults.effort;
        const openaiMessages: OpenAIMessageParam[] = [];
        if (systemPrompt) {
            openaiMessages.push({ role: 'system', content: systemPrompt });
        }
        openaiMessages.push(...normalizeMessages(providerMessages as OpenAIMessageParam[]));
        const modelLc = this.model.toLowerCase();
        const isQwen = modelLc.startsWith('qwen');
        if (isQwen) {
            applyPromptCacheBreakpoints(openaiMessages);
        }
        const params: Record<string, unknown> = {
            model: this.model,
            messages: openaiMessages,
            max_tokens: maxTokens || 16384,
        };
        const thinkingEnabled = enableThinking === true && this.supportsThinking;
        if (tools && tools.length > 0) {
            params.tools = tools.map((t) => ({
                type: 'function',
                function: {
                    name: t.name,
                    description: t.description,
                    parameters: t.inputSchema,
                },
            }));
            params.tool_choice = 'auto';
        }
        if (this.reasoningFormat === 'reasoning_object') {
            if (enableThinking === false)
                params.reasoning = { enabled: false };
            else if (effort !== undefined)
                params.reasoning = { effort };
            else if (thinkingEnabled)
                params.reasoning = { enabled: true };
        }
        else if (this.reasoningFormat === 'thinking_object') {
            if (enableThinking === false || effort === 'none')
                params.thinking = { type: 'disabled' };
            else {
                if (enableThinking === true)
                    params.thinking = { type: 'enabled' };
                if (this.supportsReasoningEffort && effort !== undefined)
                    params.reasoning_effort = effort;
            }
        }
        else if (this.reasoningFormat === 'enable_thinking') {
            params.enable_thinking = effort !== 'none' && thinkingEnabled;
            if (this.supportsReasoningEffort && effort !== undefined && effort !== 'none')
                params.reasoning_effort = effort;
        }
        else if (this.supportsReasoningEffort && effort !== undefined) {
            params.reasoning_effort = effort;
        }
        if (onStreamDelta) {
            return this.chatStreaming(params, onStreamDelta, signal);
        }
        const { completion, upstreamRequestId } = await this.fetchChatCompletion(params, signal);
        return this.parseResponse(completion, { upstreamRequestId, upstreamCompletionId: completion.id ?? null });
    }
    private static extractUpstreamRequestId(response: Response): string | null {
        return (response.headers.get('x-oneapi-request-id') ||
            response.headers.get('x-request-id') ||
            response.headers.get('x-trace-id') ||
            null);
    }
    private static createHttpError(response: Response, responseBody: string, messagePrefix: string): OpenAICompatibleHttpError {
        const safeResponseBody = sanitizeUpstreamErrorBody(responseBody);
        const metadata = parseUpstreamErrorBodyMetadata(responseBody);
        return new OpenAICompatibleHttpError({
            message: `${messagePrefix}${safeResponseBody}`,
            status: response.status,
            responseBody: safeResponseBody,
            retryAfter: response.headers.get('retry-after'),
            upstreamRequestId: OpenAIClient.extractUpstreamRequestId(response),
            ...metadata,
        });
    }
    private async createChatResponse(params: Record<string, unknown>, signal: AbortSignal | undefined, streaming: boolean): Promise<Response> {
        let httpError: OpenAICompatibleHttpError | undefined;
        let transportError: unknown;
        const sdk = new OpenAI({
            apiKey: this.apiKey,
            organization: null,
            project: null,
            baseURL: this.baseURL || 'https://api.openai.com/v1',
            maxRetries: 0,
            timeout: 20 * 60000,
            fetch: (async (input: Parameters<Fetch>[0], init: Parameters<Fetch>[1]) => {
                try {
                    const requestInit = { ...init } as unknown as RequestInit;
                    if (this.proxyAgent)
                        (requestInit as Record<string, unknown>).dispatcher = this.proxyAgent;
                    const headers = new Headers(requestInit.headers);
                    for (const [key, value] of Object.entries(this.extraHeaders))
                        headers.set(key, value);
                    headers.delete('content-length');
                    requestInit.headers = headers;
                    const response = await fetch(input as Parameters<typeof fetch>[0], requestInit);
                    if (!response.ok) {
                        const body = await readBoundedErrorBody(response, requestInit.signal ?? undefined);
                        httpError = OpenAIClient.createHttpError(response, body, streaming
                            ? `OpenAI-compatible streaming API error: ${response.status} `
                            : `OpenAI-compatible API error: ${response.status} ${response.statusText}. `);
                        return new Response(httpError.responseBody, {
                            status: response.status,
                            statusText: response.statusText,
                            headers: response.headers,
                        });
                    }
                    return response;
                }
                catch (error) {
                    transportError = error;
                    throw error;
                }
            }) as unknown as Fetch,
        });
        try {
            signal?.throwIfAborted();
            const response = await sdk.chat.completions.create(params as unknown as OpenAI.Chat.ChatCompletionCreateParams, { signal }).asResponse();
            signal?.throwIfAborted();
            return response as unknown as Response;
        }
        catch (error) {
            signal?.throwIfAborted();
            if (httpError)
                throw httpError;
            if (transportError instanceof Error)
                throw transportError;
            throw error;
        }
    }
    private async fetchChatCompletion(params: Record<string, unknown>, signal?: AbortSignal): Promise<{
        completion: OpenAI.Chat.ChatCompletion;
        upstreamRequestId: string | null;
    }> {
        const response = await this.createChatResponse(this.includeUsageCost ? { ...params, usage: { include: true } } : params, signal, false);
        const completion = await response.json();
        signal?.throwIfAborted();
        return {
            completion: completion as OpenAI.Chat.ChatCompletion,
            upstreamRequestId: OpenAIClient.extractUpstreamRequestId(response),
        };
    }
    private async chatStreaming(params: Record<string, unknown>, onStreamDelta: (delta: StreamDelta) => void, signal?: AbortSignal): Promise<LLMChatResponse> {
        const body = {
            ...params,
            stream: true,
            stream_options: { include_usage: true },
            ...(this.includeUsageCost ? { usage: { include: true } } : {}),
        };
        const transportController = new AbortController();
        const transportSignal = signal
            ? AbortSignal.any([signal, transportController.signal])
            : transportController.signal;
        const response = await this.createChatResponse(body, transportSignal, true);
        const upstreamRequestId = OpenAIClient.extractUpstreamRequestId(response);
        const controller = new AbortController();
        const events = _iterSSEMessages(response as never, controller);
        const encoder = new TextEncoder();
        let id = '';
        let reasoning = '';
        const reasoningDetails: unknown[] = [];
        let sourceError: unknown;
        let bridgeController: ReadableStreamDefaultController<Uint8Array>;
        let runner: ChatCompletionStream | undefined;
        let bridgeClosed = false;
        const protocolError = (message: string) => new OpenAIStreamProtocolError(message, {
            upstreamRequestId, upstreamCompletionId: id || null,
        });
        const stopSource = () => {
            controller.abort();
            transportController.abort();
            void events.return(undefined).catch(() => { });
            void response.body?.cancel().catch(() => { });
        };
        const abort = () => {
            controller.abort(signal?.reason);
            if (!bridgeClosed) {
                bridgeClosed = true;
                bridgeController.error(signal?.reason);
            }
            runner?.abort();
        };
        const bridge = new ReadableStream<Uint8Array>({
            start(streamController) { bridgeController = streamController; },
            async pull(streamController) {
                try {
                    signal?.throwIfAborted();
                    const next = await events.next();
                    signal?.throwIfAborted();
                    if (bridgeClosed)
                        return;
                    if (next.done || next.value.data === '[DONE]') {
                        const snapshot = runner?.currentChatCompletionSnapshot;
                        const choice = snapshot?.choices[0];
                        if (!choice?.finish_reason) {
                            throw protocolError('Upstream response interrupted: missing finish_reason');
                        }
                        const tools = choice.message.tool_calls;
                        if (tools) {
                            for (const tool of tools) {
                                if (!tool?.id || tool.type !== 'function' || !tool.function?.name ||
                                    typeof tool.function.arguments !== 'string') {
                                    throw protocolError('Incomplete upstream tool call structure');
                                }
                            }
                        }
                        bridgeClosed = true;
                        streamController.close();
                        stopSource();
                        return;
                    }
                    const event = next.value;
                    let chunk: Record<string, any>;
                    try {
                        chunk = JSON.parse(event.data);
                    }
                    catch {
                        throw protocolError('Invalid JSON in upstream SSE event');
                    }
                    if (!chunk || typeof chunk !== 'object' || Array.isArray(chunk)) {
                        throw protocolError('Invalid upstream SSE chunk shape');
                    }
                    if (chunk.id) {
                        if (id && id !== chunk.id)
                            throw protocolError('Unexpected upstream completion ID change');
                        id = chunk.id;
                    }
                    if (chunk.error || event.event === 'error') {
                        const e = chunk.error ?? chunk;
                        const code = e.code ?? 'unknown';
                        const message = typeof e.message === 'string' ? e.message : 'Upstream stream error';
                        throw new UpstreamStreamError(`Upstream LLM error in stream (code=${code}): ${sanitizeUpstreamErrorBody(message)}`, { ...parseUpstreamErrorMetadata(e), upstreamRequestId, upstreamCompletionId: id || null });
                    }
                    if (event.event !== null && event.event !== 'message') {
                        throw protocolError('Unexpected upstream SSE event type');
                    }
                    if (!Array.isArray(chunk.choices))
                        throw protocolError('Invalid upstream choices shape');
                    if (chunk.choices.length > 0) {
                        if (chunk.choices.length !== 1 || chunk.choices[0]?.index !== 0) {
                            throw protocolError('Unexpected upstream choice index');
                        }
                        const choice = chunk.choices[0];
                        const delta = choice.delta ?? {};
                        if (typeof delta !== 'object' || Array.isArray(delta)) {
                            throw protocolError('Invalid upstream delta shape');
                        }
                        if (delta.tool_calls !== undefined && !Array.isArray(delta.tool_calls)) {
                            throw protocolError('Invalid upstream tool call structure');
                        }
                        for (const tool of delta.tool_calls ?? []) {
                            if (!tool || !Number.isInteger(tool.index) || tool.index < 0) {
                                throw protocolError('Invalid upstream tool index');
                            }
                        }
                        choice.delta = { role: 'assistant', ...delta };
                    }
                    streamController.enqueue(encoder.encode(JSON.stringify({ ...chunk, id }) + '\n'));
                }
                catch (error) {
                    sourceError = error;
                    if (!bridgeClosed) {
                        bridgeClosed = true;
                        streamController.error(error);
                    }
                    stopSource();
                }
            },
            cancel() { bridgeClosed = true; stopSource(); },
        }, { highWaterMark: 0 });
        signal?.addEventListener('abort', abort, { once: true });
        const streamedToolCalls = new Map<number, {
            id: string;
            name?: string;
            pendingJson: string;
            started?: boolean;
        }>();
        try {
            signal?.throwIfAborted();
            runner = ChatCompletionStream.fromReadableStream(bridge as never);
            runner.on('chunk', chunk => {
                try {
                    signal?.throwIfAborted();
                    const delta = chunk.choices[0]?.delta as Record<string, any> | undefined;
                    if (Array.isArray(delta?.reasoning_details)) {
                        for (const detail of delta.reasoning_details) {
                            if (!detail || typeof detail !== 'object' || Array.isArray(detail)) {
                                reasoningDetails.push(detail);
                                continue;
                            }
                            const item = detail as Record<string, any>;
                            const last = reasoningDetails[reasoningDetails.length - 1] as Record<string, any> | undefined;
                            if (item.type === 'reasoning.text') {
                                if (last && typeof last === 'object' && !Array.isArray(last) && last.type === 'reasoning.text' && !last.signature) {
                                    last.text = (typeof last.text === 'string' ? last.text : '') + (typeof item.text === 'string' ? item.text : '');
                                    if (!last.signature && item.signature)
                                        last.signature = item.signature;
                                    if (!last.format && item.format)
                                        last.format = item.format;
                                    if (last.id == null && item.id != null)
                                        last.id = item.id;
                                    if (last.index == null && item.index != null)
                                        last.index = item.index;
                                }
                                else {
                                    reasoningDetails.push({ ...item });
                                }
                            }
                            else if (item.type === 'reasoning.summary') {
                                if (last && typeof last === 'object' && !Array.isArray(last) && last.type === 'reasoning.summary') {
                                    last.summary = (typeof last.summary === 'string' ? last.summary : '') + (typeof item.summary === 'string' ? item.summary : '');
                                    if (!last.format && item.format)
                                        last.format = item.format;
                                    if (last.id == null && item.id != null)
                                        last.id = item.id;
                                    if (last.index == null && item.index != null)
                                        last.index = item.index;
                                }
                                else {
                                    reasoningDetails.push({ ...item });
                                }
                            }
                            else {
                                reasoningDetails.push(detail);
                            }
                        }
                    }
                    const thinking = delta?.reasoning_content ?? delta?.reasoning;
                    if (thinking) {
                        reasoning += thinking;
                        onStreamDelta({ type: 'thinking', content: thinking });
                    }
                    if (delta?.content)
                        onStreamDelta({ type: 'text', content: delta.content });
                    for (const tc of delta?.tool_calls ?? []) {
                        const index = Number.isInteger(tc?.index) ? tc.index : 0;
                        const prior = streamedToolCalls.get(index) ?? { id: '', pendingJson: '' };
                        if (tc?.id)
                            prior.id = tc.id;
                        if (tc?.function?.name)
                            prior.name = tc.function.name;
                        const partialJson = tc?.function?.arguments ?? '';
                        if (partialJson)
                            prior.pendingJson += partialJson;
                        streamedToolCalls.set(index, prior);
                        if (prior.id && prior.name && !prior.started) {
                            prior.started = true;
                            onStreamDelta({ type: 'tool_input_start', content: '', toolCallId: prior.id, toolName: prior.name });
                        }
                        if (prior.started && prior.pendingJson) {
                            const pendingJson = prior.pendingJson;
                            prior.pendingJson = '';
                            onStreamDelta({ type: 'tool_input_delta', content: pendingJson, toolCallId: prior.id, toolName: prior.name, partialJson: pendingJson });
                        }
                    }
                }
                catch (error) {
                    sourceError = error;
                    throw error;
                }
            });
            const completion = await runner.finalChatCompletion();
            signal?.throwIfAborted();
            const message = completion.choices[0].message as unknown as Record<string, unknown>;
            delete message.reasoning_content;
            delete message.reasoning;
            if (reasoning)
                message.reasoning_content = reasoning;
            delete message.reasoning_details;
            if (reasoningDetails.length > 0)
                message.reasoning_details = reasoningDetails;
            return this.parseResponse(completion, { upstreamRequestId, upstreamCompletionId: id || null });
        }
        catch (error) {
            signal?.throwIfAborted();
            if (sourceError)
                throw sourceError;
            if (error instanceof MalformedToolArgumentsError)
                throw error;
            throw protocolError('Invalid upstream message aggregation or tool call structure');
        }
        finally {
            signal?.removeEventListener('abort', abort);
            runner?.abort();
            stopSource();
        }
    }
    private parseResponse(response: OpenAI.Chat.ChatCompletion, upstreamMeta: UpstreamRequestMeta = { upstreamRequestId: null, upstreamCompletionId: null }): LLMChatResponse {
        const parsed: OpenAI.Chat.ChatCompletion = typeof response === 'string' ? JSON.parse(response) : response;
        if (!parsed.choices || parsed.choices.length === 0) {
            throw new Error('LLM returned empty response (no choices)');
        }
        const choice = parsed.choices[0];
        const message = choice.message;
        const reasoning = (message as unknown as {
            reasoning_content?: string;
            reasoning?: string;
        })
            .reasoning_content
            ?? (message as unknown as {
                reasoning?: string;
            }).reasoning;
        const rawReasoningDetails = (message as unknown as {
            reasoning_details?: unknown;
        }).reasoning_details;
        const reasoningDetails = Array.isArray(rawReasoningDetails) ? rawReasoningDetails : undefined;
        let toolCalls: LLMToolCall[] | undefined;
        let firstMalformed: {
            id: string;
            name: string;
            raw: string;
        } | undefined;
        if (message.tool_calls && message.tool_calls.length > 0) {
            toolCalls = message.tool_calls.map((tc) => {
                const raw = tc.function.arguments;
                try {
                    const parsedArgs = JSON.parse(raw);
                    if (parsedArgs && typeof parsedArgs === 'object' && !Array.isArray(parsedArgs)) {
                        return {
                            id: tc.id,
                            name: tc.function.name,
                            arguments: raw,
                        };
                    }
                }
                catch {
                }
                if (raw.trim() !== '') {
                    const repaired = repairToolInputJson(raw, { allowAutoclose: false });
                    if (repaired) {
                        return {
                            id: tc.id,
                            name: tc.function.name,
                            arguments: repaired.repairedJson,
                        };
                    }
                }
                if (!firstMalformed) {
                    firstMalformed = { id: tc.id, name: tc.function.name, raw };
                }
                const preview = raw.length > 200 ? raw.slice(0, 200) + '...' : raw;
                return {
                    id: tc.id,
                    name: tc.function.name,
                    arguments: '{}',
                    malformedError: `tool_call.arguments not valid JSON for tool=${tc.function.name} id=${tc.id} ` +
                        `(length=${raw.length}): ${JSON.stringify(preview)}`,
                };
            });
        }
        let stopReason: LLMChatResponse['stopReason'] = 'end_turn';
        if (choice.finish_reason === 'tool_calls') {
            stopReason = 'tool_use';
        }
        else if (choice.finish_reason === 'length') {
            stopReason = 'max_tokens';
        }
        const rawUsage = parsed.usage as Record<string, unknown> | undefined;
        const promptDetails = rawUsage?.prompt_tokens_details as Record<string, unknown> | undefined;
        const completionDetails = rawUsage?.completion_tokens_details as Record<string, unknown> | undefined;
        const usdCost = typeof rawUsage?.cost === 'number' ? (rawUsage.cost as number) : undefined;
        const assembledResponse: LLMChatResponse = {
            content: message.content,
            toolCalls,
            reasoning,
            ...(reasoningDetails ? { reasoningDetails } : {}),
            stopReason,
            usage: rawUsage
                ? {
                    promptTokens: (rawUsage.prompt_tokens as number) ?? 0,
                    completionTokens: (rawUsage.completion_tokens as number) ?? 0,
                    cachedTokens: promptDetails?.cached_tokens as number | undefined,
                    reasoningTokens: completionDetails?.reasoning_tokens as number | undefined,
                    usdCost,
                }
                : undefined,
            upstreamRequestId: upstreamMeta.upstreamRequestId,
            upstreamCompletionId: upstreamMeta.upstreamCompletionId,
        };
        if (firstMalformed) {
            throw new MalformedToolArgumentsError(firstMalformed.id, firstMalformed.name, firstMalformed.raw, upstreamMeta, assembledResponse);
        }
        return assembledResponse;
    }
    getProviderName(): string {
        return this.providerName;
    }
    getModelName(): string {
        return this.model;
    }
    async close(): Promise<void> {
        await this.ownedProxyAgent?.close();
    }
}
