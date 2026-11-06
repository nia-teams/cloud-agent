import { AnthropicAdapter } from '../adapters/anthropic.js';
import Anthropic from '@anthropic-ai/sdk';
import { scopeLogger, type Logger } from '../logger.js';
import { repairToolInputJson } from './tool-input-repair.js';
import type { ILLMClient, LLMChatRequest, LLMChatResponse, LLMToolCall, StreamDelta, ChatDefaults, } from '../types.js';
const CACHE_BREAKPOINT: Anthropic.CacheControlEphemeral = Object.freeze({ type: 'ephemeral' });
// Retry only a precisely recognized parameter rejection; never retry caller cancellation or a partial stream.
function withoutRootCacheOnParameterError(params: Anthropic.MessageCreateParams, error: unknown, signal?: AbortSignal): Anthropic.MessageCreateParams | undefined {
    if (signal?.aborted ||
        !(error instanceof Anthropic.APIError) ||
        (error.status !== 403 && error.status !== 400)) {
        return;
    }
    const body = error.error as {
        error?: {
            code?: unknown;
            type?: unknown;
            message?: unknown;
        };
        code?: unknown;
        type?: unknown;
        message?: unknown;
    } | undefined;
    const upstream = body?.error ?? body;
    const isObservedUpstreamSignature = (error.status === 403 && (upstream?.code === '403001' || upstream?.code === 403001)) ||
        (error.status === 400 && upstream?.type === 'AccessDeniedException');
    const parameterMessage = /^Invalid request parameters\. Please check your input and try again\.(?: \(request id: [A-Za-z0-9]+\))?(?![\s\S])/;
    if (!isObservedUpstreamSignature ||
        typeof upstream?.message !== 'string' ||
        !parameterMessage.test(upstream.message)) {
        return;
    }
    const { cache_control, ...retryParams } = params as Anthropic.MessageCreateParams & {
        cache_control?: Anthropic.CacheControlEphemeral;
    };
    return cache_control ? retryParams : undefined;
}
const INVALID_THINKING_SIGNATURE_MESSAGE = /(?:^|[\s"':])(?:messages\.\d+\.|\*\*\*\.\*\*\*\.)?content\.\d+: Invalid `signature` in `thinking` block(?:\.|\b)/;
// Signed thinking blocks must normally replay verbatim. On an explicit invalid-signature rejection, remove them once.
function withoutThinkingBlocksOnSignatureError(params: Anthropic.MessageCreateParams, error: unknown, signal?: AbortSignal): Anthropic.MessageCreateParams | undefined {
    if (signal?.aborted || !(error instanceof Anthropic.APIError) || error.status !== 400)
        return;
    const body = error.error as {
        error?: {
            message?: unknown;
        };
        message?: unknown;
    } | undefined;
    const upstream = body?.error ?? body;
    const message = typeof upstream?.message === 'string' ? upstream.message : error.message;
    if (typeof message !== 'string' || !INVALID_THINKING_SIGNATURE_MESSAGE.test(message))
        return;
    let stripped = false;
    const cleanedMessages: Anthropic.MessageParam[] = [];
    for (const msg of params.messages) {
        if (!Array.isArray(msg.content)) {
            cleanedMessages.push(msg);
            continue;
        }
        const filtered = msg.content.filter((block) => {
            if (block && typeof block === 'object' && 'type' in block && block.type === 'thinking') {
                stripped = true;
                return false;
            }
            return true;
        });
        if (filtered.length === 0) {
            stripped = true;
            continue;
        }
        cleanedMessages.push(filtered.length !== msg.content.length ? { ...msg, content: filtered } : msg);
    }
    if (!stripped)
        return;
    const mergedMessages: Anthropic.MessageParam[] = [];
    for (const msg of cleanedMessages) {
        const prev = mergedMessages[mergedMessages.length - 1];
        if (prev &&
            prev.role === msg.role &&
            (msg.role === 'user' || msg.role === 'assistant')) {
            const prevBlocks = Array.isArray(prev.content)
                ? prev.content
                : [{ type: 'text' as const, text: prev.content }];
            const msgBlocks = Array.isArray(msg.content)
                ? msg.content
                : [{ type: 'text' as const, text: msg.content }];
            mergedMessages[mergedMessages.length - 1] = {
                ...prev,
                content: [...prevBlocks, ...msgBlocks],
            };
        }
        else {
            mergedMessages.push(msg);
        }
    }
    return {
        ...params,
        messages: mergedMessages,
    };
}
function stripCacheControl(messages: Anthropic.MessageParam[]): Anthropic.MessageParam[] {
    return messages.map((msg) => {
        if (typeof msg.content === 'string')
            return msg;
        if (!Array.isArray(msg.content))
            return msg;
        let dirty = false;
        const cleaned = msg.content.map((block) => {
            if (block && typeof block === 'object' && 'cache_control' in block) {
                dirty = true;
                const { cache_control: _omit, ...rest } = block as unknown as Record<string, unknown>;
                return rest as unknown as typeof block;
            }
            return block;
        });
        return dirty ? { ...msg, content: cleaned } : msg;
    });
}
export interface AnthropicClientOptions {
    extraHeaders?: Record<string, string>;
    logger?: Logger;
    apiKey: string;
    model: string;
    baseURL?: string;
    anthropicBeta?: string;
    sessionId?: string;
    onRequestDump?: (info: {
        sessionId: string;
        reason: 'stream_error' | 'stream_incomplete' | 'empty_response';
        error: string;
        streamedThinking: string;
        streamedText: string;
        streamedToolInputs?: Array<{
            id: string;
            name: string;
            partialJson: string;
        }>;
        request: unknown;
        rawMessage?: unknown;
    }) => void | Promise<void>;
    defaults?: ChatDefaults;
    /** Enable native mid-conversation tool additions/removals only when the endpoint supports them. */
    supportsMidConversationTools?: boolean;
    /** Endpoint supports lazy tool schemas via defer_loading. */
    supportsDeferLoading?: boolean;
    /** Caller override: send all tool schemas even if the endpoint supports deferral. */
    disableToolDeferral?: boolean;
}
type AnthropicLike = Anthropic;
const MID_CONVERSATION_TOOL_CHANGES_BETA = 'mid-conversation-tool-changes-2026-07-01';
export class AnthropicClient implements ILLMClient {
    private client: AnthropicLike;
    private model: string;
    private sessionId?: string;
    private onRequestDump?: AnthropicClientOptions['onRequestDump'];
    private defaults: ChatDefaults;
    private supportsMidConversationTools: boolean;
    private supportsDeferLoading: boolean;
    private disableToolDeferral: boolean;
    private readonly log: Logger;
    constructor(options: AnthropicClientOptions) {
        this.log = scopeLogger(options.logger, 'anthropic-client');
        const headers: Record<string, string> = { ...options.extraHeaders };
        if (options.anthropicBeta) {
            headers['anthropic-beta'] = options.anthropicBeta;
        }
        this.client = new Anthropic({
            maxRetries: 0,
            apiKey: options.apiKey,
            authToken: null,
            webhookKey: null,
            logLevel: 'off',
            baseURL: options.baseURL || 'https://api.anthropic.com',
            ...(Object.keys(headers).length ? { defaultHeaders: headers } : {}),
        });
        this.model = options.model;
        this.sessionId = options.sessionId;
        this.onRequestDump = options.onRequestDump;
        this.defaults = options.defaults ?? {};
        this.supportsMidConversationTools = options.supportsMidConversationTools ?? false;
        this.supportsDeferLoading = options.supportsDeferLoading ?? false;
        this.disableToolDeferral = options.disableToolDeferral ?? false;
    }
    async chat(request: LLMChatRequest): Promise<LLMChatResponse> {
        const providerMessages = new AnthropicAdapter().fromStorage(request.messages, request.systemPrompt ?? '', this.model, { supportsMidConversationTools: this.supportsMidConversationTools });
        const { tools, systemPrompt, onStreamDelta, signal, } = request;
        const enableThinking = request.enableThinking ?? this.defaults.enableThinking;
        const thinkingBudget = request.thinkingBudget ?? this.defaults.thinkingBudget;
        const thinkingType = request.thinkingType ?? this.defaults.thinkingType;
        const effort = request.effort ?? this.defaults.effort;
        let maxTokens = request.maxTokens ?? this.defaults.maxOutputTokens;
        const NON_STREAMING_MAX_TOKENS_CAP = 16384;
        if (!onStreamDelta && maxTokens && maxTokens > NON_STREAMING_MAX_TOKENS_CAP && request.maxTokens === undefined) {
            this.log.debug({
                sessionId: this.sessionId,
                model: this.model,
                configuredMax: maxTokens,
                cappedMax: NON_STREAMING_MAX_TOKENS_CAP,
            }, 'Non-streaming call: capping maxOutputTokens to avoid Anthropic SDK 10-min timeout error');
            maxTokens = NON_STREAMING_MAX_TOKENS_CAP;
        }
        const rawMessages = providerMessages as Anthropic.MessageParam[];
        const hasMidConversationSystemMessage = rawMessages.some((m) => m.role === 'system');
        if (hasMidConversationSystemMessage && !this.supportsMidConversationTools) {
            throw new Error(`Model "${this.model}" received a mid-conversation system message, but supportsMidConversationTools is not enabled. Enable it only for endpoints supporting tool changes; otherwise recompute the tools array on the next call.`);
        }
        const params: Anthropic.MessageCreateParams = {
            model: this.model,
            max_tokens: maxTokens || 16384,
            messages: stripCacheControl(rawMessages),
        };
        if (systemPrompt) {
            params.system = [{
                    type: 'text',
                    text: systemPrompt,
                    cache_control: CACHE_BREAKPOINT,
                }];
        }
        if (tools && tools.length > 0) {
            const supportsEagerStreaming = this.model.includes('opus');
            const shouldDefer = this.supportsDeferLoading && !this.disableToolDeferral;
            const deferredFlags = tools.map((t) => shouldDefer && !!t.deferLoading);
            let lastNonDeferredIdx = -1;
            for (let i = deferredFlags.length - 1; i >= 0; i--) {
                if (!deferredFlags[i]) {
                    lastNonDeferredIdx = i;
                    break;
                }
            }
            params.tools = tools.map((t, i) => ({
                name: t.name,
                description: t.description,
                input_schema: t.inputSchema as Anthropic.Tool['input_schema'],
                ...(supportsEagerStreaming ? { eager_input_streaming: true } : {}),
                ...(deferredFlags[i] ? { defer_loading: true } : {}),
                ...(i === lastNonDeferredIdx ? { cache_control: CACHE_BREAKPOINT } : {}),
            }));
        }
        if (enableThinking) {
            if (thinkingType === 'adaptive') {
                params.thinking = { type: 'adaptive' };
            }
            else {
                params.thinking = {
                    type: 'enabled',
                    budget_tokens: thinkingBudget || 10000,
                };
            }
        }
        if (effort && effort !== 'none') {
            (params as unknown as Record<string, unknown>).output_config = { effort };
        }
        this.addMessageCacheBreakpoints(params.messages as Anthropic.MessageParam[]);
        // Allocate at most four cache breakpoints across the root, system, tools, and message tail.
        (params as unknown as Record<string, unknown>).cache_control = CACHE_BREAKPOINT;
        const requestOptions: {
            signal?: AbortSignal;
            headers?: Record<string, string>;
        } = { signal };
        if (hasMidConversationSystemMessage) {
            requestOptions.headers = { 'anthropic-beta': MID_CONVERSATION_TOOL_CHANGES_BETA };
        }
        if (onStreamDelta) {
            return this.chatStreaming(params, onStreamDelta, signal, requestOptions.headers);
        }
        let currentParams: Anthropic.MessageCreateParams = params;
        let message: Anthropic.Message;
        while (true) {
            try {
                message = await this.client.messages.create(currentParams, requestOptions) as Anthropic.Message;
                break;
            }
            catch (error) {
                const retryParams: Anthropic.MessageCreateParams | undefined = withoutRootCacheOnParameterError(currentParams, error, signal) ??
                    withoutThinkingBlocksOnSignatureError(currentParams, error, signal);
                if (!retryParams)
                    throw error;
                currentParams = retryParams;
            }
        }
        const parsed = this.parseResponse(message);
        this.maybeDumpEmptyResponse(currentParams, message, parsed);
        return parsed;
    }
    private addMessageCacheBreakpoints(messages: Anthropic.MessageParam[]): void {
        let userMsgCount = 0;
        let targetIdx = -1;
        for (let i = messages.length - 1; i >= 0; i--) {
            if (messages[i].role === 'user') {
                userMsgCount++;
                if (userMsgCount === 2) {
                    targetIdx = i;
                    break;
                }
            }
        }
        if (targetIdx < 0)
            return;
        const msg = messages[targetIdx];
        if (typeof msg.content === 'string') {
            messages[targetIdx] = {
                ...msg,
                content: [{
                        type: 'text' as const,
                        text: msg.content,
                        cache_control: CACHE_BREAKPOINT,
                    }],
            };
        }
        else if (Array.isArray(msg.content) && msg.content.length > 0) {
            const blocks = msg.content.map((block, i) => {
                if (i === msg.content.length - 1) {
                    return { ...block, cache_control: CACHE_BREAKPOINT } as typeof block;
                }
                return block;
            });
            messages[targetIdx] = { ...msg, content: blocks };
        }
    }
    private async chatStreaming(params: Anthropic.MessageCreateParams, onStreamDelta: (delta: StreamDelta) => void, signal?: AbortSignal, extraHeaders?: Record<string, string>): Promise<LLMChatResponse> {
        const streamStartMs = performance.now();
        let firstChunkMs: number | undefined;
        const markFirstChunk = () => {
            if (firstChunkMs === undefined)
                firstChunkMs = performance.now();
        };
        const stream = this.client.messages.stream(params, {
            signal,
            ...(extraHeaders ? { headers: extraHeaders } : {}),
        });
        let streamError: Error | undefined;
        let streamConnected = false;
        let receivedStreamEvent = false;
        stream.on('connect', () => { streamConnected = true; });
        let streamedThinking = '';
        let streamedText = '';
        const streamedToolInputs = new Map<number, {
            id: string;
            name: string;
            json: string;
        }>();
        stream.on('error', (err: Error) => {
            streamError = err;
            this.log.error({ err, sessionId: this.sessionId }, 'Anthropic stream error');
        });
        stream.on('thinking', (thinkingDelta) => {
            markFirstChunk();
            streamedThinking += thinkingDelta;
            onStreamDelta({ type: 'thinking', content: thinkingDelta });
        });
        stream.on('text', (textDelta) => {
            markFirstChunk();
            streamedText += textDelta;
            onStreamDelta({ type: 'text', content: textDelta });
        });
        stream.on('streamEvent', (event) => {
            receivedStreamEvent = true;
            if (event.type === 'content_block_start' && event.content_block.type === 'tool_use') {
                markFirstChunk();
                streamedToolInputs.set(event.index, {
                    id: event.content_block.id,
                    name: event.content_block.name,
                    json: '',
                });
                onStreamDelta({
                    type: 'tool_input_start',
                    content: '',
                    toolCallId: event.content_block.id,
                    toolName: event.content_block.name,
                });
            }
            else if (event.type === 'content_block_delta' && event.delta.type === 'input_json_delta') {
                const entry = streamedToolInputs.get(event.index);
                if (entry) {
                    entry.json += event.delta.partial_json;
                    onStreamDelta({
                        type: 'tool_input_delta',
                        content: event.delta.partial_json,
                        toolCallId: entry.id,
                        toolName: entry.name,
                        partialJson: event.delta.partial_json,
                    });
                }
            }
        });
        let message: Anthropic.Message;
        try {
            message = await stream.finalMessage();
        }
        catch (err) {
            const candidateError = streamError ?? err;
            const retryParams = !streamConnected && !receivedStreamEvent && firstChunkMs === undefined && !stream.aborted
                ? (withoutRootCacheOnParameterError(params, candidateError, signal) ??
                    withoutThinkingBlocksOnSignatureError(params, candidateError, signal))
                : undefined;
            if (retryParams)
                return this.chatStreaming(retryParams, onStreamDelta, signal, extraHeaders);
            const toolInputsSummary = streamedToolInputs.size > 0
                ? Object.fromEntries([...streamedToolInputs.values()].map(t => [t.name, t.json.length]))
                : undefined;
            if (streamError) {
                this.log.error({
                    sessionId: this.sessionId,
                    model: params.model,
                    streamedThinking: streamedThinking || undefined,
                    streamedText: streamedText || undefined,
                    streamedToolInputs: toolInputsSummary,
                    err: streamError,
                }, 'Anthropic stream error with partial content');
                this.dumpFailedRequest('stream_error', params, streamError.message, streamedThinking, streamedText, streamedToolInputs);
                throw streamError;
            }
            const recovered = this.tryRecoverFromInputJsonError(err, stream.currentMessage, streamedToolInputs, streamedText, streamedThinking);
            if (recovered) {
                this.log.warn({
                    sessionId: this.sessionId,
                    model: params.model,
                    recoveryType: recovered.recoveryType,
                    repairedTools: recovered.repairedTools,
                    unreparableTools: recovered.unreparableTools,
                }, '🔧 Recovered from tool_use input JSON parse failure');
                message = recovered.message;
            }
            else {
                const snapshot = stream.currentMessage;
                this.log.error({
                    sessionId: this.sessionId,
                    model: params.model,
                    messagesCount: params.messages?.length,
                    streamedThinking: streamedThinking || undefined,
                    streamedText: streamedText || undefined,
                    streamedToolInputs: toolInputsSummary,
                    snapshot: snapshot ? {
                        stopReason: snapshot.stop_reason ?? 'none',
                        outputTokens: snapshot.usage?.output_tokens ?? 0,
                        contentTypes: snapshot.content?.map(b => b.type).join(',') || 'empty',
                    } : null,
                    originalError: err instanceof Error ? err.message : err,
                }, 'Anthropic stream ended without assistant message');
                this.dumpFailedRequest('stream_incomplete', params, err instanceof Error ? err.message : String(err), streamedThinking, streamedText, streamedToolInputs);
                if (snapshot) {
                    const outputTokens = snapshot.usage?.output_tokens ?? 0;
                    const stopReason = snapshot.stop_reason ?? 'none';
                    const contentTypes = snapshot.content?.map(b => b.type).join(',') || 'empty';
                    const detail = `stop_reason=${stopReason}, output_tokens=${outputTokens}, content=[${contentTypes}]`;
                    throw new Error(`Stream ended incomplete: ${detail}. Original: ${err instanceof Error ? err.message : err}`);
                }
                throw err;
            }
        }
        if (message.stop_reason === 'max_tokens') {
            const hasToolUse = message.content.some(b => b.type === 'tool_use');
            if (hasToolUse) {
                const outputTokens = message.usage?.output_tokens ?? 0;
                throw new Error(`Response truncated at max_tokens (${params.max_tokens}) with incomplete tool_use. ` +
                    `Output tokens: ${outputTokens}. Increase max_tokens or reduce output size.`);
            }
        }
        const parsed = this.parseResponse(message);
        this.maybeDumpEmptyResponse(params, message, parsed);
        if (firstChunkMs !== undefined) {
            const endMs = performance.now();
            const ttftMs = Math.round(firstChunkMs - streamStartMs);
            const generateMs = Math.max(0, Math.round(endMs - firstChunkMs));
            const outputTokens = parsed.usage?.completionTokens;
            const outputTokensPerSec = outputTokens !== undefined && generateMs >= 100
                ? outputTokens / (generateMs / 1000)
                : undefined;
            parsed.timings = { ttftMs, generateMs, outputTokensPerSec };
        }
        return parsed;
    }
    private maybeDumpEmptyResponse(params: Anthropic.MessageCreateParams, rawMessage: Anthropic.Message, parsed: LLMChatResponse): void {
        const isEmpty = !parsed.content &&
            (!parsed.toolCalls || parsed.toolCalls.length === 0) &&
            !parsed.reasoning;
        if (!isEmpty)
            return;
        const stopReason = rawMessage.stop_reason ?? 'none';
        const contentTypes = rawMessage.content?.map((b) => b.type).join(',') || 'empty';
        const outputTokens = rawMessage.usage?.output_tokens ?? 0;
        const diagnostic = `Empty parsed response · raw stop_reason=${stopReason} · ` +
            `raw content types=[${contentTypes}] · output_tokens=${outputTokens}`;
        void this.dumpFailedRequest('empty_response', params, diagnostic, '', '', undefined, rawMessage);
        this.log.warn({
            sessionId: this.sessionId,
            model: params.model,
            stopReason,
            contentTypes,
            outputTokens,
        }, 'Empty parsed response — dumped raw Message for diagnosis');
    }
    private tryRecoverFromInputJsonError(err: unknown, snapshot: Anthropic.Message | undefined, streamedToolInputs: Map<number, {
        id: string;
        name: string;
        json: string;
    }>, streamedText: string, streamedThinking: string): {
        message: Anthropic.Message;
        recoveryType: 'repaired' | 'degraded';
        repairedTools: string[];
        unreparableTools: string[];
    } | null {
        if (!(err instanceof SyntaxError))
            return null;
        if (!snapshot)
            return null;
        if (streamedToolInputs.size === 0)
            return null;
        const repairedInputs = new Map<string, Record<string, unknown>>();
        const unreparable: {
            id: string;
            name: string;
            raw: string;
        }[] = [];
        for (const entry of streamedToolInputs.values()) {
            const result = repairToolInputJson(entry.json, { allowAutoclose: false });
            if (result) {
                repairedInputs.set(entry.id, result.parsed);
            }
            else {
                unreparable.push({ id: entry.id, name: entry.name, raw: entry.json });
            }
        }
        if (unreparable.length === 0) {
            const rebuilt: Anthropic.ContentBlock[] = snapshot.content.map((block) => {
                if (block.type === 'tool_use') {
                    const repaired = repairedInputs.get(block.id);
                    if (repaired !== undefined) {
                        return { ...block, input: repaired };
                    }
                }
                return block;
            });
            return {
                message: {
                    ...snapshot,
                    content: rebuilt,
                    stop_reason: 'tool_use',
                },
                recoveryType: 'repaired',
                repairedTools: [...streamedToolInputs.values()].map((t) => t.name),
                unreparableTools: [],
            };
        }
        const apology = this.buildSelfCorrectionText(unreparable, err.message);
        const filteredContent: Anthropic.ContentBlock[] = snapshot.content
            .filter((b) => b.type !== 'tool_use')
            .map((b) => b);
        const hasText = filteredContent.some((b) => b.type === 'text');
        if (hasText) {
            const lastTextIdx = filteredContent
                .map((b, i) => (b.type === 'text' ? i : -1))
                .filter((i) => i >= 0)
                .pop()!;
            const lastText = filteredContent[lastTextIdx] as Anthropic.TextBlock;
            filteredContent[lastTextIdx] = {
                ...lastText,
                text: lastText.text + '\n\n' + apology,
            };
        }
        else {
            filteredContent.push({
                type: 'text',
                text: streamedText ? streamedText + '\n\n' + apology : apology,
                citations: null,
            } as Anthropic.TextBlock);
        }
        void streamedThinking;
        return {
            message: {
                ...snapshot,
                content: filteredContent,
                stop_reason: 'end_turn',
            },
            recoveryType: 'degraded',
            repairedTools: [...repairedInputs.keys()].map((id) => {
                const e = [...streamedToolInputs.values()].find((t) => t.id === id);
                return e?.name ?? id;
            }),
            unreparableTools: unreparable.map((t) => t.name),
        };
    }
    private buildSelfCorrectionText(unreparable: {
        id: string;
        name: string;
        raw: string;
    }[], errMsg: string): string {
        const lines: string[] = [
            '⚠️ My previous tool call(s) failed because the JSON I wrote for the input was malformed. ' +
                `Parse error: ${errMsg}.`,
        ];
        for (const t of unreparable) {
            const preview = t.raw.length > 400 ? t.raw.slice(0, 400) + '…' : t.raw;
            lines.push(`- Tool: \`${t.name}\` — raw input I produced: \`${preview}\``);
        }
        lines.push('I will retry the call(s) now with valid JSON, paying attention to escaping (\\n, \\t, \\"), trailing commas, and balanced brackets.');
        return lines.join('\n');
    }
    private async dumpFailedRequest(reason: 'stream_error' | 'stream_incomplete' | 'empty_response', params: Anthropic.MessageCreateParams, error: string, streamedThinking: string, streamedText: string, streamedToolInputs?: Map<number, {
        id: string;
        name: string;
        json: string;
    }>, rawMessage?: unknown): Promise<void> {
        if (!this.sessionId || !this.onRequestDump)
            return;
        try {
            await this.onRequestDump({
                sessionId: this.sessionId,
                reason,
                error,
                streamedThinking,
                streamedText,
                streamedToolInputs: streamedToolInputs?.size
                    ? [...streamedToolInputs.values()].map((t) => ({
                        id: t.id,
                        name: t.name,
                        partialJson: t.json,
                    }))
                    : undefined,
                request: params,
                rawMessage,
            });
        }
        catch {
        }
    }
    private parseResponse(message: Anthropic.Message): LLMChatResponse {
        if (typeof message === 'string') {
            try {
                message = JSON.parse(message as unknown as string) as Anthropic.Message;
            }
            catch (err) {
                const preview = (message as unknown as string).slice(0, 200);
                throw new Error(`Anthropic response body is a non-JSON string (likely Content-Type: text/plain ` +
                    `with malformed body): ${(err as Error).message}. Body preview: ${preview}`);
            }
        }
        if (!Array.isArray(message.content)) {
            throw new Error(`Anthropic response.content is not an array: typeof=${typeof message.content}, ` +
                `stop_reason=${message.stop_reason ?? 'none'}, raw=${JSON.stringify(message).slice(0, 300)}`);
        }
        let content: string | null = null;
        let reasoning: string | undefined;
        let reasoningSignature: string | undefined;
        const toolCalls: LLMToolCall[] = [];
        for (const block of message.content) {
            if (block.type === 'thinking') {
                reasoning = (reasoning || '') + block.thinking;
                if ('signature' in block && block.signature) {
                    reasoningSignature = block.signature as string;
                }
            }
            else if (block.type === 'text') {
                content = (content || '') + block.text;
            }
            else if (block.type === 'tool_use') {
                toolCalls.push({
                    id: block.id,
                    name: block.name,
                    arguments: JSON.stringify(block.input),
                });
            }
        }
        if (message.stop_reason === 'refusal' && !content) {
            content =
                '(The model refused this request due to Anthropic policy filtering. Try rephrasing or providing additional context.)';
        }
        const stopReasonMap: Record<string, LLMChatResponse['stopReason']> = {
            end_turn: 'end_turn',
            tool_use: 'tool_use',
            max_tokens: 'max_tokens',
            refusal: 'refusal',
            pause_turn: 'end_turn',
        };
        const rawUsage = message.usage as Anthropic.Usage & {
            cache_creation_input_tokens?: number;
            cache_read_input_tokens?: number;
        };
        return {
            content,
            toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
            reasoning,
            reasoningSignature,
            stopReason: (message.stop_reason && stopReasonMap[message.stop_reason]) ||
                'end_turn',
            usage: rawUsage
                ? {
                    promptTokens: rawUsage.input_tokens,
                    contextTokens: rawUsage.input_tokens + (rawUsage.cache_read_input_tokens ?? 0) + (rawUsage.cache_creation_input_tokens ?? 0),
                    completionTokens: rawUsage.output_tokens,
                    cachedTokens: rawUsage.cache_read_input_tokens ?? 0,
                    cacheCreationTokens: rawUsage.cache_creation_input_tokens ?? 0,
                }
                : undefined,
        };
    }
    getProviderName(): string {
        return 'anthropic';
    }
    getModelName(): string {
        return this.model;
    }
}
