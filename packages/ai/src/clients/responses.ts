import { OpenAIAdapter } from '../adapters/openai.js';
import { _iterSSEMessages } from 'openai/streaming';
import type { Dispatcher } from 'undici';
import { createProxyDispatcher } from '../proxy-dispatcher.js';
import { repairToolInputJson } from './tool-input-repair.js';
import { MalformedToolArgumentsError, OpenAICompatibleHttpError, OpenAIStreamProtocolError, UpstreamStreamError, parseUpstreamErrorBodyMetadata, parseUpstreamErrorMetadata, readBoundedErrorBody, sanitizeUpstreamErrorBody, type AnthropicBase64DocumentBlock, type AnthropicBase64ImageBlock, type OpenAIFileBlock, type OpenAIImageUrlBlock, type OpenAITextBlock, type UpstreamRequestMeta, } from './openai.js';
import type { ILLMClient, LLMChatRequest, LLMChatResponse, LLMToolCall, StreamDelta, ChatDefaults, } from '../types.js';
import { scopeLogger, type Logger } from '../logger.js';
export type ResponsesInputContentPart = {
    type: 'input_text' | 'output_text';
    text: string;
} | {
    type: 'input_image';
    image_url: string;
    detail?: string;
} | {
    type: 'input_file';
    file_data?: string;
    file_url?: string;
    file_id?: string;
    filename?: string;
};
export interface ResponsesMessageInput {
    type?: 'message';
    id?: string;
    role: 'system' | 'developer' | 'user' | 'assistant';
    content: string | ResponsesInputContentPart[];
    status?: string;
}
export interface ResponsesFunctionCallInput {
    type: 'function_call';
    id?: string;
    call_id: string;
    name: string;
    arguments: string;
    status?: 'completed';
}
export interface ResponsesFunctionCallOutput {
    type: 'function_call_output';
    call_id: string;
    output: string;
}
export interface ResponsesReasoningItem {
    type: 'reasoning';
    id?: string;
    encrypted_content?: string;
    summary: Array<{
        type: 'summary_text';
        text: string;
    }>;
}
export type ResponsesInputItem = ResponsesMessageInput | ResponsesFunctionCallInput | ResponsesFunctionCallOutput | ResponsesReasoningItem | Record<string, unknown>;
interface ResponsesMessageOutputContent {
    type: 'output_text' | 'refusal';
    text?: string;
    refusal?: string;
    annotations?: unknown[];
}
interface ResponsesMessageOutput {
    id?: string;
    type: 'message';
    role: 'assistant';
    status?: string;
    content: ResponsesMessageOutputContent[];
}
interface ResponsesFunctionCallItem {
    id?: string;
    type: 'function_call';
    call_id: string;
    name: string;
    arguments: string;
    status?: string;
}
interface ResponsesReasoningOutput {
    id?: string;
    type: 'reasoning';
    encrypted_content?: string;
    summary?: Array<{
        type: 'summary_text';
        text: string;
    }>;
}
type ResponsesOutputItem = ResponsesMessageOutput | ResponsesFunctionCallItem | ResponsesReasoningOutput | Record<string, unknown>;
interface ResponsesUsage {
    input_tokens: number;
    output_tokens: number;
    input_tokens_details?: {
        cached_tokens?: number;
    };
    output_tokens_details?: {
        reasoning_tokens?: number;
    };
}
interface ResponsesResponse {
    id: string;
    status: string;
    incomplete_details?: {
        reason?: string;
    } | null;
    error?: {
        code?: string | number;
        message?: string;
        type?: string;
    } | null;
    output: ResponsesOutputItem[];
    usage?: ResponsesUsage;
}
type CompatibleContentPart = OpenAITextBlock | OpenAIImageUrlBlock | OpenAIFileBlock | AnthropicBase64ImageBlock | AnthropicBase64DocumentBlock | ResponsesInputContentPart;
interface OpenAIMessage {
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
export interface ResponsesClientOptions {
    logger?: Logger;
    apiKey: string;
    model: string;
    baseURL?: string;
    providerName?: string;
    supportsThinking?: boolean;
    httpProxy?: string;
    dispatcher?: Dispatcher;
    extraHeaders?: Record<string, string>;
    promptCacheKey?: string;
    defaults?: ChatDefaults;
}
const VALID_CONFIGURATION_UPDATE_EFFORTS = Object.freeze([
    'none',
    'minimal',
    'low',
    'medium',
    'high',
    'xhigh',
    'max',
]);
function extractConfigurationUpdateEffort(item: unknown): string | undefined {
    if (!item || typeof item !== 'object' || Array.isArray(item))
        return undefined;
    if ((item as {
        type?: unknown;
    }).type !== 'configuration_update')
        return undefined;
    const reasoning = (item as {
        reasoning?: unknown;
    }).reasoning;
    if (!reasoning || typeof reasoning !== 'object' || Array.isArray(reasoning))
        return undefined;
    const effort = (reasoning as {
        effort?: unknown;
    }).effort;
    if (typeof effort !== 'string')
        return undefined;
    const normalized = effort.trim().toLowerCase();
    return VALID_CONFIGURATION_UPDATE_EFFORTS.includes(normalized) ? normalized : undefined;
}
function isResponsesReplayItem(item: unknown): item is Record<string, unknown> {
    if (!item || typeof item !== 'object' || Array.isArray(item))
        return false;
    const t = (item as {
        type?: unknown;
    }).type;
    if (t === 'configuration_update') {
        return extractConfigurationUpdateEffort(item) !== undefined;
    }
    return (t === 'reasoning' ||
        t === 'message' ||
        t === 'function_call' ||
        t === 'custom_tool_call');
}
function invalidContentPart(messageIndex: number, partIndex: number, reason: string): Error {
    return new Error(`[@nia-teams/ai] ResponsesClient cannot normalize messages[${messageIndex}].content[${partIndex}]: ${reason}`);
}
function normalizeMessageContent(role: 'system' | 'user' | 'assistant', content: string | CompatibleContentPart[] | null, messageIndex: number): string | ResponsesInputContentPart[] {
    if (content === null || content === undefined)
        return '';
    if (typeof content === 'string')
        return content;
    if (!Array.isArray(content)) {
        throw invalidContentPart(messageIndex, 0, 'content must be string or array');
    }
    const defaultTextType = role === 'assistant' ? 'output_text' : 'input_text';
    return content.map((part, partIndex): ResponsesInputContentPart => {
        if (!part || typeof part !== 'object' || !('type' in part)) {
            throw invalidContentPart(messageIndex, partIndex, 'part must be an object with a string type');
        }
        const p = part as Record<string, unknown>;
        const type = p.type;
        if (type === 'text' || type === 'input_text' || type === 'output_text') {
            if (typeof p.text !== 'string') {
                throw invalidContentPart(messageIndex, partIndex, 'text part requires a string text field');
            }
            return {
                type: type === 'output_text' || role === 'assistant' ? 'output_text' : defaultTextType,
                text: p.text,
            };
        }
        if (type === 'input_image') {
            if (typeof p.image_url !== 'string') {
                throw invalidContentPart(messageIndex, partIndex, 'input_image part requires a string image_url');
            }
            return {
                type: 'input_image',
                image_url: p.image_url,
                ...(typeof p.detail === 'string' ? { detail: p.detail } : {}),
            };
        }
        if (type === 'image_url') {
            const img = p.image_url as Record<string, unknown> | undefined;
            if (!img || typeof img.url !== 'string') {
                throw invalidContentPart(messageIndex, partIndex, 'image_url part requires image_url.url');
            }
            return {
                type: 'input_image',
                image_url: img.url,
                ...(typeof img.detail === 'string' ? { detail: img.detail } : {}),
            };
        }
        if (type === 'input_file') {
            const fileData = typeof p.file_data === 'string' ? p.file_data : undefined;
            const fileUrl = typeof p.file_url === 'string' ? p.file_url : undefined;
            const fileId = typeof p.file_id === 'string' ? p.file_id : undefined;
            if (!fileData && !fileUrl && !fileId) {
                throw invalidContentPart(messageIndex, partIndex, 'input_file part requires file_data, file_url, or file_id');
            }
            return {
                type: 'input_file',
                ...(fileData ? { file_data: fileData } : {}),
                ...(fileUrl ? { file_url: fileUrl } : {}),
                ...(fileId ? { file_id: fileId } : {}),
                ...(typeof p.filename === 'string' ? { filename: p.filename } : {}),
            };
        }
        if (type === 'file') {
            const file = p.file as Record<string, unknown> | undefined;
            if (!file || typeof file.file_data !== 'string') {
                throw invalidContentPart(messageIndex, partIndex, 'file part requires file.file_data');
            }
            return {
                type: 'input_file',
                file_data: file.file_data,
                ...(typeof file.filename === 'string' ? { filename: file.filename } : {}),
            };
        }
        if (type === 'image' || type === 'document') {
            const source = p.source as Record<string, unknown> | undefined;
            if (!source ||
                source.type !== 'base64' ||
                typeof source.media_type !== 'string' ||
                typeof source.data !== 'string') {
                throw invalidContentPart(messageIndex, partIndex, `${String(type)} part requires source:{type:'base64',media_type,data}`);
            }
            const dataUrl = `data:${source.media_type};base64,${source.data}`;
            if (type === 'image') {
                return { type: 'input_image', image_url: dataUrl };
            }
            return {
                type: 'input_file',
                file_data: dataUrl,
                filename: typeof p.filename === 'string' ? p.filename : 'document.pdf',
            };
        }
        throw invalidContentPart(messageIndex, partIndex, `unsupported part type ${JSON.stringify(type)}`);
    });
}
export class ResponsesClient implements ILLMClient {
    private apiKey: string;
    private model: string;
    private baseURL: string;
    private providerName: string;
    private supportsThinking: boolean;
    private proxyAgent?: Dispatcher;
    private readonly ownedProxyAgent?: Dispatcher;
    private extraHeaders: Record<string, string>;
    private defaults: ChatDefaults;
    private readonly promptCacheKey?: string;
    private readonly log: Logger;
    constructor(options: ResponsesClientOptions) {
        this.log = scopeLogger(options.logger, 'responses');
        this.apiKey = options.apiKey;
        this.promptCacheKey = options.promptCacheKey?.trim() || undefined;
        this.model = options.model;
        this.baseURL = (options.baseURL || 'https://api.openai.com/v1').replace(/\/+$/, '');
        this.providerName = options.providerName || 'responses';
        this.supportsThinking = options.supportsThinking ?? true;
        this.ownedProxyAgent = options.dispatcher ? undefined : createProxyDispatcher(options.httpProxy);
        this.proxyAgent = options.dispatcher ?? this.ownedProxyAgent;
        this.extraHeaders = options.extraHeaders ?? {};
        this.defaults = options.defaults ?? {};
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
            upstreamRequestId: ResponsesClient.extractUpstreamRequestId(response),
            ...metadata,
        });
    }
    private async postResponses(body: Record<string, unknown>, signal: AbortSignal | undefined, streaming: boolean): Promise<Response> {
        signal?.throwIfAborted();
        const url = `${this.baseURL}/responses`;
        const headers = new Headers({
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.apiKey}`,
        });
        for (const [key, value] of Object.entries(this.extraHeaders)) {
            headers.set(key, value);
        }
        const requestInit: RequestInit = {
            method: 'POST',
            headers,
            body: JSON.stringify(body),
            signal,
        };
        if (this.proxyAgent) {
            (requestInit as Record<string, unknown>).dispatcher = this.proxyAgent;
        }
        const response = await fetch(url, requestInit);
        signal?.throwIfAborted();
        if (!response.ok) {
            const errorBody = await readBoundedErrorBody(response, signal);
            throw ResponsesClient.createHttpError(response, errorBody, streaming
                ? `Responses streaming API error: ${response.status} `
                : `Responses API error: ${response.status} ${response.statusText}. `);
        }
        return response;
    }
    async chat(request: LLMChatRequest): Promise<LLMChatResponse> {
        const providerMessages = new OpenAIAdapter('responses').fromStorage(request.messages, request.systemPrompt ?? '', this.model);
        const { tools, systemPrompt, onStreamDelta, signal } = request;
        const enableThinking = request.enableThinking ?? this.defaults.enableThinking;
        const maxTokens = request.maxTokens ?? this.defaults.maxOutputTokens;
        const effort = request.effort ?? this.defaults.effort;
        const input = this.convertMessages(providerMessages as OpenAIMessage[]);
        const responsesTools = tools?.map((t) => ({
            type: 'function' as const,
            name: t.name,
            description: t.description,
            parameters: t.inputSchema as Record<string, unknown>,
        }));
        const thinkingEnabled = enableThinking !== false && this.supportsThinking && effort !== 'none';
        const reasoning = thinkingEnabled
            ? {
                effort: (effort ?? 'medium') as Exclude<typeof effort, 'none' | undefined>,
            }
            : effort === 'none'
                ? { effort: 'none' as const }
                : undefined;
        const body: Record<string, unknown> = {
            model: this.model,
            input,
            max_output_tokens: maxTokens || 16384,
            store: false,
            include: ['reasoning.encrypted_content'],
        };
        if (this.promptCacheKey)
            body.prompt_cache_key = this.promptCacheKey;
        if (systemPrompt)
            body.instructions = systemPrompt;
        if (reasoning)
            body.reasoning = reasoning;
        if (responsesTools && responsesTools.length > 0) {
            body.tools = responsesTools;
            body.tool_choice = request.toolChoice === 'none' ? 'none' : 'auto';
        }
        if (onStreamDelta) {
            return this.chatStreaming(body, onStreamDelta, signal);
        }
        return this.chatNonStreaming(body, signal);
    }
    private async chatNonStreaming(body: Record<string, unknown>, signal?: AbortSignal): Promise<LLMChatResponse> {
        const response = await this.postResponses(body, signal, false);
        const upstreamRequestId = ResponsesClient.extractUpstreamRequestId(response);
        const data = (await response.json()) as ResponsesResponse;
        signal?.throwIfAborted();
        return this.parseResponse(data, {
            upstreamRequestId,
            upstreamCompletionId: data.id || null,
        });
    }
    private async chatStreaming(body: Record<string, unknown>, onStreamDelta: (delta: StreamDelta) => void, signal?: AbortSignal): Promise<LLMChatResponse> {
        const transportController = new AbortController();
        const transportSignal = signal
            ? AbortSignal.any([signal, transportController.signal])
            : transportController.signal;
        const response = await this.postResponses({ ...body, stream: true }, transportSignal, true);
        const upstreamRequestId = ResponsesClient.extractUpstreamRequestId(response);
        const sseController = new AbortController();
        const events = _iterSSEMessages(response as never, sseController);
        let responseId = '';
        let content = '';
        let refusalText = '';
        let reasoning = '';
        let usage: ResponsesUsage | undefined;
        let terminalStatus: string | undefined;
        let incompleteReason: string | undefined;
        let sawTerminalEvent = false;
        const functionCallsByIndex = new Map<number, {
            id?: string;
            call_id: string;
            name: string;
            arguments: string;
            started?: boolean;
        }>();
        const doneItemsByIndex = new Map<number, ResponsesOutputItem>();
        const unindexedDoneItems: ResponsesOutputItem[] = [];
        let completedOutputItems: ResponsesOutputItem[] | undefined;
        let lastFcOutputIndex = -1;
        const protocolError = (message: string) => new OpenAIStreamProtocolError(message, {
            upstreamRequestId,
            upstreamCompletionId: responseId || null,
        });
        const stopSource = () => {
            sseController.abort();
            transportController.abort();
            void events.return(undefined).catch(() => { });
            void response.body?.cancel().catch(() => { });
        };
        try {
            while (true) {
                signal?.throwIfAborted();
                const next = await events.next();
                signal?.throwIfAborted();
                if (next.done)
                    break;
                const rawData = next.value.data?.trim();
                if (!rawData || rawData === '[DONE]')
                    continue;
                let event: Record<string, any>;
                try {
                    event = JSON.parse(rawData);
                }
                catch {
                    throw protocolError('Invalid JSON in upstream Responses SSE event');
                }
                if (!event || typeof event !== 'object' || Array.isArray(event)) {
                    throw protocolError('Invalid upstream Responses SSE event shape');
                }
                const type = (typeof event.type === 'string' && event.type) || next.value.event || '';
                if (typeof event.response?.id === 'string' && event.response.id) {
                    responseId = event.response.id;
                }
                if (type === 'error' ||
                    type === 'response.failed' ||
                    type === 'response.error' ||
                    (event.error && typeof event.error === 'object') ||
                    (event.response?.error && typeof event.response.error === 'object')) {
                    const errObj = (event.response?.error && typeof event.response.error === 'object'
                        ? event.response.error
                        : undefined) ??
                        (event.error && typeof event.error === 'object' ? event.error : undefined) ??
                        event;
                    const code = errObj.code ?? 'unknown';
                    const message = typeof errObj.message === 'string'
                        ? errObj.message
                        : 'Upstream stream error';
                    throw new UpstreamStreamError(`Upstream LLM error in stream (code=${code}): ${sanitizeUpstreamErrorBody(message)}`, {
                        ...parseUpstreamErrorMetadata(errObj),
                        upstreamRequestId,
                        upstreamCompletionId: responseId || null,
                    });
                }
                switch (type) {
                    case 'response.output_text.delta': {
                        const delta = event.delta as string;
                        if (delta) {
                            content += delta;
                            onStreamDelta({ type: 'text', content: delta });
                        }
                        break;
                    }
                    case 'response.refusal.delta': {
                        const delta = event.delta as string;
                        if (delta) {
                            refusalText += delta;
                        }
                        break;
                    }
                    case 'response.reasoning_summary_text.delta':
                    case 'response.reasoning_text.delta': {
                        const delta = event.delta as string;
                        if (delta) {
                            reasoning += delta;
                            onStreamDelta({ type: 'thinking', content: delta });
                        }
                        break;
                    }
                    case 'response.output_item.added': {
                        const item = event.item as Record<string, any> | undefined;
                        const outputIndex = typeof event.output_index === 'number'
                            ? event.output_index
                            : functionCallsByIndex.size;
                        if (item?.type === 'function_call') {
                            lastFcOutputIndex = outputIndex;
                            const callId = typeof item.call_id === 'string' ? item.call_id : '';
                            const name = typeof item.name === 'string' ? item.name : '';
                            const fcState = {
                                id: typeof item.id === 'string' ? item.id : undefined,
                                call_id: callId,
                                name,
                                arguments: typeof item.arguments === 'string' ? item.arguments : '',
                                started: false,
                            };
                            if (callId && name) {
                                fcState.started = true;
                                onStreamDelta({
                                    type: 'tool_input_start',
                                    content: '',
                                    toolCallId: callId,
                                    toolName: name,
                                });
                            }
                            functionCallsByIndex.set(outputIndex, fcState);
                        }
                        break;
                    }
                    case 'response.function_call_arguments.delta': {
                        const delta = event.delta as string;
                        const outputIndex = typeof event.output_index === 'number' ? event.output_index : lastFcOutputIndex;
                        const call = functionCallsByIndex.get(outputIndex);
                        if (delta && call) {
                            call.arguments += delta;
                            if (call.call_id && call.name && !call.started) {
                                call.started = true;
                                onStreamDelta({
                                    type: 'tool_input_start',
                                    content: '',
                                    toolCallId: call.call_id,
                                    toolName: call.name,
                                });
                            }
                            if (call.call_id) {
                                onStreamDelta({
                                    type: 'tool_input_delta',
                                    content: delta,
                                    toolCallId: call.call_id,
                                    toolName: call.name,
                                    partialJson: delta,
                                });
                            }
                        }
                        break;
                    }
                    case 'response.output_item.done': {
                        const item = event.item as Record<string, any> | undefined;
                        const outputIndex = typeof event.output_index === 'number' ? event.output_index : undefined;
                        if (item && typeof item === 'object') {
                            if (outputIndex !== undefined) {
                                doneItemsByIndex.set(outputIndex, item as ResponsesOutputItem);
                            }
                            else {
                                unindexedDoneItems.push(item as ResponsesOutputItem);
                            }
                            if (item.type === 'function_call') {
                                const callId = typeof item.call_id === 'string' ? item.call_id : '';
                                let target = outputIndex !== undefined ? functionCallsByIndex.get(outputIndex) : undefined;
                                if (!target && callId) {
                                    for (const fc of functionCallsByIndex.values()) {
                                        if (fc.call_id === callId) {
                                            target = fc;
                                            break;
                                        }
                                    }
                                }
                                if (target) {
                                    if (typeof item.id === 'string' && item.id)
                                        target.id = item.id;
                                    if (callId)
                                        target.call_id = callId;
                                    if (typeof item.name === 'string' && item.name)
                                        target.name = item.name;
                                    if (typeof item.arguments === 'string' && item.arguments) {
                                        target.arguments = item.arguments;
                                    }
                                }
                                else if (callId && typeof item.name === 'string') {
                                    const idx = outputIndex ?? functionCallsByIndex.size;
                                    functionCallsByIndex.set(idx, {
                                        id: typeof item.id === 'string' ? item.id : undefined,
                                        call_id: callId,
                                        name: item.name,
                                        arguments: typeof item.arguments === 'string' ? item.arguments : '',
                                        started: true,
                                    });
                                }
                            }
                        }
                        break;
                    }
                    case 'response.completed':
                    case 'response.incomplete':
                    case 'response.done': {
                        sawTerminalEvent = true;
                        const resp = event.response as ResponsesResponse | undefined;
                        if (resp?.id)
                            responseId = resp.id;
                        if (resp?.usage)
                            usage = resp.usage;
                        if (resp?.status)
                            terminalStatus = resp.status;
                        else if (type === 'response.incomplete')
                            terminalStatus = 'incomplete';
                        else
                            terminalStatus = 'completed';
                        if (resp?.incomplete_details?.reason) {
                            incompleteReason = resp.incomplete_details.reason;
                        }
                        if (Array.isArray(resp?.output) && resp.output.length > 0) {
                            completedOutputItems = resp.output;
                        }
                        break;
                    }
                }
            }
        }
        finally {
            stopSource();
        }
        if (!sawTerminalEvent) {
            throw protocolError('Upstream Responses stream interrupted before terminal event');
        }
        const orderedOutputItems: ResponsesOutputItem[] = completedOutputItems && completedOutputItems.length > 0
            ? completedOutputItems
            : [
                ...[...doneItemsByIndex.entries()]
                    .sort((a, b) => a[0] - b[0])
                    .map(([, item]) => item),
                ...unindexedDoneItems,
            ];
        if (!reasoning && orderedOutputItems.length > 0) {
            const summaries: string[] = [];
            for (const item of orderedOutputItems) {
                if (item && typeof item === 'object' && (item as {
                    type?: unknown;
                }).type === 'reasoning') {
                    const r = item as ResponsesReasoningOutput;
                    if (Array.isArray(r.summary)) {
                        for (const s of r.summary) {
                            if (s?.type === 'summary_text' && typeof s.text === 'string' && s.text) {
                                summaries.push(s.text);
                            }
                        }
                    }
                }
            }
            if (summaries.length > 0)
                reasoning = summaries.join('');
        }
        if (!content && !refusalText && orderedOutputItems.length > 0) {
            const texts: string[] = [];
            const refusals: string[] = [];
            for (const item of orderedOutputItems) {
                if (item && typeof item === 'object' && (item as {
                    type?: unknown;
                }).type === 'message') {
                    const msg = item as ResponsesMessageOutput;
                    if (Array.isArray(msg.content)) {
                        for (const part of msg.content) {
                            if (part?.type === 'output_text' && typeof part.text === 'string') {
                                texts.push(part.text);
                            }
                            else if (part?.type === 'refusal' && typeof part.refusal === 'string') {
                                refusals.push(part.refusal);
                            }
                        }
                    }
                }
            }
            if (texts.length > 0)
                content = texts.join('');
            if (refusals.length > 0)
                refusalText = refusals.join('');
        }
        const upstreamMeta: UpstreamRequestMeta = {
            upstreamRequestId,
            upstreamCompletionId: responseId || null,
        };
        const sortedFcEntries = [...functionCallsByIndex.entries()].sort((a, b) => a[0] - b[0]);
        const toolCalls: LLMToolCall[] = [];
        const normalizedArgsByCallId = new Map<string, string>();
        let firstMalformed: {
            id: string;
            name: string;
            raw: string;
        } | undefined;
        for (const [, fc] of sortedFcEntries) {
            if (!fc.call_id || !fc.name)
                continue;
            const rawArgs = fc.arguments || '{}';
            const validated = ResponsesClient.validateOrRepairToolArguments(fc.call_id, fc.name, rawArgs);
            if (validated.malformedError && !firstMalformed) {
                firstMalformed = { id: fc.call_id, name: fc.name, raw: rawArgs };
            }
            normalizedArgsByCallId.set(fc.call_id, validated.arguments);
            toolCalls.push({
                id: fc.call_id,
                name: fc.name,
                arguments: validated.arguments,
                ...(validated.malformedError ? { malformedError: validated.malformedError } : {}),
            });
        }
        if (toolCalls.length > 0) {
            this.log.info({
                model: this.model,
                toolCalls: toolCalls.map((tc) => ({
                    id: tc.id,
                    name: tc.name,
                    argsLength: tc.arguments.length,
                    argsPreview: tc.arguments.substring(0, 200),
                })),
            }, '🔧 Responses streaming tool calls parsed');
        }
        const sanitizedOutputItems = orderedOutputItems.map((item) => {
            if (item &&
                typeof item === 'object' &&
                (item as {
                    type?: unknown;
                }).type === 'function_call' &&
                typeof (item as {
                    call_id?: unknown;
                }).call_id === 'string') {
                const callId = (item as {
                    call_id: string;
                }).call_id;
                const normalizedArgs = normalizedArgsByCallId.get(callId);
                if (normalizedArgs !== undefined) {
                    return { ...item, arguments: normalizedArgs } as ResponsesOutputItem;
                }
            }
            return item;
        });
        const reasoningDetails = ResponsesClient.extractReplayableOutputItems(sanitizedOutputItems);
        const hasToolCalls = toolCalls.length > 0;
        const isContentFilterIncomplete = terminalStatus === 'incomplete' && incompleteReason === 'content_filter';
        const isRefusal = !content && !hasToolCalls && (refusalText.length > 0 || isContentFilterIncomplete);
        const isMaxTokens = !hasToolCalls &&
            !isRefusal &&
            terminalStatus === 'incomplete';
        const assembledResponse: LLMChatResponse = {
            content: content || (isRefusal ? refusalText || 'Response blocked by content filter.' : null),
            toolCalls: hasToolCalls ? toolCalls : undefined,
            reasoning: reasoning || undefined,
            ...(reasoningDetails ? { reasoningDetails } : {}),
            stopReason: hasToolCalls
                ? 'tool_use'
                : isRefusal
                    ? 'refusal'
                    : isMaxTokens
                        ? 'max_tokens'
                        : 'end_turn',
            usage: usage
                ? {
                    promptTokens: usage.input_tokens || 0,
                    completionTokens: usage.output_tokens || 0,
                    cachedTokens: usage.input_tokens_details?.cached_tokens,
                    reasoningTokens: usage.output_tokens_details?.reasoning_tokens,
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
    private static validateOrRepairToolArguments(callId: string, name: string, rawArgs: string): {
        arguments: string;
        malformedError?: string;
    } {
        try {
            const parsed = JSON.parse(rawArgs);
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                return { arguments: rawArgs };
            }
        }
        catch {
        }
        if (rawArgs.trim() !== '') {
            const repaired = repairToolInputJson(rawArgs, { allowAutoclose: false });
            if (repaired) {
                return { arguments: repaired.repairedJson };
            }
        }
        const preview = rawArgs.length > 200 ? rawArgs.slice(0, 200) + '...' : rawArgs;
        return {
            arguments: '{}',
            malformedError: `tool_call.arguments not valid JSON for tool=${name} id=${callId} ` +
                `(length=${rawArgs.length}): ${JSON.stringify(preview)}`,
        };
    }
    private static extractReplayableOutputItems(output: readonly ResponsesOutputItem[]): unknown[] | undefined {
        if (!Array.isArray(output) || output.length === 0)
            return undefined;
        const hasReasoningItem = output.some((item) => item &&
            typeof item === 'object' &&
            (item as {
                type?: unknown;
            }).type === 'reasoning');
        if (!hasReasoningItem)
            return undefined;
        return output.filter(isResponsesReplayItem);
    }
    private convertMessages(messages: OpenAIMessage[]): ResponsesInputItem[] {
        const result: ResponsesInputItem[] = [];
        for (let i = 0; i < messages.length; i++) {
            const msg = messages[i];
            if (msg.role === 'system') {
                result.push({
                    type: 'message',
                    role: 'system',
                    content: normalizeMessageContent('system', msg.content, i),
                });
            }
            else if (msg.role === 'user') {
                result.push({
                    type: 'message',
                    role: 'user',
                    content: normalizeMessageContent('user', msg.content, i),
                });
            }
            else if (msg.role === 'assistant') {
                const replayItems = Array.isArray(msg.reasoning_details) &&
                    msg.reasoning_details.length > 0 &&
                    msg.reasoning_details.every(isResponsesReplayItem)
                    ? (msg.reasoning_details as Record<string, unknown>[])
                    : null;
                if (replayItems) {
                    const hasStoredReasoning = replayItems.some((item) => item.type === 'reasoning');
                    const hasStoredMessage = replayItems.some((item) => item.type === 'message');
                    const hasStoredToolCall = replayItems.some((item) => item.type === 'function_call' || item.type === 'custom_tool_call');
                    if (!hasStoredReasoning && msg.reasoning_content) {
                        result.push({
                            type: 'reasoning',
                            summary: [{ type: 'summary_text', text: msg.reasoning_content }],
                        });
                    }
                    if (!hasStoredMessage && msg.content) {
                        result.push({
                            type: 'message',
                            role: 'assistant',
                            content: normalizeMessageContent('assistant', msg.content, i),
                        });
                    }
                    if (!hasStoredToolCall && msg.tool_calls) {
                        for (const tc of msg.tool_calls) {
                            result.push({
                                type: 'function_call',
                                call_id: tc.id,
                                name: tc.function.name,
                                arguments: tc.function.arguments?.trim() ? tc.function.arguments : '{}',
                                status: 'completed',
                            });
                        }
                    }
                    for (const rawItem of replayItems) {
                        const itemType = rawItem.type;
                        if (itemType === 'reasoning') {
                            const summary = Array.isArray(rawItem.summary)
                                ? rawItem.summary
                                : [];
                            const replayedReasoning: ResponsesReasoningItem = {
                                type: 'reasoning',
                                ...(typeof rawItem.id === 'string' && rawItem.id ? { id: rawItem.id } : {}),
                                ...(typeof rawItem.encrypted_content === 'string' && rawItem.encrypted_content
                                    ? { encrypted_content: rawItem.encrypted_content }
                                    : {}),
                                summary: summary as Array<{
                                    type: 'summary_text';
                                    text: string;
                                }>,
                            };
                            result.push(replayedReasoning);
                        }
                        else if (itemType === 'message') {
                            result.push({
                                type: 'message',
                                ...(typeof rawItem.id === 'string' && rawItem.id ? { id: rawItem.id } : {}),
                                role: 'assistant',
                                content: Array.isArray(rawItem.content)
                                    ? (rawItem.content as ResponsesInputContentPart[])
                                    : typeof rawItem.content === 'string'
                                        ? rawItem.content
                                        : '',
                            });
                        }
                        else if (itemType === 'function_call') {
                            result.push({
                                type: 'function_call',
                                ...(typeof rawItem.id === 'string' && rawItem.id ? { id: rawItem.id } : {}),
                                call_id: typeof rawItem.call_id === 'string' ? rawItem.call_id : '',
                                name: typeof rawItem.name === 'string' ? rawItem.name : '',
                                arguments: typeof rawItem.arguments === 'string' && rawItem.arguments.trim() !== ''
                                    ? rawItem.arguments
                                    : '{}',
                                status: 'completed',
                            });
                        }
                        else if (itemType === 'configuration_update') {
                            const effort = extractConfigurationUpdateEffort(rawItem);
                            if (effort) {
                                result.push({
                                    type: 'configuration_update',
                                    reasoning: { effort },
                                });
                            }
                        }
                        else {
                            result.push({ ...rawItem });
                        }
                    }
                    continue;
                }
                if (msg.reasoning_content) {
                    result.push({
                        type: 'reasoning',
                        summary: [{ type: 'summary_text', text: msg.reasoning_content }],
                    });
                }
                if (msg.content) {
                    result.push({
                        type: 'message',
                        role: 'assistant',
                        content: normalizeMessageContent('assistant', msg.content, i),
                    });
                }
                if (msg.tool_calls) {
                    for (const tc of msg.tool_calls) {
                        result.push({
                            type: 'function_call',
                            call_id: tc.id,
                            name: tc.function.name,
                            arguments: tc.function.arguments?.trim() ? tc.function.arguments : '{}',
                            status: 'completed',
                        });
                    }
                }
            }
            else if (msg.role === 'tool') {
                result.push({
                    type: 'function_call_output',
                    call_id: msg.tool_call_id || '',
                    output: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content ?? ''),
                });
            }
        }
        return result;
    }
    private parseResponse(response: ResponsesResponse, upstreamMeta: UpstreamRequestMeta = { upstreamRequestId: null, upstreamCompletionId: null }): LLMChatResponse {
        if (response.error && typeof response.error === 'object') {
            const code = response.error.code ?? 'unknown';
            const message = typeof response.error.message === 'string'
                ? response.error.message
                : 'Upstream response error';
            throw new UpstreamStreamError(`Upstream LLM error in response (code=${code}): ${sanitizeUpstreamErrorBody(message)}`, {
                ...parseUpstreamErrorMetadata(response.error),
                upstreamRequestId: upstreamMeta.upstreamRequestId,
                upstreamCompletionId: upstreamMeta.upstreamCompletionId,
            });
        }
        let content: string | null = null;
        let refusalText = '';
        const reasoningParts: string[] = [];
        const toolCalls: LLMToolCall[] = [];
        const normalizedArgsByCallId = new Map<string, string>();
        let firstMalformed: {
            id: string;
            name: string;
            raw: string;
        } | undefined;
        const outputItems = Array.isArray(response.output) ? response.output : [];
        for (const item of outputItems) {
            if (!item || typeof item !== 'object')
                continue;
            switch ((item as {
                type?: unknown;
            }).type) {
                case 'message': {
                    const msg = item as ResponsesMessageOutput;
                    if (Array.isArray(msg.content) && msg.content.length > 0) {
                        const textChunk = msg.content
                            .filter((c) => c.type === 'output_text' && typeof c.text === 'string')
                            .map((c) => c.text)
                            .join('');
                        if (textChunk) {
                            content = (content ?? '') + textChunk;
                        }
                        const refusalChunk = msg.content
                            .filter((c) => c.type === 'refusal' && typeof c.refusal === 'string')
                            .map((c) => c.refusal)
                            .join('');
                        if (refusalChunk) {
                            refusalText += refusalChunk;
                        }
                    }
                    break;
                }
                case 'function_call': {
                    const fc = item as ResponsesFunctionCallItem;
                    const rawArgs = fc.arguments || '{}';
                    const validated = ResponsesClient.validateOrRepairToolArguments(fc.call_id, fc.name, rawArgs);
                    if (validated.malformedError && !firstMalformed) {
                        firstMalformed = { id: fc.call_id, name: fc.name, raw: rawArgs };
                    }
                    normalizedArgsByCallId.set(fc.call_id, validated.arguments);
                    toolCalls.push({
                        id: fc.call_id,
                        name: fc.name,
                        arguments: validated.arguments,
                        ...(validated.malformedError ? { malformedError: validated.malformedError } : {}),
                    });
                    break;
                }
                case 'reasoning': {
                    const r = item as ResponsesReasoningOutput;
                    if (Array.isArray(r.summary) && r.summary.length > 0) {
                        const text = r.summary
                            .filter((s) => s?.type === 'summary_text' && typeof s.text === 'string')
                            .map((s) => s.text)
                            .join('');
                        if (text)
                            reasoningParts.push(text);
                    }
                    break;
                }
            }
        }
        const sanitizedOutputItems = outputItems.map((item) => {
            if (item &&
                typeof item === 'object' &&
                (item as {
                    type?: unknown;
                }).type === 'function_call' &&
                typeof (item as {
                    call_id?: unknown;
                }).call_id === 'string') {
                const callId = (item as {
                    call_id: string;
                }).call_id;
                const normalizedArgs = normalizedArgsByCallId.get(callId);
                if (normalizedArgs !== undefined) {
                    return { ...item, arguments: normalizedArgs } as ResponsesOutputItem;
                }
            }
            return item;
        });
        const reasoning = reasoningParts.length > 0 ? reasoningParts.join('') : undefined;
        const reasoningDetails = ResponsesClient.extractReplayableOutputItems(sanitizedOutputItems);
        const hasToolCalls = toolCalls.length > 0;
        const isContentFilterIncomplete = response.status === 'incomplete' &&
            response.incomplete_details?.reason === 'content_filter';
        const isRefusal = !content && !hasToolCalls && (refusalText.length > 0 || isContentFilterIncomplete);
        const isMaxTokens = !hasToolCalls &&
            !isRefusal &&
            response.status === 'incomplete';
        const assembledResponse: LLMChatResponse = {
            content: content ?? (isRefusal ? refusalText || 'Response blocked by content filter.' : null),
            toolCalls: hasToolCalls ? toolCalls : undefined,
            reasoning,
            ...(reasoningDetails ? { reasoningDetails } : {}),
            stopReason: hasToolCalls
                ? 'tool_use'
                : isRefusal
                    ? 'refusal'
                    : isMaxTokens
                        ? 'max_tokens'
                        : 'end_turn',
            usage: response.usage
                ? {
                    promptTokens: response.usage.input_tokens || 0,
                    completionTokens: response.usage.output_tokens || 0,
                    cachedTokens: response.usage.input_tokens_details?.cached_tokens,
                    reasoningTokens: response.usage.output_tokens_details?.reasoning_tokens,
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
}
