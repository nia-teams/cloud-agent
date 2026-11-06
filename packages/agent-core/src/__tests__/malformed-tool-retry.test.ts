import { describe, expect, it, vi } from 'vitest';
import { MalformedToolArgumentsError, type StreamDelta } from '../protocol/llm-protocol.js';
import { AgentRuntime } from '../runtime.js';
import type { AgentEvent, AssistantMessage, ExitState, RuntimeState, ToolMessage } from '../types.js';
import { CapturingUsageRecorder, MemoryStore, MockLLMClient, makeEchoTool, userEvent, } from './fixtures.js';
const malformed = () => new MalformedToolArgumentsError('bad-call', 'echo', '{"secret":"do-not-log"', { upstreamRequestId: 'request-bad', upstreamCompletionId: 'completion-bad' });
const successfulUsage = {
    promptTokens: 13, completionTokens: 7, cachedTokens: 3,
    reasoningTokens: 2, usdCost: 0.01,
};
function setup(client: MockLLMClient, llmCallTimeoutMs?: number) {
    const store = new MemoryStore([userEvent('hello')]);
    const usage = new CapturingUsageRecorder();
    const events: AgentEvent[] = [];
    const afterFetch = vi.fn();
    const afterLLM = vi.fn((state: RuntimeState) => ({
        iteration: state.loopIteration, pending: [...state.pending], numLLMCalls: state.numLLMCalls,
    }));
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    let finalState!: RuntimeState;
    const runtime = new AgentRuntime({
        store, usage, logger, llmCallTimeoutMs,
        sessionId: 'retry-session',
    });
    const run = (abortSignal?: AbortSignal) => runtime.run({
        client, systemPrompt: '', tools: [], keyId: 'k1',
        abortSignal, onEvent: (event) => events.push(event),
        hooks: {
            afterFetch, afterLLM: (state) => { afterLLM(state); },
            afterTurn: (state) => { finalState = state; },
        },
    });
    return { store, usage, events, afterFetch, afterLLM, logger, run,
        exit: (): ExitState | null => finalState.exit };
}
const eventTypes = (events: AgentEvent[]) => events.map((event) => event.type);
function expectNoArgumentLogs(logger: ReturnType<typeof setup>['logger']) {
    const serialized = JSON.stringify([
        ...logger.info.mock.calls, ...logger.warn.mock.calls, ...logger.error.mock.calls,
    ]);
    expect(serialized).not.toContain('do-not-log');
    expect(serialized).not.toContain('rawArguments');
}
describe('CALL_LLM · bounded malformed tool arguments retry', () => {
    it('bad → good reuses the model step, request input, deadline and turn; only success is persisted/billed', async () => {
        const client = new MockLLMClient([
            { throws: malformed() },
            { content: 'recovered', usage: successfulUsage,
                streamDeltas: [{ type: 'text', content: 'recovered' }] },
        ], 'openai');
        const s = setup(client);
        const fetchNew = vi.spyOn(s.store, 'fetchNew');
        await s.run();
        expect(client.calls).toHaveLength(2);
        expect(client.calls[1].signal).toBe(client.calls[0].signal);
        expect(client.calls[1].messages).toBe(client.calls[0].messages);
        expect(s.afterLLM).toHaveBeenCalledTimes(1);
        expect(fetchNew).toHaveBeenCalledTimes(2);
        expect(s.afterFetch).toHaveBeenCalledTimes(2);
        expect(s.afterLLM.mock.results[0].value).toMatchObject({ iteration: 1, numLLMCalls: 1 });
        expect(s.afterLLM.mock.results[0].value.pending).toHaveLength(1);
        expect(s.exit()?.kind).toBe('done');
        expect(s.store.stored.map((m) => m.type)).toEqual(['event', 'assistant']);
        expect(s.store.stored[1]).toMatchObject({ content: 'recovered' });
        expect(s.usage.entries).toHaveLength(1);
        expect(s.usage.entries[0]).toMatchObject({
            numLLMCalls: 1, inputTokens: 13, lastInputTokens: 13, outputTokens: 7,
            cachedTokens: 3, reasoningTokens: 2, usdCost: 0.01, exitKind: 'done',
        });
        expect(eventTypes(s.events)).toEqual([
            'turn_start', 'text_delta', 'usage_update', 'turn_end',
        ]);
        expect(new Set(s.events.filter((e) => 'turnId' in e).map((e) => e.turnId)).size).toBe(1);
        expect(s.logger.warn).toHaveBeenCalledWith(expect.objectContaining({
            errorType: 'MalformedToolArgumentsError', upstreamRequestId: 'request-bad',
            toolName: 'echo', retryAttempt: 1,
        }), expect.any(String));
        expectNoArgumentLogs(s.logger);
    });
    it('bad → bad stops after two requests through the original error path, with no assistant or usage', async () => {
        const secondError = malformed();
        const client = new MockLLMClient([
            { throws: malformed() }, { throws: secondError }, { content: 'must not run' },
        ]);
        const s = setup(client);
        await s.run();
        expect(client.calls).toHaveLength(2);
        expect(s.exit()).toEqual({ kind: 'error', error: secondError });
        expect(s.afterFetch).toHaveBeenCalledTimes(1);
        expect(s.afterLLM).not.toHaveBeenCalled();
        expect(s.store.stored).toHaveLength(1);
        expect(s.usage.entries[0]).toMatchObject({
            numLLMCalls: 0, inputTokens: 0, outputTokens: 0, exitKind: 'error',
        });
        expect(eventTypes(s.events)).toEqual(['turn_start', 'error', 'turn_end']);
        expectNoArgumentLogs(s.logger);
    });
    it('does not rerun a previously executed tool or hooks/drain when retrying the next step', async () => {
        const store = new MemoryStore([userEvent('use echo')]);
        const echo = makeEchoTool();
        const client = new MockLLMClient([
            { toolCalls: [{ id: 'once', name: 'echo', arguments: '{"text":"write"}' }] },
            { throws: malformed() }, { content: 'done' },
        ]);
        const afterFetch = vi.fn();
        const afterLLM = vi.fn();
        const afterExecTools = vi.fn();
        const isDraining = vi.fn(() => false);
        const usage = new CapturingUsageRecorder();
        await new AgentRuntime({
            store, sessionId: 'tool-retry', usage, isDraining,
        }).run({
            client, systemPrompt: '', tools: [echo], keyId: 'k1',
            hooks: { afterFetch, afterLLM, afterExecTools },
        });
        expect(client.calls).toHaveLength(3);
        expect(client.calls[2].messages).toBe(client.calls[1].messages);
        expect(client.calls[2].signal).toBe(client.calls[1].signal);
        expect(echo.calls).toEqual([{ input: { text: 'write' } }]);
        expect(afterExecTools).toHaveBeenCalledTimes(1);
        expect(isDraining).toHaveBeenCalledTimes(1);
        expect(afterFetch).toHaveBeenCalledTimes(3);
        expect(afterLLM).toHaveBeenCalledTimes(2);
        expect(store.stored.map((m) => m.type)).toEqual(['event', 'assistant', 'tool', 'assistant']);
        expect(usage.entries[0]).toMatchObject({ numLLMCalls: 2, inputTokens: 200, outputTokens: 40 });
    });
    it.each([
        ['text', { type: 'text', content: 'visible' }, ['text_delta']],
        ['reasoning', { type: 'thinking', content: 'visible' }, ['thinking_start', 'thinking_end']],
        ['tool start', { type: 'tool_input_start', content: '', toolCallId: 'start', toolName: 'echo' }, ['tool_input_start']],
        ['tool input delta', { type: 'tool_input_delta', content: '{', toolCallId: 'delta', partialJson: '{' }, ['tool_input_delta']],
    ] as Array<[
        string,
        StreamDelta,
        string[]
    ]>)('visible %s prohibits retry', async (_label, delta, visibleTypes) => {
        const client = new MockLLMClient([
            { throws: malformed(), streamDeltas: [delta] }, { content: 'must not run' },
        ]);
        const s = setup(client);
        await s.run();
        expect(client.calls).toHaveLength(1);
        expect(s.exit()?.kind).toBe('error');
        expect(s.afterLLM).not.toHaveBeenCalled();
        expect(s.store.stored).toHaveLength(1);
        expect(eventTypes(s.events)).toEqual(['turn_start', ...visibleTypes, 'error', 'turn_end']);
    });
    it('empty text/reasoning and non-visible tool input deltas do not prohibit retry', async () => {
        const client = new MockLLMClient([
            { throws: malformed(), streamDeltas: [
                    { type: 'text', content: '' }, { type: 'thinking', content: '' },
                    { type: 'tool_use', content: '{', toolCallId: 'bad-call' },
                ] },
            { content: 'done' },
        ]);
        const s = setup(client);
        await s.run();
        expect(client.calls).toHaveLength(2);
        expect(eventTypes(s.events)).toEqual(['turn_start', 'usage_update', 'turn_end']);
    });
    it.each([
        new Error('network'),
        Object.assign(new Error('same name, wrong class'), { name: 'MalformedToolArgumentsError' }),
    ])('does not retry other errors, even a matching error name', async (error) => {
        const client = new MockLLMClient([{ throws: error }, { content: 'must not run' }]);
        const s = setup(client);
        await s.run();
        expect(client.calls).toHaveLength(1);
        expect(s.exit()).toEqual({ kind: 'error', error });
    });
    it('does not start a request when the caller is already canceled', async () => {
        const controller = new AbortController();
        controller.abort();
        const client = new MockLLMClient([{ throws: malformed() }]);
        const s = setup(client);
        await s.run(controller.signal);
        expect(client.calls).toHaveLength(0);
        expect(s.exit()?.kind).toBe('aborted');
        expect(s.afterLLM).not.toHaveBeenCalled();
        expect(s.store.stored).toHaveLength(1);
        expect(s.usage.entries[0].numLLMCalls).toBe(0);
    });
    it.each(['throw', 'return'] as const)('user cancellation suppresses late deltas and prohibits retry/success (%s)', async (outcome) => {
        const controller = new AbortController();
        const client = new MockLLMClient([{ content: 'must not persist' }]);
        const original = client.chat.bind(client);
        client.chat = async (request) => {
            const response = await original(request);
            controller.abort();
            request.onStreamDelta?.({ type: 'text', content: 'late' });
            request.onStreamDelta?.({ type: 'thinking', content: 'late' });
            request.onStreamDelta?.({ type: 'tool_input_start', content: '', toolCallId: 'late', toolName: 'echo' });
            if (outcome === 'throw')
                throw malformed();
            return response;
        };
        const s = setup(client);
        await s.run(controller.signal);
        expect(client.calls).toHaveLength(1);
        expect(s.exit()?.kind).toBe('aborted');
        expect(s.afterLLM).not.toHaveBeenCalled();
        expect(s.store.stored).toHaveLength(1);
        expect(s.usage.entries[0].numLLMCalls).toBe(0);
        expect(eventTypes(s.events)).toEqual(['turn_start', 'turn_end']);
    });
    it.each(['first malformed', 'retry malformed', 'retry raw success'] as const)('shared timeout prohibits retry/success and suppresses late callbacks (%s)', async (scenario) => {
        const timeout = vi.spyOn(globalThis, 'setTimeout');
        const client = new MockLLMClient([
            { throws: malformed() }, { content: 'must not persist' },
        ]);
        const original = client.chat.bind(client);
        client.chat = async (request) => {
            const shouldExpire = scenario === 'first malformed' || client.calls.length === 1;
            if (shouldExpire) {
                client.calls.push(request);
                await new Promise<void>(resolve => {
                    if (request.signal?.aborted)
                        resolve();
                    else
                        request.signal?.addEventListener('abort', () => resolve(), { once: true });
                });
                request.onStreamDelta?.({ type: 'text', content: 'late' });
                if (scenario !== 'retry raw success')
                    throw malformed();
                return { content: 'must not persist', stopReason: 'end_turn' as const };
            }
            return original(request);
        };
        const s = setup(client, 42);
        try {
            await s.run();
            expect(timeout.mock.calls.filter(([, ms]) => ms === 42)).toHaveLength(1);
            expect(timeout).toHaveBeenCalledWith(expect.any(Function), 42);
            expect(client.calls).toHaveLength(scenario === 'first malformed' ? 1 : 2);
            if (client.calls.length === 2)
                expect(client.calls[1].signal).toBe(client.calls[0].signal);
            expect(s.exit()).toMatchObject({ kind: 'error', error: { name: 'TimeoutError' } });
            expect(s.afterLLM).not.toHaveBeenCalled();
            expect(s.usage.entries[0].numLLMCalls).toBe(0);
            expect(s.store.stored).toHaveLength(1);
            expect(eventTypes(s.events)).toEqual(['turn_start', 'error', 'turn_end']);
        }
        finally {
            timeout.mockRestore();
        }
    });
    it('streamed malformed tool call with partialResponse recovers via error ToolMessage, executes valid sibling, normalizes stored arguments to {}, and closes tool_call_end(error)', async () => {
        const okTool = makeEchoTool('file_read');
        const badTool = makeEchoTool('file_write');
        const rawTruncated = '{"path":"build/health-status.json","content":"{\\n  \\"subjects\\": [\\n';
        const partialResponse = {
            content: 'Updating health status',
            reasoning: 'Need to read and write',
            stopReason: 'tool_use' as const,
            usage: successfulUsage,
            toolCalls: [
                { id: 'call_good', name: 'file_read', arguments: '{"text":"src/people.md"}' },
                {
                    id: 'call_bad',
                    name: 'file_write',
                    arguments: '{}',
                    malformedError: `tool_call.arguments not valid JSON for tool=file_write id=call_bad (length=${rawTruncated.length}): ${JSON.stringify(rawTruncated)}`,
                },
            ],
        };
        const streamedMalformed = new MalformedToolArgumentsError('call_bad', 'file_write', rawTruncated, { upstreamRequestId: 'req-stream-1', upstreamCompletionId: 'cmpl-stream-1' }, partialResponse);
        const store = new MemoryStore([userEvent('update health record')]);
        const usage = new CapturingUsageRecorder();
        const events: AgentEvent[] = [];
        const client = new MockLLMClient([
            {
                throws: streamedMalformed,
                streamDeltas: [
                    { type: 'tool_input_start', content: '', toolCallId: 'call_good', toolName: 'file_read' },
                    { type: 'tool_input_delta', content: '{"text":"src/people.md"}', toolCallId: 'call_good', partialJson: '{"text":"src/people.md"}' },
                    { type: 'tool_input_start', content: '', toolCallId: 'call_bad', toolName: 'file_write' },
                    { type: 'tool_input_delta', content: rawTruncated, toolCallId: 'call_bad', partialJson: rawTruncated },
                ],
            },
            {
                toolCalls: [
                    { id: 'call_retry_write', name: 'file_write', arguments: '{"text":"{\\"subjects\\":[]}"}' },
                ],
                usage: { promptTokens: 20, completionTokens: 10 },
            },
            {
                content: 'All done',
                usage: { promptTokens: 30, completionTokens: 5 },
            },
        ], 'openai');
        let finalState!: RuntimeState;
        await new AgentRuntime({
            store,
            usage,
            sessionId: 'stream-malformed-recovery',
        }).run({
            client,
            systemPrompt: '',
            tools: [okTool, badTool],
            keyId: 'k1',
            onEvent: (ev) => events.push(ev),
            hooks: {
                afterTurn: (st) => {
                    finalState = st;
                },
            },
        });
        expect(finalState.exit?.kind).toBe('done');
        expect(okTool.calls).toEqual([{ input: { text: 'src/people.md' } }]);
        expect(badTool.calls).toEqual([{ input: { text: '{"subjects":[]}' } }]);
        const firstAssistant = store.stored[1] as AssistantMessage;
        expect(firstAssistant.type).toBe('assistant');
        expect(firstAssistant.content).toBe('Updating health status');
        expect(firstAssistant.reasoning).toBe('Need to read and write');
        expect(firstAssistant.toolCalls).toEqual([
            { id: 'call_good', name: 'file_read', arguments: '{"text":"src/people.md"}' },
            { id: 'call_bad', name: 'file_write', arguments: '{}' },
        ]);
        const toolMsgs = store.stored.slice(2, 4) as ToolMessage[];
        expect(toolMsgs[0]).toMatchObject({
            type: 'tool',
            toolCallId: 'call_good',
            isError: false,
        });
        expect(toolMsgs[1]).toMatchObject({
            type: 'tool',
            toolCallId: 'call_bad',
            isError: true,
            content: expect.stringContaining('The tool was NOT executed'),
        });
        expect(client.calls[1].messages).toContainEqual(firstAssistant);
        expect(client.calls[1].messages).toEqual(expect.arrayContaining(toolMsgs));
        const badCallEvents = events.filter((e) => (e as {
            toolCallId?: string;
        }).toolCallId === 'call_bad');
        expect(badCallEvents.map((e) => e.type)).toEqual([
            'tool_input_start',
            'tool_input_delta',
            'tool_call_start',
            'tool_call_end',
        ]);
        const badCallEnd = badCallEvents[3] as {
            error?: string;
        } | undefined;
        expect(badCallEnd).toBeDefined();
        expect(badCallEnd?.error).toBe('1');
        expect(usage.entries).toHaveLength(1);
        expect(usage.entries[0]).toMatchObject({
            numLLMCalls: 3,
            inputTokens: 13 + 20 + 30,
            outputTokens: 7 + 10 + 5,
            exitKind: 'done',
        });
    });
    it('caps streamed malformed tool-result recovery at once per turn and exits with error if the next iteration is still malformed', async () => {
        const makeStreamedMalformed = (callId: string) => new MalformedToolArgumentsError(callId, 'file_write', '{"path":"x', { upstreamRequestId: `req-${callId}`, upstreamCompletionId: `cmpl-${callId}` }, {
            content: null,
            stopReason: 'tool_use',
            usage: successfulUsage,
            toolCalls: [
                {
                    id: callId,
                    name: 'file_write',
                    arguments: '{}',
                    malformedError: `tool_call.arguments not valid JSON for tool=file_write id=${callId}`,
                },
            ],
        });
        const badTool = makeEchoTool('file_write');
        const store = new MemoryStore([userEvent('write file')]);
        const usage = new CapturingUsageRecorder();
        const events: AgentEvent[] = [];
        const secondError = makeStreamedMalformed('call_bad_2');
        const client = new MockLLMClient([
            {
                throws: makeStreamedMalformed('call_bad_1'),
                streamDeltas: [
                    { type: 'tool_input_start', content: '', toolCallId: 'call_bad_1', toolName: 'file_write' },
                ],
            },
            {
                throws: secondError,
                streamDeltas: [
                    { type: 'tool_input_start', content: '', toolCallId: 'call_bad_2', toolName: 'file_write' },
                ],
            },
            { content: 'must not reach third call' },
        ]);
        let finalState!: RuntimeState;
        await new AgentRuntime({
            store,
            usage,
            sessionId: 'stream-malformed-cap',
        }).run({
            client,
            systemPrompt: '',
            tools: [badTool],
            keyId: 'k1',
            onEvent: (ev) => events.push(ev),
            hooks: {
                afterTurn: (st) => {
                    finalState = st;
                },
            },
        });
        expect(client.calls).toHaveLength(2);
        expect(badTool.calls).toHaveLength(0);
        expect(finalState.exit).toEqual({ kind: 'error', error: secondError });
        expect(usage.entries[0]).toMatchObject({
            numLLMCalls: 1,
            exitKind: 'error',
        });
    });
    it('interleavePersist preserves canonical tool call/result pairing and emits tool_call_end(error) when user message arrives mid-recovery', async () => {
        const rawTruncated = '{"path":"build/health-status.json","content":"truncated';
        const partialResponse = {
            content: null,
            stopReason: 'tool_use' as const,
            usage: successfulUsage,
            toolCalls: [
                {
                    id: 'call_interleave_bad',
                    name: 'file_write',
                    arguments: '{}',
                    malformedError: 'tool_call.arguments not valid JSON for tool=file_write id=call_interleave_bad',
                },
            ],
        };
        const streamedMalformed = new MalformedToolArgumentsError('call_interleave_bad', 'file_write', rawTruncated, { upstreamRequestId: 'req-il-1', upstreamCompletionId: 'cmpl-il-1' }, partialResponse);
        const store = new MemoryStore([userEvent('start task')]);
        const badTool = makeEchoTool('file_write');
        const events: AgentEvent[] = [];
        const client = new MockLLMClient([
            {
                throws: streamedMalformed,
                streamDeltas: [
                    { type: 'tool_input_start', content: '', toolCallId: 'call_interleave_bad', toolName: 'file_write' },
                ],
            },
            { content: 'Handled interleaved message and error' },
        ]);
        await new AgentRuntime({
            store,
            sessionId: 'stream-malformed-interleave',
        }).run({
            client,
            systemPrompt: '',
            tools: [badTool],
            keyId: 'k1',
            onEvent: (ev) => events.push(ev),
            hooks: {
                beforeExecTools: () => {
                    store.enqueue(userEvent('wait, one more thing'));
                },
            },
        });
        expect(badTool.calls).toHaveLength(0);
        const badCallEvents = events.filter((e) => (e as {
            toolCallId?: string;
        }).toolCallId === 'call_interleave_bad');
        expect(badCallEvents.map((e) => e.type)).toEqual([
            'tool_input_start',
            'tool_call_start',
            'tool_call_end',
        ]);
        expect((badCallEvents[2] as {
            error?: string;
        }).error).toBe('1');
        expect(store.stored[1]).toMatchObject({ type: 'assistant', toolCalls: [expect.objectContaining({ id: 'call_interleave_bad', name: 'file_write', arguments: '{}' })] });
        expect(store.stored[2]).toMatchObject({ type: 'tool', toolCallId: 'call_interleave_bad', content: expect.any(String) });
        expect(store.stored).toContainEqual(expect.objectContaining({ type: 'event', eventType: 'tool.result', content: expect.stringContaining('The tool was NOT executed') }));
        expect(client.calls[1].messages).toContainEqual(store.stored[1]);
        expect(client.calls[1].messages).toContainEqual(store.stored[2]);
    });
});
