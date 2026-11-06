import { canonicalFixture } from './fixtures/canonical.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ResponsesClient } from '../clients/responses.js';
import { MalformedToolArgumentsError, OpenAICompatibleHttpError, OpenAIStreamProtocolError, UpstreamStreamError, } from '../clients/openai.js';
function sseResponse(events: Array<{
    event?: string;
    data: unknown;
}>, headers: Record<string, string> = {}) {
    const chunks = events.map((ev) => {
        const prefix = ev.event ? `event: ${ev.event}\n` : '';
        const payload = typeof ev.data === 'string' ? ev.data : JSON.stringify(ev.data);
        return `${prefix}data: ${payload}\n\n`;
    });
    return new Response(chunks.join('') + 'data: [DONE]\n\n', {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream', ...headers },
    });
}
afterEach(() => {
    vi.unstubAllGlobals();
});
describe('ResponsesClient (/v1/responses)', () => {
    it.each([false, true])('keeps the session cache key across growing histories (stream=%s)', async (stream) => {
        const requests: Array<{
            headers: Headers;
            body: Record<string, any>;
        }> = [];
        vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
            requests.push({ headers: new Headers(init.headers), body: JSON.parse(init.body as string) });
            const response = {
                id: 'resp_cache', status: 'completed',
                output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'OK' }] }],
                usage: { input_tokens: 2048, output_tokens: 1, input_tokens_details: { cached_tokens: 1536 } },
            };
            return stream
                ? sseResponse([{ data: { type: 'response.completed', response } }])
                : new Response(JSON.stringify(response), { headers: { 'Content-Type': 'application/json' } });
        }));
        const client = (session: string) => new ResponsesClient({
            apiKey: 'test', model: 'gpt-6.1-sol', baseURL: 'https://cache.test/v1',
            promptCacheKey: `  ${session}  `, extraHeaders: { 'X-Session-ID': session, 'Session-Id': session },
        });
        const a = client('session-a');
        const invoke = (c: ResponsesClient, messages: any[]) => c.chat({
            systemPrompt: 'Stable instructions', messages: canonicalFixture(messages),
            ...(stream ? { onStreamDelta: () => { } } : {}),
        });
        const messages = [{ role: 'user', content: 'First' }];
        const first = await invoke(a, messages);
        const followup = [...messages, { role: 'assistant', content: 'OK' }, { role: 'user', content: 'Next' }];
        await invoke(a, followup);
        await invoke(client('session-a'), followup);
        await invoke(client('session-b'), messages);
        expect(requests.map(r => r.body.prompt_cache_key)).toEqual(['session-a', 'session-a', 'session-a', 'session-b']);
        expect(requests.map(r => r.headers.get('X-Session-ID'))).toEqual(['session-a', 'session-a', 'session-a', 'session-b']);
        expect(requests.map(r => r.headers.get('Session-Id'))).toEqual(['session-a', 'session-a', 'session-a', 'session-b']);
        expect(requests[1]!.body.input.length).toBeGreaterThan(requests[0]!.body.input.length);
        expect(first.usage).toMatchObject({ promptTokens: 2048, cachedTokens: 1536 });
    });
    it.each([undefined, '   '])('omits an absent cache identity (%s)', async (promptCacheKey) => {
        let sent: Record<string, unknown> = {};
        vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
            sent = JSON.parse(init.body as string);
            return new Response(JSON.stringify({ id: 'r', status: 'completed', output: [], usage: { input_tokens: 1, output_tokens: 0 } }));
        }));
        await new ResponsesClient({ apiKey: 'test', model: 'gpt-6.1-sol', promptCacheKey }).chat({ messages: canonicalFixture([{ role: 'user', content: 'Hi' }]) });
        expect(sent).not.toHaveProperty('prompt_cache_key');
    });
    it('streams reasoning, tool calls, and preserves signed output items in reasoningDetails for replay', async () => {
        const requests: Array<{
            url: string;
            headers: Headers;
            body: Record<string, any>;
        }> = [];
        const signedReasoningItem = {
            id: 'rs_resp_1_0',
            type: 'reasoning',
            encrypted_content: 'cpa-gemini-responses-carrier-v1:next:function:RXNNVENzQVRBUkZOTWcvWE5WaXg1bERwa0thSFI3WGc=',
            summary: [{ type: 'summary_text', text: 'Let me run echo.' }],
        };
        const functionCallItem = {
            id: 'fc_call_1',
            type: 'function_call',
            status: 'completed',
            call_id: 'call_1',
            name: 'echo',
            arguments: '{"text":"hello"}',
        };
        vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
            requests.push({
                url,
                headers: new Headers(init.headers),
                body: JSON.parse(init.body as string),
            });
            if (requests.length === 1) {
                return sseResponse([
                    {
                        event: 'response.created',
                        data: { type: 'response.created', response: { id: 'resp_1', status: 'in_progress' } },
                    },
                    {
                        event: 'response.output_item.added',
                        data: {
                            type: 'response.output_item.added',
                            output_index: 0,
                            item: { id: 'rs_resp_1_0', type: 'reasoning', encrypted_content: signedReasoningItem.encrypted_content, summary: [] },
                        },
                    },
                    {
                        event: 'response.reasoning_summary_text.delta',
                        data: {
                            type: 'response.reasoning_summary_text.delta',
                            output_index: 0,
                            delta: 'Let me run echo.',
                        },
                    },
                    {
                        event: 'response.output_item.done',
                        data: {
                            type: 'response.output_item.done',
                            output_index: 0,
                            item: signedReasoningItem,
                        },
                    },
                    {
                        event: 'response.output_item.added',
                        data: {
                            type: 'response.output_item.added',
                            output_index: 1,
                            item: { id: 'fc_call_1', type: 'function_call', call_id: 'call_1', name: 'echo', arguments: '' },
                        },
                    },
                    {
                        event: 'response.function_call_arguments.delta',
                        data: {
                            type: 'response.function_call_arguments.delta',
                            output_index: 1,
                            delta: '{"text":',
                        },
                    },
                    {
                        event: 'response.function_call_arguments.delta',
                        data: {
                            type: 'response.function_call_arguments.delta',
                            output_index: 1,
                            delta: '"hello"}',
                        },
                    },
                    {
                        event: 'response.output_item.done',
                        data: {
                            type: 'response.output_item.done',
                            output_index: 1,
                            item: functionCallItem,
                        },
                    },
                    {
                        event: 'response.completed',
                        data: {
                            type: 'response.completed',
                            response: {
                                id: 'resp_1',
                                status: 'completed',
                                output: [signedReasoningItem, functionCallItem],
                                usage: {
                                    input_tokens: 120,
                                    output_tokens: 35,
                                    input_tokens_details: { cached_tokens: 80 },
                                    output_tokens_details: { reasoning_tokens: 20 },
                                },
                            },
                        },
                    },
                ], { 'x-request-id': 'req_abc_1' });
            }
            return sseResponse([
                {
                    event: 'response.output_text.delta',
                    data: { type: 'response.output_text.delta', delta: 'Done!' },
                },
                {
                    event: 'response.completed',
                    data: {
                        type: 'response.completed',
                        response: {
                            id: 'resp_2',
                            status: 'completed',
                            output: [
                                {
                                    id: 'msg_resp_2_0',
                                    type: 'message',
                                    role: 'assistant',
                                    status: 'completed',
                                    content: [{ type: 'output_text', text: 'Done!' }],
                                },
                            ],
                            usage: { input_tokens: 150, output_tokens: 10 },
                        },
                    },
                },
            ]);
        }));
        const client = new ResponsesClient({
            apiKey: 'sk-test',
            baseURL: 'https://llmapi.example/v1/',
            model: 'gemini-4-argon-high',
            providerName: 'responses',
            extraHeaders: { 'X-Session-ID': 'sess-123' },
            defaults: { enableThinking: true, maxOutputTokens: 65536, effort: 'low' },
        });
        const deltas: Array<{
            type: string;
            content: string;
            toolCallId?: string;
            toolName?: string;
        }> = [];
        const first = await client.chat({
            systemPrompt: 'You are Ada.',
            messages: canonicalFixture([{ role: 'user', content: 'echo hello' }]),
            tools: [{ name: 'echo', description: 'Echo text', inputSchema: { type: 'object' } }],
            onStreamDelta: (d) => deltas.push(d),
        });
        expect(requests[0]!.url).toBe('https://llmapi.example/v1/responses');
        expect(requests[0]!.headers.get('X-Session-ID')).toBe('sess-123');
        expect(requests[0]!.body).toMatchObject({
            model: 'gemini-4-argon-high',
            instructions: 'You are Ada.',
            max_output_tokens: 65536,
            store: false,
            include: ['reasoning.encrypted_content'],
            reasoning: { effort: 'low' },
            stream: true,
        });
        expect(requests[0]!.body.reasoning?.summary).toBeUndefined();
        expect(first.stopReason).toBe('tool_use');
        expect(first.reasoning).toBe('Let me run echo.');
        expect(first.toolCalls).toEqual([{ id: 'call_1', name: 'echo', arguments: '{"text":"hello"}' }]);
        expect(first.reasoningDetails).toEqual([signedReasoningItem, functionCallItem]);
        expect(first.upstreamRequestId).toBe('req_abc_1');
        expect(first.upstreamCompletionId).toBe('resp_1');
        expect(first.usage).toEqual({
            promptTokens: 120,
            completionTokens: 35,
            cachedTokens: 80,
            reasoningTokens: 20,
        });
        expect(deltas.some((d) => d.type === 'tool_input_start' && d.toolCallId === 'call_1' && d.toolName === 'echo')).toBe(true);
        const second = await client.chat({
            systemPrompt: 'You are Ada.',
            messages: canonicalFixture([
                { role: 'user', content: 'echo hello' },
                {
                    role: 'assistant',
                    content: null,
                    tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'echo', arguments: '{"text":"hello"}' } }],
                    reasoning_content: first.reasoning,
                    reasoning_details: first.reasoningDetails,
                },
                {
                    role: 'tool',
                    tool_call_id: 'call_1',
                    content: 'echo:hello',
                },
            ]),
            onStreamDelta: () => { },
        });
        expect(second.content).toBe('Done!');
        expect(requests[1]!.body.input).toEqual([
            { type: 'message', role: 'user', content: 'echo hello' },
            signedReasoningItem,
            functionCallItem,
            { type: 'function_call_output', call_id: 'call_1', output: 'echo:hello' },
        ]);
    });
    it('normalizes multimodal image and PDF document blocks for /v1/responses', async () => {
        let capturedBody: Record<string, any> | undefined;
        vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
            capturedBody = JSON.parse(init.body as string);
            return new Response(JSON.stringify({
                id: 'resp_mm',
                status: 'completed',
                output: [
                    {
                        type: 'message',
                        role: 'assistant',
                        content: [{ type: 'output_text', text: 'inspected' }],
                    },
                ],
            }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }));
        const client = new ResponsesClient({
            apiKey: 'sk-test',
            baseURL: 'https://llmapi.example/v1',
            model: 'gemini-4-argon-high',
            providerName: 'responses',
        });
        const res = await client.chat({
            messages: [{ type: 'event', eventType: 'message', timestamp: new Date(0), content: 'check these', attachments: [
                        { type: 'image', mediaType: 'image/png', data: 'aGVsbG8=' },
                        { type: 'document', mediaType: 'application/pdf', data: 'JVBERi0=' },
                    ] }],
            enableThinking: false,
        });
        expect(res.content).toBe('inspected');
        expect(capturedBody?.reasoning).toBeUndefined();
        expect(capturedBody?.input).toEqual([
            {
                type: 'message',
                role: 'user',
                content: [
                    { type: 'input_image', image_url: 'data:image/png;base64,aGVsbG8=' },
                    { type: 'input_file', file_data: 'data:application/pdf;base64,JVBERi0=', filename: 'document.pdf' },
                    { type: 'input_text', text: 'check these' },
                ],
            },
        ]);
    });
    it('throws OpenAICompatibleHttpError on HTTP non-2xx and UpstreamStreamError on SSE error events', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
            error: {
                type: 'invalid_request_error',
                code: 'invalid_prompt',
                message: 'Prompt was flagged as violating usage policy',
            },
        }), { status: 400, headers: { 'x-request-id': 'req_400' } })));
        const client = new ResponsesClient({
            apiKey: 'sk-test',
            baseURL: 'https://llmapi.example/v1',
            model: 'gpt-6.1-sol',
            providerName: 'responses',
        });
        await expect(client.chat({ messages: canonicalFixture([{ role: 'user', content: 'hi' }]) })).rejects.toMatchObject({
            name: 'OpenAICompatibleHttpError',
            status: 400,
            providerCode: 'invalid_prompt',
            upstreamRequestId: 'req_400',
        });
        await expect(client.chat({ messages: canonicalFixture([{ role: 'user', content: 'hi' }]) })).rejects.toBeInstanceOf(OpenAICompatibleHttpError);
        vi.stubGlobal('fetch', vi.fn(async () => sseResponse([
            {
                event: 'response.failed',
                data: {
                    type: 'response.failed',
                    response: {
                        id: 'resp_err',
                        status: 'failed',
                        error: {
                            type: 'server_error',
                            code: 'internal_server_error',
                            message: 'upstream failed mid-stream',
                        },
                    },
                },
            },
        ])));
        await expect(client.chat({
            messages: canonicalFixture([{ role: 'user', content: 'hi' }]),
            onStreamDelta: () => { },
        })).rejects.toBeInstanceOf(UpstreamStreamError);
    });
    it('throws MalformedToolArgumentsError when function_call arguments are invalid JSON and OpenAIStreamProtocolError on truncated stream', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
            id: 'resp_bad_args',
            status: 'completed',
            output: [
                {
                    type: 'function_call',
                    call_id: 'call_bad',
                    name: 'shell',
                    arguments: '{"command":"ls"',
                },
            ],
        }), { status: 200 })));
        const client = new ResponsesClient({
            apiKey: 'sk-test',
            baseURL: 'https://llmapi.example/v1',
            model: 'gemini-4-argon-high',
            providerName: 'responses',
        });
        let caught: MalformedToolArgumentsError | undefined;
        try {
            await client.chat({ messages: canonicalFixture([{ role: 'user', content: 'hi' }]) });
        }
        catch (e) {
            caught = e as MalformedToolArgumentsError;
        }
        expect(caught).toBeInstanceOf(MalformedToolArgumentsError);
        expect(caught?.partialResponse?.toolCalls?.[0]).toMatchObject({
            id: 'call_bad',
            name: 'shell',
            arguments: '{}',
        });
        expect(caught?.partialResponse?.toolCalls?.[0].malformedError).toContain('tool_call.arguments not valid JSON for tool=shell id=call_bad');
        vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
            id: 'resp_repaired_args',
            status: 'completed',
            output: [
                {
                    type: 'function_call',
                    call_id: 'call_repaired',
                    name: 'file_write',
                    arguments: '{"path":"a.txt","content":"line1\nline2",}',
                },
            ],
        }), { status: 200 })));
        const repairedRes = await client.chat({ messages: canonicalFixture([{ role: 'user', content: 'hi' }]) });
        expect(JSON.parse(repairedRes.toolCalls![0].arguments)).toEqual({
            path: 'a.txt',
            content: 'line1\nline2',
        });
        vi.stubGlobal('fetch', vi.fn(async () => new Response('event: response.created\ndata: {"type":"response.created","response":{"id":"resp_trunc","status":"in_progress"}}\n\n', { status: 200, headers: { 'Content-Type': 'text/event-stream' } })));
        await expect(client.chat({
            messages: canonicalFixture([{ role: 'user', content: 'hi' }]),
            onStreamDelta: () => { },
        })).rejects.toBeInstanceOf(OpenAIStreamProtocolError);
    });
    it('replays configuration_update items from reasoning_details both with full output items and as a standalone update', async () => {
        const requests: Array<Record<string, any>> = [];
        vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
            requests.push(JSON.parse(init.body as string));
            return new Response(JSON.stringify({
                id: 'resp_cfg',
                status: 'completed',
                output: [
                    {
                        type: 'message',
                        role: 'assistant',
                        content: [{ type: 'output_text', text: 'ok' }],
                    },
                ],
            }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }));
        const client = new ResponsesClient({
            apiKey: 'sk-test',
            baseURL: 'https://llmapi.example/v1',
            model: 'gpt-6.1-sol',
            providerName: 'responses',
            defaults: { enableThinking: true, effort: 'low' },
        });
        await client.chat({
            messages: canonicalFixture([
                { role: 'user', content: 'check' },
                {
                    role: 'assistant',
                    content: null,
                    tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'send_message', arguments: '{"content":"checking"}' } }],
                    reasoning_details: [
                        { id: 'rs_1', type: 'reasoning', encrypted_content: 'enc_1', summary: [{ type: 'summary_text', text: 'plan' }] },
                        { id: 'fc_1', type: 'function_call', call_id: 'call_1', name: 'send_message', arguments: '{"content":"checking"}', status: 'completed' },
                        { type: 'configuration_update', reasoning: { effort: 'high' } },
                    ],
                } as any,
                { role: 'tool', tool_call_id: 'call_1', content: 'published' },
            ]),
        });
        expect(requests[0]!.reasoning).toEqual({ effort: 'low' });
        expect(requests[0]!.input).toEqual([
            { type: 'message', role: 'user', content: 'check' },
            { id: 'rs_1', type: 'reasoning', encrypted_content: 'enc_1', summary: [{ type: 'summary_text', text: 'plan' }] },
            { id: 'fc_1', type: 'function_call', call_id: 'call_1', name: 'send_message', arguments: '{"content":"checking"}', status: 'completed' },
            { type: 'configuration_update', reasoning: { effort: 'high' } },
            { type: 'function_call_output', call_id: 'call_1', output: 'published' },
        ]);
        await client.chat({
            messages: canonicalFixture([
                { role: 'user', content: 'check' },
                {
                    role: 'assistant',
                    content: null,
                    tool_calls: [{ id: 'call_2', type: 'function', function: { name: 'send_message', arguments: '{"content":"checking"}' } }],
                    reasoning_details: [
                        { type: 'configuration_update', reasoning: { effort: 'medium' } },
                    ],
                } as any,
                { role: 'tool', tool_call_id: 'call_2', content: 'published' },
            ]),
        });
        expect(requests[1]!.input).toEqual([
            { type: 'message', role: 'user', content: 'check' },
            { type: 'function_call', call_id: 'call_2', name: 'send_message', arguments: '{"content":"checking"}', status: 'completed' },
            { type: 'configuration_update', reasoning: { effort: 'medium' } },
            { type: 'function_call_output', call_id: 'call_2', output: 'published' },
        ]);
        await client.chat({
            messages: canonicalFixture([
                { role: 'user', content: 'check' },
                {
                    role: 'assistant',
                    content: null,
                    tool_calls: [{ id: 'call_3', type: 'function', function: { name: 'send_message', arguments: '{"content":"checking"}' } }],
                    reasoning_details: [
                        { type: 'configuration_update', reasoning: { effort: 'invalid-effort' } },
                    ],
                } as any,
                { role: 'tool', tool_call_id: 'call_3', content: 'published' },
            ]),
        });
        expect(requests[2]!.input).toEqual([
            { type: 'message', role: 'user', content: 'check' },
            { type: 'function_call', call_id: 'call_3', name: 'send_message', arguments: '{"content":"checking"}', status: 'completed' },
            { type: 'function_call_output', call_id: 'call_3', output: 'published' },
        ]);
    });
});
