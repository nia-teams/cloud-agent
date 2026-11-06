import { canonicalFixture } from './fixtures/canonical.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Dispatcher } from 'undici';
import { OpenAIClient, OpenAICompatibleHttpError, OpenAIStreamProtocolError, MalformedToolArgumentsError, UpstreamStreamError, } from '../clients/openai.js';
import * as proxyDispatchers from '../proxy-dispatcher.js';
import type { LLMChatRequest, StreamDelta } from '../types.js';
const originalFetch = globalThis.fetch;
const encoder = new TextEncoder();
const exactArguments = '{"action": "terminal_list"}';
afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
});
function makeClient(overrides: Partial<ConstructorParameters<typeof OpenAIClient>[0]> = {}) {
    return new OpenAIClient({
        apiKey: 'sk-sdk-regression-not-for-logs',
        baseURL: 'https://sdk-regression.invalid/v1',
        model: 'test-model',
        providerName: 'openrouter',
        ...overrides,
    });
}
function request(overrides: Partial<LLMChatRequest> = {}): LLMChatRequest {
    return {
        systemPrompt: '',
        tools: [],
        onStreamDelta: () => { },
        ...overrides,
        messages: canonicalFixture(overrides.messages ?? [{ role: 'user', content: 'hello' }]),
    };
}
function chunk(delta: Record<string, unknown> = {}, finishReason: string | null = null) {
    return {
        id: 'cmpl-sdk-regression',
        object: 'chat.completion.chunk',
        model: 'test-model',
        choices: [{ index: 0, delta, finish_reason: finishReason }],
    };
}
function tool(argumentsPart: string, initial = false, index = 0) {
    return chunk({
        tool_calls: [{
                index,
                ...(initial ? { id: `call-${index}`, type: 'function' } : {}),
                function: {
                    ...(initial ? { name: index === 0 ? 'shell' : 'lookup' } : {}),
                    arguments: argumentsPart,
                },
            }],
    });
}
function frame(value: unknown, space = true) {
    return `data:${space ? ' ' : ''}${JSON.stringify(value)}\n\n`;
}
function wire(values: unknown[], done = true) {
    return values.map(value => frame(value)).join('') + (done ? 'data: [DONE]\n\n' : '');
}
function sseResponse(text: string, byteSize?: number, headers: HeadersInit = {}) {
    const bytes = encoder.encode(text);
    const body = new ReadableStream<Uint8Array>({
        start(controller) {
            const size = byteSize ?? Math.max(bytes.length, 1);
            for (let offset = 0; offset < bytes.length; offset += size) {
                controller.enqueue(bytes.slice(offset, offset + size));
            }
            controller.close();
        },
    });
    return new Response(body, {
        headers: { 'content-type': 'text/event-stream', ...headers },
    });
}
function mockSse(text: string, byteSize?: number, headers?: Record<string, string>) {
    globalThis.fetch = vi.fn().mockImplementation(async () => sseResponse(text, byteSize, headers));
}
async function rejected(promise: Promise<unknown>): Promise<Error> {
    return promise.then(() => { throw new Error('Expected chat to reject, but it succeeded'); }, error => {
        expect(error).toBeInstanceOf(Error);
        return error as Error;
    });
}
function serializeError(error: Error) {
    return JSON.stringify(error, Object.getOwnPropertyNames(error));
}
describe('OpenAIClient SDK SSE framing regressions', () => {
    const prefix = tool('{"action": "terminal_list', true);
    const quote = tool('"');
    const suffix = tool('}');
    const finish = chunk({}, 'tool_calls');
    it.each([
        {
            name: 'quote-only delta with data: and no space',
            text: frame(prefix) + frame(quote, false) + wire([suffix, finish]),
        },
        {
            name: 'quote-only delta inside a multiline data event',
            text: frame(prefix) +
                'data: ' + JSON.stringify(quote, null, 2).replaceAll('\n', '\ndata: ') + '\n\n' +
                wire([suffix, finish]),
        },
        {
            name: 'every data field without a space, including DONE',
            text: wire([prefix, quote, suffix, finish]).replaceAll('data: ', 'data:'),
        },
        { name: 'LF delimiters', text: wire([prefix, quote, suffix, finish]) },
        { name: 'CRLF delimiters', text: wire([prefix, quote, suffix, finish]).replaceAll('\n', '\r\n') },
        { name: 'CR-only delimiters', text: wire([prefix, quote, suffix, finish]).replaceAll('\n', '\r') },
    ])('preserves exact legal tool arguments with $name', async ({ text }) => {
        mockSse(text);
        const result = await makeClient().chat(request());
        expect(result.toolCalls).toEqual([{ id: 'call-0', name: 'shell', arguments: exactArguments }]);
        expect(JSON.parse(result.toolCalls![0].arguments)).toEqual({ action: 'terminal_list' });
        expect(result.stopReason).toBe('tool_use');
    });
    it.each(['\n', '\r\n', '\r'])('decodes one-byte UTF-8 network chunks with %j delimiters', async (newline) => {
        const args = '{"content":"中文🙂 café"}';
        mockSse(wire([
            chunk({ content: '你好🙂' }),
            tool(args, true),
            finish,
        ]).replaceAll('\n', newline), 1);
        const result = await makeClient().chat(request());
        expect(result.content).toBe('你好🙂');
        expect(result.toolCalls![0].arguments).toBe(args);
    });
    it('ignores comments and SSE metadata while joining multiline data fields', async () => {
        const text = ': heartbeat\n\nid: ignored-event-id\nretry: 1000\nevent: message\n' +
            'data:' + JSON.stringify(tool(exactArguments, true), null, 2).replaceAll('\n', '\ndata:') +
            '\n\n' + wire([finish]);
        mockSse(text, 1);
        expect((await makeClient().chat(request())).toolCalls![0].arguments).toBe(exactArguments);
    });
    it('assembles interleaved tools by index, preserving IDs, names, order and raw argument strings', async () => {
        mockSse(wire([
            tool('{"query":', true, 1),
            tool('{"action": ', true, 0),
            tool('"中文"', false, 1),
            tool('"terminal_list"', false, 0),
            tool('}', false, 1),
            tool('}', false, 0),
            finish,
        ]), 1);
        const result = await makeClient().chat(request());
        expect(result.toolCalls).toEqual([
            { id: 'call-0', name: 'shell', arguments: exactArguments },
            { id: 'call-1', name: 'lookup', arguments: '{"query":"中文"}' },
        ]);
    });
    it('accepts a finished stream without DONE', async () => {
        mockSse(wire([prefix, quote, suffix, finish], false));
        const result = await makeClient().chat(request());
        expect(result.toolCalls![0].arguments).toBe(exactArguments);
        expect(result.stopReason).toBe('tool_use');
    });
    it('ignores all data after DONE, including malformed JSON and provider errors', async () => {
        mockSse(wire([tool(exactArguments, true), finish]) +
            frame(tool('poison')) + 'data:{private-malformed-tail}\n\n' +
            'event:error\ndata:{"message":"must not throw"}\n\n');
        const result = await makeClient().chat(request());
        expect(result.toolCalls![0].arguments).toBe(exactArguments);
        expect(result.upstreamCompletionId).toBe('cmpl-sdk-regression');
    });
});
describe('OpenAIClient SDK streaming adaptation', () => {
    it('accumulates multiple reasoning deltas in both formats with per-chunk nullish precedence', async () => {
        mockSse(wire([
            chunk({ reasoning_content: 'first ', reasoning: 'ignored' }),
            chunk({ reasoning: 'second ' }),
            chunk({ reasoning_content: null, reasoning: 'third ' }),
            chunk({ reasoning_content: '', reasoning: 'also ignored' }),
            chunk({ reasoning_content: 'fourth' }),
            chunk({ content: 'answer ' }),
            chunk({ content: '中文' }),
            chunk({}, 'stop'),
        ]), 1);
        const onStreamDelta = vi.fn();
        const result = await makeClient().chat(request({ onStreamDelta }));
        expect(result.reasoning).toBe('first second third fourth');
        expect(result.content).toBe('answer 中文');
        expect(onStreamDelta.mock.calls.map(([delta]) => delta)).toEqual([
            { type: 'thinking', content: 'first ' },
            { type: 'thinking', content: 'second ' },
            { type: 'thinking', content: 'third ' },
            { type: 'thinking', content: 'fourth' },
            { type: 'text', content: 'answer ' },
            { type: 'text', content: '中文' },
        ]);
    });
    it('accepts usage-only chunks and replaces duplicate snapshots instead of adding tokens or cost', async () => {
        const first = { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4, cost: 0.01 };
        const last = {
            prompt_tokens: 20, completion_tokens: 8, total_tokens: 28,
            prompt_tokens_details: { cached_tokens: 12 },
            completion_tokens_details: { reasoning_tokens: 5 },
            cost: 0.125,
        };
        mockSse(wire([
            { choices: [], usage: first },
            chunk({ content: 'ok' }),
            { ...chunk({}, 'stop'), usage: first },
            { choices: [], usage: last },
            { choices: [], usage: last },
        ]));
        const result = await makeClient({ includeUsageCost: true }).chat(request());
        expect(result.content).toBe('ok');
        expect(result.usage).toEqual({
            promptTokens: 20, completionTokens: 8, cachedTokens: 12,
            reasoningTokens: 5, usdCost: 0.125,
        });
    });
});
describe('OpenAIClient SDK stream failure contract', () => {
    it('rejects malformed outer JSON without exposing any raw event in logs or serialized Error', async () => {
        const secret = 'private-prompt-and-tool-arguments-must-not-leak';
        const raw = `{"private":"${secret}","api_key":"sk-private-regression-key",BROKEN}`;
        mockSse(frame(chunk({ content: 'partial' })) + `data:${raw}\n\n` +
            wire([chunk({}, 'stop')]), 1, {
            'x-oneapi-request-id': 'gateway-safe-json',
            'x-request-id': 'lower-priority-request',
        });
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => { });
        const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => { });
        const error = await rejected(makeClient().chat(request()));
        expect(error).toBeInstanceOf(OpenAIStreamProtocolError);
        expect(error).toMatchObject({
            upstreamRequestId: 'gateway-safe-json',
            upstreamCompletionId: 'cmpl-sdk-regression',
        });
        expect(error.message).toMatch(/JSON|protocol/i);
        const diagnostics = serializeError(error) + JSON.stringify(consoleError.mock.calls) +
            JSON.stringify(consoleWarn.mock.calls);
        for (const sensitive of [raw, secret, 'sk-private-regression-key', 'sk-sdk-regression-not-for-logs']) {
            expect(diagnostics).not.toContain(sensitive);
        }
    });
    it.each([
        { type: 'invalid_request_error', code: 'invalid_prompt', nested: false },
        { type: 'server_error', code: 'server_is_overloaded', nested: true },
    ])('preserves event:error provider classification $code', async ({ type, code, nested }) => {
        const provider = { type, code, message: 'provider rejected' };
        const eventError = nested ? { code: 502, message: JSON.stringify({ error: provider }) } : provider;
        mockSse(frame(chunk({ content: 'partial' })) +
            `event:error\ndata:${JSON.stringify(eventError)}\n\n`, undefined, { 'x-request-id': 'gateway-event-error' });
        const error = await rejected(makeClient().chat(request()));
        expect(error).toBeInstanceOf(UpstreamStreamError);
        expect(error).toMatchObject({
            providerType: type, providerCode: code,
            upstreamRequestId: 'gateway-event-error', upstreamCompletionId: 'cmpl-sdk-regression',
        });
    });
    it('rejects event:error with only a message rather than treating it as an empty success', async () => {
        mockSse('event: error\ndata: {"message":"provider failed"}\n\n');
        const error = await rejected(makeClient().chat(request()));
        expect(error).toBeInstanceOf(UpstreamStreamError);
        expect(error.message).toContain('provider failed');
    });
    it.each([
        { name: 'no main choice despite a usage snapshot', values: [{ choices: [], usage: { prompt_tokens: 1 } }] },
        { name: 'missing choices field', values: [{ id: 'cmpl-sdk-regression' }] },
        { name: 'wrong choice index', values: [{ choices: [{ index: 1, delta: {}, finish_reason: 'stop' }] }] },
        { name: 'multiple choices', values: [{ choices: [
                        { index: 0, delta: {}, finish_reason: 'stop' },
                        { index: 1, delta: {}, finish_reason: 'stop' },
                    ] }] },
        { name: 'content without finish_reason', values: [chunk({ content: 'partial' })] },
        { name: 'complete legal tool arguments without finish_reason', values: [tool(exactArguments, true)] },
    ])('rejects $name even if DONE arrives', async ({ values }) => {
        mockSse(wire(values), undefined, { 'x-request-id': 'gateway-incomplete' });
        const error = await rejected(makeClient().chat(request()));
        expect(error).toBeInstanceOf(OpenAIStreamProtocolError);
        expect(error).toMatchObject({ upstreamRequestId: 'gateway-incomplete' });
    });
    it('rejects EOF with legal tool arguments but no finish or DONE', async () => {
        mockSse(wire([tool(exactArguments, true)], false));
        expect(await rejected(makeClient().chat(request()))).toBeInstanceOf(OpenAIStreamProtocolError);
    });
    it.each(['id', 'name', 'type'])('rejects a finished tool call missing %s metadata', async (missing) => {
        const call: {
            index: number;
            id?: string;
            type?: string;
            function: {
                name?: string;
                arguments: string;
            };
        } = {
            index: 0, id: 'call-incomplete', type: 'function',
            function: { name: 'shell', arguments: exactArguments },
        };
        if (missing === 'name')
            delete call.function.name;
        else if (missing === 'id')
            delete call.id;
        else
            delete call.type;
        mockSse(wire([chunk({ tool_calls: [call] }), chunk({}, 'tool_calls')]));
        const error = await rejected(makeClient().chat(request()));
        expect(error).toBeInstanceOf(OpenAIStreamProtocolError);
        expect(error.message).toMatch(/tool.*structure|metadata/i);
    });
    it.each([
        { name: 'abort before finish', reasonName: 'AbortError', finished: false },
        { name: 'abort after partial finish', reasonName: 'AbortError', finished: true },
        { name: 'timeout before finish', reasonName: 'TimeoutError', finished: false },
        { name: 'timeout after partial finish', reasonName: 'TimeoutError', finished: true },
    ])('rejects the original signal reason for $name during streaming', async ({ reasonName, finished }) => {
        const controller = new AbortController();
        const reason = new DOMException(`original ${reasonName} reason`, reasonName);
        let bodyController: ReadableStreamDefaultController<Uint8Array>;
        globalThis.fetch = vi.fn().mockImplementation(async (_input, init: RequestInit) => {
            const body = new ReadableStream<Uint8Array>({
                start(streamController) {
                    bodyController = streamController;
                    streamController.enqueue(encoder.encode(frame(chunk({ content: 'partial' }, finished ? 'stop' : null))));
                },
            });
            init.signal!.addEventListener('abort', () => {
                bodyController.error(new DOMException('transport aborted', 'AbortError'));
            }, { once: true });
            return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
        });
        const deltas: StreamDelta[] = [];
        const error = await rejected(makeClient().chat(request({
            signal: controller.signal,
            onStreamDelta(delta) {
                deltas.push(delta);
                controller.abort(reason);
            },
        })));
        expect(deltas).toEqual([{ type: 'text', content: 'partial' }]);
        expect(error).toBe(reason);
        expect(error.name).toBe(reasonName);
        expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    });
    it.each(['AbortError', 'TimeoutError'])('preserves %s when cancellation interrupts the next pending body read after finish', async (name) => {
        const controller = new AbortController();
        const reason = new DOMException('original stalled-stream reason', name);
        globalThis.fetch = vi.fn().mockImplementation(async (_input, init: RequestInit) => {
            let reads = 0;
            const body = new ReadableStream<Uint8Array>({
                start(streamController) {
                    init.signal!.addEventListener('abort', () => {
                        streamController.error(new DOMException('fetch body aborted', 'AbortError'));
                    }, { once: true });
                },
                pull(streamController) {
                    reads++;
                    if (reads === 1) {
                        streamController.enqueue(encoder.encode(frame(chunk({ content: 'finished partial' }, 'stop'))));
                    }
                    else {
                        controller.abort(reason);
                    }
                },
            }, { highWaterMark: 0 });
            return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
        });
        const onStreamDelta = vi.fn();
        const error = await rejected(makeClient().chat(request({ signal: controller.signal, onStreamDelta })));
        expect(onStreamDelta).toHaveBeenCalledWith({ type: 'text', content: 'finished partial' });
        expect(error).toBe(reason);
        expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    });
});
describe('OpenAIClient call-local SDK HTTP transport', () => {
    it.each([429, 500, 503])('does not SDK-retry HTTP %i for streaming or non-streaming chat', async (status) => {
        globalThis.fetch = vi.fn().mockImplementation(async () => new Response(JSON.stringify({ error: { type: 'server_error', code: 'server_is_overloaded', message: 'rejected' } }), { status, headers: { 'retry-after': '0', 'x-request-id': `gateway-${status}` } }));
        const client = makeClient();
        for (const streaming of [true, false]) {
            const error = await rejected(client.chat(request({ onStreamDelta: streaming ? () => { } : undefined })));
            expect(error).toBeInstanceOf(OpenAICompatibleHttpError);
            expect(error).toMatchObject({
                status, statusCode: status, response: { status },
                upstreamRequestId: `gateway-${status}`, providerCode: 'server_is_overloaded',
            });
        }
        expect(globalThis.fetch).toHaveBeenCalledTimes(2);
    });
    it.each([
        { model: 'shape-a', protocol: 'thinking_object' as const, expected: { thinking: { type: 'enabled' } } },
        { model: 'shape-b', protocol: 'openai' as const, expected: {} },
        { model: 'deepseek-v4.1-test', protocol: 'enable_thinking' as const, expected: { enable_thinking: true } },
    ])('passes the explicit dispatcher, headers and $model request extensions through SDK HTTP', async ({ model, protocol, expected }) => {
        const dispatcher = {} as Dispatcher;
        const getDispatcher = vi.spyOn(proxyDispatchers, 'createProxyDispatcher').mockReturnValue(dispatcher);
        globalThis.fetch = vi.fn().mockImplementation(async (_input, init: RequestInit) => {
            const body = JSON.parse(String(init.body));
            if (body.stream)
                return sseResponse(wire([chunk({ content: 'ok' }), chunk({}, 'stop')]));
            return new Response(JSON.stringify({
                id: 'cmpl-nonstream',
                choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
            }), { headers: { 'content-type': 'application/json' } });
        });
        const client = makeClient({
            model, httpProxy: 'http://proxy-regression.invalid:8080',
            extraHeaders: { 'X-Session-ID': 'session-sdk', 'HTTP-Referer': 'https://attribution.invalid', Authorization: 'Bearer override-key' },
            includeUsageCost: true, supportsThinking: true, supportsReasoningEffort: true,
            reasoningFormat: protocol,
        });
        for (const streaming of [true, false]) {
            await client.chat(request({
                messages: [{ role: 'user', content: [
                            { type: 'text', text: 'look', cache_control: { type: 'ephemeral' } },
                            { type: 'image_url', image_url: { url: 'data:image/png;base64,dGVzdA==' } },
                        ] }],
                systemPrompt: 'system',
                tools: [{ name: 'shell', description: 'Run a command', inputSchema: { type: 'object', properties: { action: { type: 'string' } } } }],
                enableThinking: true, thinkingBudget: 2048, effort: 'high', maxTokens: 4096,
                onStreamDelta: streaming ? () => { } : undefined,
            }));
            const [url, init] = vi.mocked(globalThis.fetch).mock.calls.at(-1)!;
            expect(url).toBe('https://sdk-regression.invalid/v1/chat/completions');
            expect((init as RequestInit & {
                dispatcher?: Dispatcher;
            }).dispatcher).toBe(dispatcher);
            const headers = new Headers(init!.headers);
            expect(headers.get('x-session-id')).toBe('session-sdk');
            expect(headers.get('http-referer')).toBe('https://attribution.invalid');
            expect(headers.get('authorization')).toBe('Bearer override-key');
            expect(headers.get('x-stainless-timeout')).toBe('1200');
            expect(headers.get('x-stainless-retry-count')).toBe('0');
            const body = JSON.parse(String(init!.body));
            expect(body).toMatchObject({
                model, max_tokens: 4096, reasoning_effort: 'high',
                ...expected,
                usage: { include: true }, tool_choice: 'auto',
                tools: [{ type: 'function', function: {
                            name: 'shell', description: 'Run a command',
                            parameters: { type: 'object', properties: { action: { type: 'string' } } },
                        } }],
            });
            expect(body.messages[1].content).toEqual([
                { type: 'image_url', image_url: { url: 'data:image/png;base64,dGVzdA==' } },
                { type: 'text', text: 'look', ...(model.startsWith('qwen') ? { cache_control: { type: 'ephemeral' } } : {}) },
            ]);
            expect(body.messages[0].content).toEqual(model.startsWith('qwen')
                ? [{ type: 'text', text: 'system', cache_control: { type: 'ephemeral' } }]
                : 'system');
            expect(body.stream).toBe(streaming ? true : undefined);
            expect(body.stream_options).toEqual(streaming ? { include_usage: true } : undefined);
            expect(init!.signal).toBeInstanceOf(AbortSignal);
        }
        expect(getDispatcher).toHaveBeenCalledWith('http://proxy-regression.invalid:8080');
        expect(globalThis.fetch).toHaveBeenCalledTimes(2);
    });
    it('keeps concurrent HTTP failure IDs and classifications local to their own call', async () => {
        let releaseFirst!: () => void;
        let firstBodyStarted!: () => void;
        const release = new Promise<void>(resolve => { releaseFirst = resolve; });
        const started = new Promise<void>(resolve => { firstBodyStarted = resolve; });
        globalThis.fetch = vi.fn().mockImplementation(async (_input, init: RequestInit) => {
            const payload = JSON.parse(String(init.body));
            const first = payload.messages[0].content === 'first';
            if (!first)
                return new Response(JSON.stringify({ error: {
                        type: 'server_error', code: 'server_is_overloaded', message: 'second body',
                    } }), { status: 503, headers: { 'x-request-id': 'gateway-second', 'retry-after': '7' } });
            const body = new ReadableStream<Uint8Array>({
                async start(controller) {
                    firstBodyStarted();
                    await release;
                    controller.enqueue(encoder.encode(JSON.stringify({ error: {
                            type: 'invalid_request_error', code: 'invalid_prompt', message: 'first body',
                        } })));
                    controller.close();
                },
            });
            return new Response(body, { status: 400, headers: { 'x-oneapi-request-id': 'gateway-first', 'retry-after': '2' } });
        });
        const client = makeClient();
        const firstFailure = rejected(client.chat(request({ messages: [{ role: 'user', content: 'first' }] })));
        await started;
        let secondError: Error;
        try {
            secondError = await rejected(client.chat(request({
                messages: [{ role: 'user', content: 'second' }], onStreamDelta: undefined,
            })));
        }
        finally {
            releaseFirst();
        }
        const firstError = await firstFailure;
        expect(firstError).toBeInstanceOf(OpenAICompatibleHttpError);
        expect(secondError!).toBeInstanceOf(OpenAICompatibleHttpError);
        expect(firstError).toMatchObject({
            status: 400, upstreamRequestId: 'gateway-first', retryAfter: '2',
            providerType: 'invalid_request_error', providerCode: 'invalid_prompt',
        });
        expect(secondError!).toMatchObject({
            status: 503, upstreamRequestId: 'gateway-second', retryAfter: '7',
            providerType: 'server_error', providerCode: 'server_is_overloaded',
        });
        expect(serializeError(firstError)).not.toContain('gateway-second');
        expect(serializeError(secondError!)).not.toContain('gateway-first');
        expect((firstError as OpenAICompatibleHttpError).responseBody).toContain('first body');
        expect((secondError! as OpenAICompatibleHttpError).responseBody).toContain('second body');
        expect(globalThis.fetch).toHaveBeenCalledTimes(2);
    });
});
describe('OpenAIClient official SDK final message aggregation', () => {
    it('preserves final text, tools and usage with a leading usage-only frame and omitted roles', async () => {
        mockSse(wire([
            { choices: [], usage: { prompt_tokens: 1, completion_tokens: 0 } },
            chunk({ content: '答', reasoning_content: '思' }),
            tool('{"answer":', true),
            chunk({ content: '案', reasoning_content: '考' }),
            tool('42}'),
            { ...chunk({}, 'tool_calls'), usage: { prompt_tokens: 10, completion_tokens: 5, cost: 0.25 } },
            { choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, cost: 0.25 } },
        ]), 1);
        const result = await makeClient().chat(request());
        expect(result).toMatchObject({
            content: '答案', reasoning: '思考', stopReason: 'tool_use',
            toolCalls: [{ id: 'call-0', name: 'shell', arguments: '{"answer":42}' }],
            usage: { promptTokens: 10, completionTokens: 5, usdCost: 0.25 },
            upstreamCompletionId: 'cmpl-sdk-regression',
        });
    });
    it('rejects completion ID changes within one request', async () => {
        mockSse(wire([chunk({ content: 'first' }), { ...chunk({ content: 'second' }, 'stop'), id: 'other-id' }]));
        const error = await rejected(makeClient().chat(request()));
        expect(error).toBeInstanceOf(OpenAIStreamProtocolError);
        expect(error.message).toMatch(/completion ID/);
    });
    it('rejects incomplete tool metadata without exposing the SDK snapshot or its content', async () => {
        const secret = 'private-secret-only-in-sdk-snapshot';
        mockSse(wire([
            chunk({ content: secret, tool_calls: [{ index: 0, type: 'function', function: { arguments: JSON.stringify({ secret }) } }] }),
            chunk({}, 'tool_calls'),
        ]));
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => { });
        const error = await rejected(makeClient().chat(request()));
        expect(error).toBeInstanceOf(OpenAIStreamProtocolError);
        expect(serializeError(error) + JSON.stringify(consoleError.mock.calls)).not.toContain(secret);
    });
    it('releases an open transport tail when DONE precedes network EOF', async () => {
        const cancel = vi.fn();
        globalThis.fetch = vi.fn().mockImplementation(async () => new Response(new ReadableStream({
            start(controller) { controller.enqueue(encoder.encode(wire([chunk({ content: 'finished' }, 'stop')]))); },
            cancel,
        }), { headers: { 'content-type': 'text/event-stream' } }));
        expect((await makeClient().chat(request())).content).toBe('finished');
        await vi.waitFor(() => expect(cancel).toHaveBeenCalledTimes(1));
    });
    it('preserves the original network error after the SDK wraps a bridge error', async () => {
        const networkError = new Error('connection reset before finish');
        globalThis.fetch = vi.fn().mockImplementation(async () => new Response(new ReadableStream({
            start(controller) { controller.enqueue(encoder.encode(frame(chunk({ content: 'partial' })))); },
            pull(controller) { controller.error(networkError); },
        }, { highWaterMark: 0 }), { headers: { 'content-type': 'text/event-stream' } }));
        expect(await rejected(makeClient().chat(request()))).toBe(networkError);
    });
});
describe('OpenAIClient SDK helper error containment', () => {
    it('keeps interleaved malformed strict tools on the platform JSON validation path without console output', async () => {
        const secret = 'private-malformed-tool-part';
        mockSse(wire([
            tool('{"secret":"' + secret, true, 0),
            tool('{"query":"safe"}', true, 1),
            chunk({}, 'tool_calls'),
        ]));
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => { });
        const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => { });
        const error = await rejected(makeClient().chat(request({ tools: [{
                    name: 'shell', description: 'test', inputSchema: { type: 'object' },
                    strict: true,
                }] as any })));
        expect(error).toBeInstanceOf(MalformedToolArgumentsError);
        expect(error).toMatchObject({ toolCallId: 'call-0', toolName: 'shell' });
        expect(consoleError).not.toHaveBeenCalled();
        expect(consoleWarn).not.toHaveBeenCalled();
    });
    it('aborts a stalled transport when SDK aggregation rejects missing tool metadata', async () => {
        const secret = 'private-helper-failure-content';
        let transportAborted = false;
        const cancel = vi.fn();
        globalThis.fetch = vi.fn().mockImplementation(async (_input, init: RequestInit) => new Response(new ReadableStream({
            start(controller) {
                init.signal!.addEventListener('abort', () => {
                    transportAborted = true;
                    controller.error(new DOMException('transport aborted', 'AbortError'));
                }, { once: true });
                controller.enqueue(encoder.encode(frame(chunk({ content: secret, tool_calls: [{
                            index: 0, id: 'call-secret',
                            function: { name: 'shell', arguments: '{}' },
                        }] })) + frame(tool('{}', true, 1))));
            },
            cancel,
        }), { headers: { 'content-type': 'text/event-stream' } }));
        const error = await rejected(makeClient().chat(request()));
        expect(error).toBeInstanceOf(OpenAIStreamProtocolError);
        expect(serializeError(error)).not.toContain(secret);
        expect(transportAborted).toBe(true);
    });
});
describe('streamed tool input lifecycle', () => {
    it('emits one start per call before argument fragments through real SDK decoding', async () => {
        const deltas: StreamDelta[] = [];
        mockSse(wire([tool('{', true), tool('"action":'), tool('"terminal_list"}'), chunk({}, 'tool_calls')]), 1);
        await makeClient().chat(request({ onStreamDelta: delta => deltas.push(delta) }));
        const tools = deltas.filter(delta => delta.type === 'tool_input_start' || delta.type === 'tool_input_delta');
        expect(tools[0]).toMatchObject({ type: 'tool_input_start', toolCallId: 'call-0', toolName: 'shell' });
        expect(tools.filter(delta => delta.type === 'tool_input_start')).toHaveLength(1);
        expect(tools.filter(delta => delta.type === 'tool_input_delta').map(delta => delta.partialJson).join('')).toBe('{"action":"terminal_list"}');
    });
});
