import { createDefaultBuiltinPlugins } from '../builtins/index.js';
import { describe, it, expect, vi } from 'vitest';
import { AgentRuntime, validateSystemInjectionPlacement, type RuntimeState, type AgentEvent, type AgentHooks, type AgentMessage, type AssistantMessage, type Tool, } from '../index.js';
import { CapturingUsageRecorder, MemoryStore, MockLLMClient, makeEchoTool, makeFailingTool, userEvent, } from './fixtures.js';
function captureEvents() {
    const events: AgentEvent[] = [];
    const onEvent = (e: AgentEvent) => events.push(e);
    return { events, onEvent };
}
describe('AgentRuntime · empty canonical history', () => {
    it('exits without calling the LLM when fetch returns no messages', async () => {
        const store = new MemoryStore([]);
        const client = new MockLLMClient([{ content: 'must not be used' }]);
        const runtime = new AgentRuntime({ store, sessionId: 's-empty' });
        await runtime.run({
            client,
            systemPrompt: 'brand-specific system context',
            tools: [],
            keyId: 'k1',
        });
        expect(client.calls.length).toBe(0);
        expect(store.stored).toEqual([]);
    });
});
describe('AgentRuntime · single text-only turn', () => {
    it('runs init → call_llm → persist → done', async () => {
        const store = new MemoryStore([userEvent('Hello')]);
        const client = new MockLLMClient([{ content: 'Hi there.' }]);
        const runtime = new AgentRuntime({ store, sessionId: 's1' });
        const { events, onEvent } = captureEvents();
        await runtime.run({
            client,
            systemPrompt: 'be helpful',
            tools: [],
            keyId: 'k1',
            onEvent,
        });
        expect(client.calls.length).toBe(1);
        const tail = store.stored[store.stored.length - 1];
        expect(tail.type).toBe('assistant');
        expect((tail as AssistantMessage).content).toBe('Hi there.');
        const types = events.map((e) => (e as {
            type: string;
        }).type);
        expect(types).toContain('turn_start');
        expect(types).toContain('turn_end');
    });
    it('uses a caller-supplied turnId for events, hooks, and persisted messages', async () => {
        const store = new MemoryStore([userEvent('Hello')]);
        const client = new MockLLMClient([{ content: 'Hi there.' }]);
        const runtime = new AgentRuntime({ store, sessionId: 's-explicit-turn' });
        const { events, onEvent } = captureEvents();
        let hookTurnId: string | undefined;
        await runtime.run({
            turnId: 'turn-from-host',
            client,
            systemPrompt: 'be helpful',
            tools: [],
            keyId: 'k1',
            hooks: {
                afterTurn: (state) => {
                    hookTurnId = state.turnId;
                },
            },
            onEvent,
        });
        expect(hookTurnId).toBe('turn-from-host');
        expect(events.filter((event) => 'turnId' in event).every((event) => (event as {
            turnId: string;
        }).turnId === 'turn-from-host')).toBe(true);
        const tail = store.stored[store.stored.length - 1] as AssistantMessage;
        expect(tail.turnId).toBe('turn-from-host');
    });
    it('response.stopReason / usedFallbackModel 端到端落进持久化的 AssistantMessage', async () => {
        const store = new MemoryStore([userEvent('触发拒答的问题')]);
        const client = new MockLLMClient([{
                content: '降级模型的真实回答',
                stopReason: 'end_turn',
            }]);
        const originalChat = client.chat.bind(client);
        client.chat = async (req) => {
            const r = await originalChat(req);
            return { ...r, usedFallbackModel: 'claude-sonnet-5' };
        };
        const runtime = new AgentRuntime({ store, sessionId: 's-fallback' });
        await runtime.run({
            client,
            systemPrompt: '',
            tools: [],
            keyId: 'k1',
        });
        const tail = store.stored[store.stored.length - 1] as AssistantMessage;
        expect(tail.content).toBe('降级模型的真实回答');
        expect(tail.stopReason).toBe('end_turn');
        expect(tail.usedFallbackModel).toBe('claude-sonnet-5');
    });
});
describe('AgentRuntime · tool call cycle', () => {
    it('runs LLM → tool → LLM → done; tool result reaches second LLM call', async () => {
        const store = new MemoryStore([userEvent('Use the tool')]);
        const echo = makeEchoTool();
        const client = new MockLLMClient([
            { toolCalls: [{ id: 'tc1', name: 'echo', arguments: '{"text":"hi"}' }] },
            { content: 'Done.' },
        ]);
        const runtime = new AgentRuntime({ store, sessionId: 's2' });
        const { events, onEvent } = captureEvents();
        await runtime.run({
            client,
            systemPrompt: '',
            tools: [echo],
            keyId: 'k1',
            onEvent,
        });
        expect(client.calls.length).toBe(2);
        expect(echo.calls).toEqual([{ input: { text: 'hi' } }]);
        const secondMsgs = client.calls[1].messages as AgentMessage[];
        const toolMsg = secondMsgs.find((m) => m.type === 'tool') as Extract<AgentMessage, {
            type: 'tool';
        }> | undefined;
        expect(toolMsg?.content).toBe('echo:hi');
        const types = events.map((e) => (e as {
            type: string;
        }).type);
        expect(types).toContain('tool_call_start');
        expect(types).toContain('tool_call_end');
    });
    it('emits parallel tool_call_end only after the whole result batch is durably persisted', async () => {
        const base = new MemoryStore([userEvent('Run both tools')]);
        let releasePersist!: () => void;
        const persistGate = new Promise<void>((resolve) => { releasePersist = resolve; });
        let toolBatchPersistStarted = false;
        const store = {
            ...base,
            stored: base.stored,
            inbox: base.inbox,
            loadAll: base.loadAll.bind(base),
            fetchNew: base.fetchNew.bind(base),
            hasNew: base.hasNew.bind(base),
            persist: async (messages: AgentMessage[]) => {
                if (messages.some((m) => m.type === 'tool')) {
                    toolBatchPersistStarted = true;
                    await persistGate;
                }
                base.stored.push(...messages);
            },
        };
        const client = new MockLLMClient([
            {
                toolCalls: [
                    { id: 'tc-fast', name: 'fast', arguments: '{}' },
                    { id: 'tc-slow', name: 'slow', arguments: '{}' },
                ],
            },
            { content: 'Done.' },
        ]);
        let releaseFast!: (value: string) => void;
        let releaseSlow!: (value: string) => void;
        const fastResult = new Promise<string>((resolve) => { releaseFast = resolve; });
        const slowResult = new Promise<string>((resolve) => { releaseSlow = resolve; });
        const tools: Tool[] = [
            {
                name: 'fast',
                description: 'controlled fast tool',
                inputSchema: { type: 'object', properties: {} },
                execute: async () => fastResult,
            },
            {
                name: 'slow',
                description: 'controlled slow tool',
                inputSchema: { type: 'object', properties: {} },
                execute: async () => slowResult,
            },
        ];
        const runtime = new AgentRuntime({ store, sessionId: 's2-parallel' });
        const { events, onEvent } = captureEvents();
        const runPromise = runtime.run({
            client,
            systemPrompt: '',
            tools,
            keyId: 'k1',
            onEvent,
        });
        await vi.waitFor(() => {
            const starts = events.filter((e) => (e as {
                type: string;
            }).type === 'tool_call_start');
            expect(starts).toHaveLength(2);
        });
        releaseFast('fast-result');
        await Promise.resolve();
        expect(events.some((e) => (e as {
            type: string;
        }).type === 'tool_call_end')).toBe(false);
        releaseSlow('slow-result');
        await vi.waitFor(() => expect(toolBatchPersistStarted).toBe(true));
        expect(events.some((e) => (e as {
            type: string;
        }).type === 'tool_call_end')).toBe(false);
        expect(base.stored.some((m) => m.type === 'tool')).toBe(false);
        releasePersist();
        await runPromise;
        const finalEnds = events.filter((e) => (e as {
            type: string;
        }).type === 'tool_call_end') as Array<{
            toolCallId?: string;
        }>;
        expect(finalEnds.map((e) => e.toolCallId)).toEqual(['tc-fast', 'tc-slow']);
        for (const tcid of ['tc-fast', 'tc-slow']) {
            expect(base.stored.some((m) => m.type === 'tool' && m.toolCallId === tcid)).toBe(true);
        }
        expect(client.calls).toHaveLength(2);
    });
    it.each(['send_message', 'publish'])('executes explicitly serial %s tools in authored order', async (name) => {
        const store = new MemoryStore([userEvent('Publish both messages')]);
        const client = new MockLLMClient([
            {
                toolCalls: [
                    { id: 'tc-send-first', name, arguments: '{"content":"first"}' },
                    { id: 'tc-send-second', name, arguments: '{"content":"second"}' },
                ],
            },
            { content: 'Done.' },
        ]);
        const lifecycle: string[] = [];
        let releaseFirst!: () => void;
        const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
        const sendMessage: Tool = {
            name,
            concurrency: 'serial',
            description: 'controlled member-visible publish',
            inputSchema: { type: 'object', properties: {} },
            execute: async (input) => {
                const content = (input as {
                    content: string;
                }).content;
                lifecycle.push(`start:${content}`);
                if (content === 'first')
                    await firstGate;
                lifecycle.push(`end:${content}`);
                return content;
            },
        };
        const runPromise = new AgentRuntime({ store, sessionId: 's2-ordered-send' }).run({
            client,
            systemPrompt: '',
            tools: [sendMessage],
            keyId: 'k1',
        });
        await vi.waitFor(() => expect(lifecycle).toEqual(['start:first']));
        releaseFirst();
        await runPromise;
        expect(lifecycle).toEqual([
            'start:first',
            'end:first',
            'start:second',
            'end:second',
        ]);
        expect(store.stored.filter((m) => m.type === 'tool').map((m) => m.toolCallId)).toEqual([
            'tc-send-first',
            'tc-send-second',
        ]);
    });
    it('keeps ordinary same-batch tools concurrent with the ordered send_message chain', async () => {
        const store = new MemoryStore([userEvent('Publish around ordinary work')]);
        const client = new MockLLMClient([
            {
                toolCalls: [
                    { id: 'tc-send-a', name: 'send_message', arguments: '{"content":"A"}' },
                    { id: 'tc-ordinary', name: 'ordinary', arguments: '{}' },
                    { id: 'tc-send-b', name: 'send_message', arguments: '{"content":"B"}' },
                ],
            },
            { content: 'Done.' },
        ]);
        const lifecycle: string[] = [];
        let releaseA!: () => void;
        const firstSendGate = new Promise<void>((resolve) => { releaseA = resolve; });
        const tools: Tool[] = [
            {
                name: 'send_message',
                concurrency: 'serial',
                description: 'controlled member-visible publish',
                inputSchema: { type: 'object', properties: {} },
                execute: async (input) => {
                    const content = (input as {
                        content: string;
                    }).content;
                    lifecycle.push(`start:send:${content}`);
                    if (content === 'A')
                        await firstSendGate;
                    lifecycle.push(`end:send:${content}`);
                    return content;
                },
            },
            {
                name: 'ordinary',
                description: 'ordinary parallel tool',
                inputSchema: { type: 'object', properties: {} },
                execute: async () => {
                    lifecycle.push('start:ordinary');
                    lifecycle.push('end:ordinary');
                    return 'ordinary';
                },
            },
        ];
        const runPromise = new AgentRuntime({ store, sessionId: 's2-send-with-ordinary' }).run({
            client,
            systemPrompt: '',
            tools,
            keyId: 'k1',
        });
        await vi.waitFor(() => {
            expect(lifecycle).toContain('start:send:A');
            expect(lifecycle).toContain('end:ordinary');
        });
        expect(lifecycle).not.toContain('start:send:B');
        releaseA();
        await runPromise;
        expect(lifecycle.indexOf('start:ordinary')).toBeLessThan(lifecycle.indexOf('end:send:A'));
        expect(lifecycle.indexOf('start:send:B')).toBeGreaterThan(lifecycle.indexOf('end:send:A'));
    });
    it('continues the ordered send_message chain after an earlier call fails', async () => {
        const store = new MemoryStore([userEvent('Publish both despite failure')]);
        const client = new MockLLMClient([
            {
                toolCalls: [
                    { id: 'tc-send-fail', name: 'send_message', arguments: '{"content":"fail"}' },
                    { id: 'tc-send-after', name: 'send_message', arguments: '{"content":"after"}' },
                ],
            },
            { content: 'Handled.' },
        ]);
        const calls: string[] = [];
        const sendMessage: Tool = {
            name: 'send_message',
            concurrency: 'serial',
            description: 'controlled member-visible publish',
            inputSchema: { type: 'object', properties: {} },
            execute: async (input) => {
                const content = (input as {
                    content: string;
                }).content;
                calls.push(content);
                if (content === 'fail')
                    throw new Error('publish failed');
                return content;
            },
        };
        await new AgentRuntime({ store, sessionId: 's2-ordered-send-failure' }).run({
            client,
            systemPrompt: '',
            tools: [sendMessage],
            keyId: 'k1',
        });
        expect(calls).toEqual(['fail', 'after']);
        expect(store.stored.filter((m) => m.type === 'tool')).toEqual(expect.arrayContaining([
            expect.objectContaining({ toolCallId: 'tc-send-fail', isError: true }),
            expect.objectContaining({ toolCallId: 'tc-send-after', isError: false }),
        ]));
    });
    it('does not emit a failed tool end while its sibling or persistence is still pending', async () => {
        const store = new MemoryStore([userEvent('Run both tools')]);
        const client = new MockLLMClient([
            {
                toolCalls: [
                    { id: 'tc-fail', name: 'fail-now', arguments: '{}' },
                    { id: 'tc-blocked', name: 'blocked', arguments: '{}' },
                ],
            },
            { content: 'Handled.' },
        ]);
        let releaseBlocked!: (value: string) => void;
        const blockedResult = new Promise<string>((resolve) => { releaseBlocked = resolve; });
        const tools: Tool[] = [
            {
                name: 'fail-now',
                description: 'fails immediately',
                inputSchema: { type: 'object', properties: {} },
                execute: async () => { throw new Error('boom'); },
            },
            {
                name: 'blocked',
                description: 'controlled blocked tool',
                inputSchema: { type: 'object', properties: {} },
                execute: async () => blockedResult,
            },
        ];
        const runtime = new AgentRuntime({ store, sessionId: 's2-parallel-error' });
        const { events, onEvent } = captureEvents();
        const runPromise = runtime.run({
            client,
            systemPrompt: '',
            tools,
            keyId: 'k1',
            onEvent,
        });
        await vi.waitFor(() => {
            expect(events.filter((e) => (e as {
                type?: string;
            }).type === 'tool_call_start')).toHaveLength(2);
        });
        expect(events.some((e) => (e as {
            type?: string;
        }).type === 'tool_call_end')).toBe(false);
        releaseBlocked('ok');
        await runPromise;
        const ends = events.filter((e) => (e as {
            type?: string;
        }).type === 'tool_call_end') as Array<{
            toolCallId?: string;
            error?: string;
        }>;
        expect(ends.find((e) => e.toolCallId === 'tc-fail')?.error).toBe('1');
        expect(ends.find((e) => e.toolCallId === 'tc-blocked')?.error).toBeUndefined();
    });
    it('emits no tool_call_end when canonical result persistence fails', async () => {
        class FailingToolPersistStore extends MemoryStore {
            override async persist(messages: AgentMessage[]): Promise<void> {
                if (messages.some((m) => m.type === 'tool')) {
                    throw new Error('tool persist failed');
                }
                await super.persist(messages);
            }
        }
        const store = new FailingToolPersistStore([userEvent('Use the tool')]);
        const client = new MockLLMClient([
            { toolCalls: [{ id: 'tc-persist-fail', name: 'echo', arguments: '{"text":"x"}' }] },
        ]);
        const { events, onEvent } = captureEvents();
        await new AgentRuntime({ store, sessionId: 's-tool-persist-fail' }).run({
            client,
            systemPrompt: '',
            tools: [makeEchoTool()],
            keyId: 'k1',
            onEvent,
        });
        expect(events.some((e) => (e as {
            type?: string;
            toolCallId?: string;
        }).type === 'tool_call_end'
            && (e as {
                toolCallId?: string;
            }).toolCallId === 'tc-persist-fail')).toBe(false);
        expect(events.some((e) => (e as {
            type?: string;
        }).type === 'error')).toBe(true);
    });
    it('derives tool_call_end status from the final result after afterExecTools', async () => {
        const store = new MemoryStore([userEvent('Use the tool')]);
        const client = new MockLLMClient([
            { toolCalls: [{ id: 'tc-rewrite', name: 'echo', arguments: '{"text":"x"}' }] },
            { content: 'Handled.' },
        ]);
        const { events, onEvent } = captureEvents();
        const hooks: AgentHooks = {
            afterExecTools(state) {
                const result = state.pending.find((m): m is Extract<AgentMessage, {
                    type: 'tool';
                }> => m.type === 'tool' && m.toolCallId === 'tc-rewrite');
                if (result) {
                    result.content = 'rewritten failure';
                    result.isError = true;
                }
            },
        };
        await new AgentRuntime({ store, sessionId: 's-tool-rewrite' }).run({
            client,
            systemPrompt: '',
            tools: [makeEchoTool()],
            keyId: 'k1',
            hooks: [hooks],
            onEvent,
        });
        const end = events.find((e) => (e as {
            type?: string;
            toolCallId?: string;
        }).type === 'tool_call_end'
            && (e as {
                toolCallId?: string;
            }).toolCallId === 'tc-rewrite') as {
            error?: string;
        } | undefined;
        expect(end?.error).toBe('1');
        expect(store.stored.find((m) => m.type === 'tool' && m.toolCallId === 'tc-rewrite')).toMatchObject({ content: 'rewritten failure', isError: true });
    });
});
describe('AgentRuntime · exit kinds', () => {
    it('beforeTurn writing exit=skip causes no LLM call and exitKind=skip', async () => {
        const store = new MemoryStore([userEvent('hi')]);
        const client = new MockLLMClient([{ content: 'never' }]);
        const usage = new CapturingUsageRecorder();
        const skipHook: AgentHooks = {
            afterFetch(state) {
                state.exit = { kind: 'skip' };
            },
        };
        const runtime = new AgentRuntime({ store, sessionId: 's3', usage });
        await runtime.run({
            client,
            systemPrompt: '',
            tools: [],
            keyId: 'k1',
            hooks: [skipHook],
        });
        expect(client.calls.length).toBe(0);
        expect(usage.entries.length).toBe(1);
        expect(usage.entries[0].exitKind).toBe('skip');
    });
    it('user abort signal causes exitKind=aborted and no turn_error event', async () => {
        const store = new MemoryStore([userEvent('hi')]);
        const ctrl = new AbortController();
        ctrl.abort();
        const client = new MockLLMClient([{ content: 'never' }]);
        const runtime = new AgentRuntime({ store, sessionId: 's3b' });
        const { events, onEvent } = captureEvents();
        await runtime.run({
            client,
            systemPrompt: '',
            tools: [],
            keyId: 'k1',
            onEvent,
            abortSignal: ctrl.signal,
        });
        expect(client.calls.length).toBe(0);
        const errEv = events.find((e) => (e as {
            type: string;
        }).type === 'error');
        expect(errEv).toBeUndefined();
    });
    it('hook throwing → exitKind=error and turn_error event emitted', async () => {
        const store = new MemoryStore([userEvent('hi')]);
        const client = new MockLLMClient([{ content: 'never' }]);
        const usage = new CapturingUsageRecorder();
        const badHook: AgentHooks = {
            afterFetch() {
                throw new Error('boom');
            },
        };
        const runtime = new AgentRuntime({ store, sessionId: 's3c', usage });
        const { events, onEvent } = captureEvents();
        await runtime.run({
            client,
            systemPrompt: '',
            tools: [],
            keyId: 'k1',
            hooks: [badHook],
            onEvent,
        });
        expect(client.calls.length).toBe(0);
        expect(usage.entries[0].exitKind).toBe('error');
        const errEv = events.find((e) => (e as {
            type: string;
        }).type === 'error');
        expect(errEv).toBeDefined();
        expect((errEv as {
            message: string;
        }).message).toContain('boom');
    });
    it('afterTurn throw is logged only — does not overwrite exit kind', async () => {
        const store = new MemoryStore([userEvent('hi')]);
        const client = new MockLLMClient([{ content: 'fine' }]);
        const usage = new CapturingUsageRecorder();
        const hooks: AgentHooks = {
            afterTurn() {
                throw new Error('afterTurn boom');
            },
        };
        const runtime = new AgentRuntime({ store, sessionId: 's3d', usage });
        await runtime.run({
            client,
            systemPrompt: '',
            tools: [],
            keyId: 'k1',
            hooks: [hooks],
        });
        expect(usage.entries[0].exitKind).toBe('done');
    });
});
describe('AgentRuntime · afterLLM hijack pre-fulfills tool', () => {
    it('host pushes a tool result for some toolCallId → runtime skips that execute', async () => {
        const store = new MemoryStore([userEvent('try it')]);
        const echo = makeEchoTool();
        const client = new MockLLMClient([
            { toolCalls: [{ id: 'tc1', name: 'echo', arguments: '{"text":"x"}' }] },
            { content: 'wrap' },
        ]);
        const hijackHook: AgentHooks = {
            afterLLM(state) {
                const tail = state.pending[state.pending.length - 1];
                if (tail?.type !== 'assistant' || !tail.toolCalls)
                    return;
                for (const tc of tail.toolCalls) {
                    if (tc.name === 'echo') {
                        state.pending.push({
                            type: 'tool',
                            toolCallId: tc.id,
                            content: 'hijacked',
                            isError: false,
                            turnId: state.turnId,
                            timestamp: new Date(),
                        });
                    }
                }
            },
        };
        const runtime = new AgentRuntime({ store, sessionId: 's4' });
        const { events, onEvent } = captureEvents();
        await runtime.run({
            client,
            systemPrompt: '',
            tools: [echo],
            keyId: 'k1',
            hooks: [hijackHook],
            onEvent,
        });
        expect(echo.calls.length).toBe(0);
        const persistedTool = store.stored.find((m) => m.type === 'tool') as Extract<AgentMessage, {
            type: 'tool';
        }> | undefined;
        expect(persistedTool?.content).toBe('hijacked');
        const end = events.find((e) => (e as {
            type?: string;
            toolCallId?: string;
        }).type === 'tool_call_end'
            && (e as {
                toolCallId?: string;
            }).toolCallId === 'tc1');
        expect(end).toBeDefined();
    });
});
describe('AgentRuntime · afterLLM dropping pending replays the LLM call', () => {
    it('clearing pending in afterLLM forces another LLM call', async () => {
        const store = new MemoryStore([userEvent('think again')]);
        let calls = 0;
        const client = new MockLLMClient([
            { content: 'first try' },
            { content: 'second try' },
        ]);
        const replayHook: AgentHooks = {
            afterLLM(state) {
                calls++;
                if (calls === 1) {
                    state.pending.length = 0;
                }
            },
        };
        const runtime = new AgentRuntime({ store, sessionId: 's5' });
        await runtime.run({
            client,
            systemPrompt: '',
            tools: [],
            keyId: 'k1',
            hooks: [replayHook],
        });
        expect(client.calls.length).toBe(2);
        const tail = store.stored[store.stored.length - 1];
        expect((tail as AssistantMessage).content).toBe('second try');
    });
});
describe('AgentRuntime · built-in guardrail', () => {
    it('halts execution after threshold of failures (counter does not advance for halts)', async () => {
        const store = new MemoryStore([userEvent('keep failing')]);
        const fail = makeFailingTool();
        const responses = Array.from({ length: 7 }, (_, i) => ({
            toolCalls: [{ id: `tc${i}`, name: 'fail', arguments: '{}' }],
        }));
        responses.push({ toolCalls: undefined as never, content: 'ok' });
        const client = new MockLLMClient(responses as never);
        const runtime = new AgentRuntime({ store, sessionId: 's6', plugins: createDefaultBuiltinPlugins() });
        await runtime.run({
            client,
            systemPrompt: '',
            tools: [fail],
            keyId: 'k1',
        });
        expect((fail.execute as unknown as {
            mock: {
                calls: unknown[];
            };
        }).mock.calls.length).toBe(6);
        const toolMsgs = store.stored.filter((m) => m.type === 'tool') as Array<Extract<AgentMessage, {
            type: 'tool';
        }>>;
        expect(toolMsgs.length).toBeGreaterThanOrEqual(7);
        expect(toolMsgs[6].content).toContain('Tool loop halted');
        expect(toolMsgs[6].guidance).toEqual([{ kind: 'tool_loop_warning', warningType: 'exact_failure', toolName: 'fail', count: 6 }]);
    });
    it('persists configured consecutive-success guidance without blocking execution', async () => {
        const store = new MemoryStore([userEvent('send three updates')]);
        const send = makeEchoTool('send_message');
        const client = new MockLLMClient([
            { toolCalls: [{ id: 'send-1', name: 'send_message', arguments: '{"text":"one"}' }] },
            { toolCalls: [{ id: 'send-2', name: 'send_message', arguments: '{"text":"two"}' }] },
            { toolCalls: [{ id: 'send-3', name: 'send_message', arguments: '{"text":"three"}' }] },
            { content: 'done' },
        ]);
        const runtime = new AgentRuntime({
            store,
            sessionId: 's6-success',
            plugins: createDefaultBuiltinPlugins({ guardrailConfig: {
                    consecutiveSuccessTools: {
                        send_message: {
                            warn: 3,
                            message: 'Members already saw the previous messages. Stop unless there is a new visible fact.',
                        },
                    },
                } }),
        });
        await runtime.run({
            client,
            systemPrompt: '',
            tools: [send],
            keyId: 'k1',
        });
        expect(send.calls).toHaveLength(3);
        const toolMsgs = store.stored.filter((m) => m.type === 'tool') as Array<Extract<AgentMessage, {
            type: 'tool';
        }>>;
        expect(toolMsgs[0].guidance).toBeUndefined();
        expect(toolMsgs[1].guidance).toBeUndefined();
        expect(toolMsgs[2].content).toContain('Members already saw the previous messages');
        expect(toolMsgs[2].guidance).toEqual([{
                kind: 'tool_loop_warning',
                warningType: 'consecutive_success',
                toolName: 'send_message',
                count: 3,
                message: 'Members already saw the previous messages. Stop unless there is a new visible fact.',
            }]);
    });
    it('observes concurrent results in model-authored order without serializing execution', async () => {
        const store = new MemoryStore([userEvent('run a parallel batch')]);
        let releaseFirst!: (value: string) => void;
        const firstResult = new Promise<string>((resolve) => { releaseFirst = resolve; });
        const tools: Tool[] = [
            {
                name: 'send_message',
                concurrency: 'serial',
                description: 'controlled send',
                inputSchema: { type: 'object', properties: {} },
                execute: async () => firstResult,
            },
            {
                name: 'other',
                description: 'fast other tool',
                inputSchema: { type: 'object', properties: {} },
                execute: async () => 'other-result',
            },
        ];
        const client = new MockLLMClient([
            {
                toolCalls: [
                    { id: 'ordered-send', name: 'send_message', arguments: '{}' },
                    { id: 'ordered-other', name: 'other', arguments: '{}' },
                ],
            },
            { content: 'done' },
        ]);
        const runtime = new AgentRuntime({
            store,
            sessionId: 's6-ordered',
            plugins: createDefaultBuiltinPlugins({ guardrailConfig: {
                    consecutiveSuccessTools: {
                        send_message: { warn: 2, message: 'send warning' },
                    },
                } }),
        });
        const run = runtime.run({
            client,
            systemPrompt: '',
            tools,
            keyId: 'k1',
        });
        await Promise.resolve();
        releaseFirst('send-result');
        await run;
        const toolMsgs = store.stored.filter((m) => m.type === 'tool') as Array<Extract<AgentMessage, {
            type: 'tool';
        }>>;
        expect(toolMsgs.map((message) => message.toolCallId)).toEqual([
            'ordered-send',
            'ordered-other',
        ]);
        expect(toolMsgs.every((message) => message.guidance === undefined)).toBe(true);
    });
    it('appends existing failure warnings to content as well as typed guidance', async () => {
        const store = new MemoryStore([userEvent('fail twice')]);
        const fail = makeFailingTool();
        const client = new MockLLMClient([
            { toolCalls: [{ id: 'f1', name: 'fail', arguments: '{}' }] },
            { toolCalls: [{ id: 'f2', name: 'fail', arguments: '{}' }] },
            { content: 'done' },
        ]);
        const runtime = new AgentRuntime({ store, sessionId: 's6-warning-content', plugins: createDefaultBuiltinPlugins() });
        await runtime.run({
            client,
            systemPrompt: '',
            tools: [fail],
            keyId: 'k1',
        });
        const second = store.stored.find((message) => message.type === 'tool' && message.toolCallId === 'f2') as Extract<AgentMessage, {
            type: 'tool';
        }> | undefined;
        expect(second?.content).toContain('[Tool loop warning: fail failed 2x');
        expect(second?.guidance).toEqual([{
                kind: 'tool_loop_warning',
                warningType: 'exact_failure',
                toolName: 'fail',
                count: 2,
            }]);
    });
    it('disabling guardrail allows infinite identical failures', async () => {
        const store = new MemoryStore([userEvent('go')]);
        const fail = makeFailingTool();
        const responses = Array.from({ length: 8 }, (_, i) => ({
            toolCalls: [{ id: `tc${i}`, name: 'fail', arguments: '{}' }],
        }));
        responses.push({ toolCalls: undefined as never, content: 'ok' });
        const client = new MockLLMClient(responses as never);
        const runtime = new AgentRuntime({ store, sessionId: 's6b', plugins: createDefaultBuiltinPlugins({ guardrail: false }) });
        await runtime.run({
            client,
            systemPrompt: '',
            tools: [fail],
            keyId: 'k1',
        });
        expect((fail.execute as unknown as {
            mock: {
                calls: unknown[];
            };
        }).mock.calls.length).toBe(8);
    });
});
describe('AgentRuntime · hooks mutate state.systemPrompt mid-run', () => {
    it('beforeTurn rewrites systemPrompt; LLM sees the new value', async () => {
        const store = new MemoryStore([userEvent('hi')]);
        const client = new MockLLMClient([{ content: 'fine' }]);
        const hook: AgentHooks = {
            beforeTurn(state) {
                state.systemPrompt = 'rewritten';
            },
        };
        const runtime = new AgentRuntime({ store, sessionId: 's7' });
        await runtime.run({
            client,
            systemPrompt: 'original',
            tools: [],
            keyId: 'k1',
            hooks: [hook],
        });
        expect(client.calls[0].systemPrompt).toBe('rewritten');
    });
});
describe('AgentRuntime · multiple hook bags run sequentially', () => {
    it('two bags both registering afterFetch run in order each iteration', async () => {
        const store = new MemoryStore([userEvent('order')]);
        const client = new MockLLMClient([{ content: 'fine' }]);
        const trace: string[] = [];
        const bag1: AgentHooks = {
            afterFetch() {
                trace.push('bag1');
            },
        };
        const bag2: AgentHooks = {
            afterFetch() {
                trace.push('bag2');
            },
        };
        const runtime = new AgentRuntime({ store, sessionId: 's8' });
        await runtime.run({
            client,
            systemPrompt: '',
            tools: [],
            keyId: 'k1',
            hooks: [bag1, bag2],
        });
        expect(trace.length % 2).toBe(0);
        for (let i = 0; i < trace.length; i += 2) {
            expect(trace[i]).toBe('bag1');
            expect(trace[i + 1]).toBe('bag2');
        }
        expect(trace.length).toBeGreaterThanOrEqual(2);
    });
});
describe('AgentRuntime · UsageRecorder is called once per turn with correct entry', () => {
    it('aggregates token counters across LLM calls', async () => {
        const store = new MemoryStore([userEvent('count')]);
        const client = new MockLLMClient([
            {
                toolCalls: [{ id: 't1', name: 'echo', arguments: '{"text":"a"}' }],
                usage: { promptTokens: 100, completionTokens: 10, cachedTokens: 5 },
            },
            {
                content: 'fin',
                usage: { promptTokens: 200, completionTokens: 20 },
            },
        ]);
        const usage = new CapturingUsageRecorder();
        const runtime = new AgentRuntime({ store, sessionId: 's9', usage });
        await runtime.run({
            client,
            systemPrompt: '',
            tools: [makeEchoTool()],
            keyId: 'team-x:abcd',
        });
        expect(usage.entries.length).toBe(1);
        const e = usage.entries[0];
        expect(e.keyId).toBe('team-x:abcd');
        expect(e.sessionId).toBe('s9');
        expect(e.numLLMCalls).toBe(2);
        expect(e.inputTokens).toBe(300);
        expect(e.lastInputTokens).toBe(200);
        expect(e.outputTokens).toBe(30);
        expect(e.cachedTokens).toBe(5);
        expect(e.exitKind).toBe('done');
        expect(e.durationMs).toBeGreaterThanOrEqual(0);
    });
    it('records usdCost when LLM reports it', async () => {
        const store = new MemoryStore([userEvent('cost')]);
        const client = new MockLLMClient([
            {
                content: 'fine',
                usage: { promptTokens: 100, completionTokens: 10, usdCost: 0.0123 },
            },
        ]);
        const usage = new CapturingUsageRecorder();
        const runtime = new AgentRuntime({ store, sessionId: 's9b', usage });
        await runtime.run({
            client,
            systemPrompt: '',
            tools: [],
            keyId: 'k1',
        });
        expect(usage.entries[0].usdCost).toBeCloseTo(0.0123);
    });
    it('lastInputTokens defaults to promptTokens when contextTokens is absent', async () => {
        const store = new MemoryStore([userEvent('hi')]);
        const client = new MockLLMClient([{ content: 'fin', usage: { promptTokens: 100, completionTokens: 10, cachedTokens: 5 } }], 'openai');
        const usage = new CapturingUsageRecorder();
        const runtime = new AgentRuntime({ store, sessionId: 's9c', usage });
        await runtime.run({
            client,
            systemPrompt: '',
            tools: [],
            keyId: 'k1',
        });
        const e = usage.entries[0];
        expect(e.lastInputTokens).toBe(100);
        expect(e.inputTokens).toBe(100);
        expect(e.cachedTokens).toBe(5);
    });
    it('lastInputTokens uses inclusive contextTokens without changing promptTokens accounting', async () => {
        const store = new MemoryStore([userEvent('hi')]);
        const client = new MockLLMClient([
            {
                content: 'fin',
                usage: {
                    promptTokens: 100,
                    completionTokens: 10,
                    cachedTokens: 5,
                    cacheCreationTokens: 7,
                    contextTokens: 112,
                },
            },
        ], 'anthropic');
        const usage = new CapturingUsageRecorder();
        const runtime = new AgentRuntime({ store, sessionId: 's9d', usage });
        await runtime.run({
            client,
            systemPrompt: '',
            tools: [],
            keyId: 'k1',
        });
        const e = usage.entries[0];
        expect(e.lastInputTokens).toBe(112);
        expect(e.inputTokens).toBe(100);
        expect(e.cachedTokens).toBe(5);
    });
});
describe('AgentRuntime · interleave persist when message arrives mid-tool', () => {
    it('rewrites tool message into tool.result event so user msg slots in before it', async () => {
        const store = new MemoryStore([userEvent('go')]);
        const client = new MockLLMClient([
            { toolCalls: [{ id: 'tc1', name: 'echo', arguments: '{"text":"x"}' }] },
            { content: 'done' },
        ]);
        const tool = {
            name: 'echo',
            description: 'echo + side-channel inject',
            inputSchema: { type: 'object', properties: {} },
            async execute(input: Record<string, unknown>) {
                store.enqueue(userEvent('side-channel'));
                return `echo:${input.text}`;
            },
        };
        const runtime = new AgentRuntime({ store, sessionId: 's10' });
        const { events, onEvent } = captureEvents();
        await runtime.run({
            client,
            systemPrompt: '',
            tools: [tool as never],
            keyId: 'k1',
            onEvent,
        });
        const userIdx = store.stored.findIndex((m) => m.type === 'event' && m.eventType === 'message.received' && m.content === 'side-channel');
        const realResultIdx = store.stored.findIndex((m) => m.type === 'event' && m.eventType === 'tool.result');
        expect(userIdx).toBeGreaterThanOrEqual(0);
        expect(realResultIdx).toBeGreaterThan(userIdx);
        const types = events.map((e) => (e as {
            type: string;
        }).type);
        expect(types).toContain('interleave_start');
        const toolCallEnds = events.filter((e) => (e as {
            type: string;
        }).type === 'tool_call_end' && (e as {
            toolCallId?: string;
        }).toolCallId === 'tc1') as Array<{
            type: string;
            toolCallId: string;
            error?: string;
        }>;
        expect(toolCallEnds).toHaveLength(1);
        expect(toolCallEnds[0]?.error).toBeUndefined();
        const endIdx = events.findIndex((e) => (e as {
            type?: string;
            toolCallId?: string;
        }).type === 'tool_call_end'
            && (e as {
                toolCallId?: string;
            }).toolCallId === 'tc1');
        const interleaveIdx = events.findIndex((e) => (e as {
            type?: string;
        }).type === 'interleave_start');
        expect(endIdx).toBeGreaterThan(interleaveIdx);
    });
    it('emits no tool_call_end when event-form interleave result persistence fails', async () => {
        class FailingInterleaveResultStore extends MemoryStore {
            override async persist(messages: AgentMessage[]): Promise<void> {
                if (messages.some((m) => m.type === 'event' && m.eventType === 'tool.result')) {
                    throw new Error('event result persist failed');
                }
                await super.persist(messages);
            }
        }
        const store = new FailingInterleaveResultStore([userEvent('go')]);
        const client = new MockLLMClient([
            { toolCalls: [{ id: 'tc-interleave-fail', name: 'echo', arguments: '{"text":"x"}' }] },
        ]);
        const tool = {
            name: 'echo',
            description: 'echo + side-channel inject',
            inputSchema: { type: 'object', properties: {} },
            async execute(input: Record<string, unknown>) {
                store.enqueue(userEvent('side-channel'));
                return `echo:${input.text}`;
            },
        };
        const { events, onEvent } = captureEvents();
        await new AgentRuntime({ store, sessionId: 's10-fail' }).run({
            client,
            systemPrompt: '',
            tools: [tool as never],
            keyId: 'k1',
            onEvent,
        });
        expect(store.stored.some((m) => m.type === 'tool' && m.toolCallId === 'tc-interleave-fail')).toBe(true);
        expect(store.stored.some((m) => m.type === 'event' && m.eventType === 'tool.result')).toBe(false);
        expect(events.some((e) => (e as {
            type?: string;
            toolCallId?: string;
        }).type === 'tool_call_end'
            && (e as {
                toolCallId?: string;
            }).toolCallId === 'tc-interleave-fail')).toBe(false);
        expect(events.some((e) => (e as {
            type?: string;
        }).type === 'error')).toBe(true);
    });
    it.each([undefined, '[Working...]'])('persists a configurable placeholder (%s) before interleaved user input', async (interleavePlaceholder) => {
        const store = new MemoryStore([userEvent('go')]);
        const client = new MockLLMClient([
            { toolCalls: [{ id: 'tc1', name: 'echo', arguments: '{"text":"x"}' }] },
            { content: 'done' },
        ]);
        const tool = {
            name: 'echo',
            description: 'echo + side-channel inject',
            inputSchema: { type: 'object', properties: {} },
            async execute(input: Record<string, unknown>) {
                store.enqueue(userEvent('side-channel'));
                return `echo:${input.text}`;
            },
        };
        const runtime = new AgentRuntime({ store, sessionId: 's10b', interleavePlaceholder });
        await runtime.run({
            client,
            systemPrompt: '',
            tools: [tool as never],
            keyId: 'k1',
            onEvent: () => { },
        });
        const assistantIdx = store.stored.findIndex((m) => m.type === 'assistant' && (m.toolCalls?.length ?? 0) > 0);
        const placeholderIdx = store.stored.findIndex((m, i) => i > assistantIdx && m.type === 'tool' && m.toolCallId === 'tc1' && m.content === (interleavePlaceholder ?? '[Tool running...]'));
        const userIdx = store.stored.findIndex((m) => m.type === 'event' && m.eventType === 'message.received' && m.content === 'side-channel');
        const realResultIdx = store.stored.findIndex((m) => m.type === 'event' && m.eventType === 'tool.result');
        expect(assistantIdx).toBeGreaterThanOrEqual(0);
        expect(placeholderIdx).toBeGreaterThan(assistantIdx);
        expect(userIdx).toBeGreaterThan(placeholderIdx);
        expect(realResultIdx).toBeGreaterThan(userIdx);
    });
});
describe('AgentRuntime · afterExecTools can rewrite tool result content', () => {
    it('host truncates content; persisted tool message reflects the truncation', async () => {
        const store = new MemoryStore([userEvent('big result')]);
        const big = 'X'.repeat(100000);
        const tool = {
            name: 'big',
            description: '',
            inputSchema: { type: 'object', properties: {} },
            execute: vi.fn(async () => big),
        };
        const client = new MockLLMClient([
            { toolCalls: [{ id: 't1', name: 'big', arguments: '{}' }] },
            { content: 'ok' },
        ]);
        const truncateHook: AgentHooks = {
            afterExecTools(state) {
                for (let i = 0; i < state.pending.length; i++) {
                    const m = state.pending[i];
                    if (m.type !== 'tool')
                        continue;
                    if (m.content.length > 100) {
                        state.pending[i] = {
                            ...m,
                            content: m.content.slice(0, 100) + '…',
                        };
                    }
                }
            },
        };
        const runtime = new AgentRuntime({ store, sessionId: 's11' });
        await runtime.run({
            client,
            systemPrompt: '',
            tools: [tool as never],
            keyId: 'k1',
            hooks: [truncateHook],
        });
        const persisted = store.stored.find((m) => m.type === 'tool') as Extract<AgentMessage, {
            type: 'tool';
        }> | undefined;
        expect(persisted?.content.length).toBeLessThan(200);
        expect(persisted?.content.endsWith('…')).toBe(true);
    });
});
describe('AgentRuntime · empty LLM response ends turn cleanly', () => {
    it.each([null, '', '   '])('offers %j terminal content to afterLLM before ending', async (content) => {
        const store = new MemoryStore([userEvent('reply')]);
        const client = new MockLLMClient([{ content }]);
        const afterLLM = vi.fn();
        const runtime = new AgentRuntime({ store, sessionId: 'empty-hook' });
        await runtime.run({ client, systemPrompt: '', tools: [], keyId: 'k1', hooks: { afterLLM } });
        expect(afterLLM).toHaveBeenCalledOnce();
        expect(client.calls).toHaveLength(1);
        if (content) {
            expect(store.stored.at(-1)).toMatchObject({ type: 'assistant', content });
        }
        else {
            expect(store.stored.some((m) => m.type === 'assistant')).toBe(false);
        }
    });
    it('lets the existing afterLLM hook continue an empty response with a persisted event', async () => {
        const store = new MemoryStore([userEvent('reply')]);
        const client = new MockLLMClient([{ content: null }, { content: 'recovered' }]);
        const runtime = new AgentRuntime({ store, sessionId: 'empty-hook-recovery' });
        await runtime.run({
            client, systemPrompt: '', tools: [], keyId: 'k1',
            hooks: {
                afterLLM(state) {
                    const last = state.pending.at(-1);
                    if (last?.type === 'assistant' && !last.content) {
                        state.pending.pop();
                        state.pending.push({ type: 'event', eventType: 'agent.self_reminder', content: 'continue', timestamp: new Date() });
                    }
                },
            },
        });
        expect(client.calls).toHaveLength(2);
        expect(store.stored.some((m) => m.type === 'assistant' && !m.content)).toBe(false);
        expect(store.stored.at(-1)).toMatchObject({ type: 'assistant', content: 'recovered' });
    });
    it('no infinite loop when LLM returns empty content + no tools + no reasoning', async () => {
        const store = new MemoryStore([userEvent('think hard')]);
        const client = new MockLLMClient([
            { content: null, usage: { promptTokens: 50, completionTokens: 0 } },
        ]);
        const runtime = new AgentRuntime({ store, sessionId: 's12' });
        await runtime.run({
            client,
            systemPrompt: '',
            tools: [],
            keyId: 'k1',
        });
        expect(client.calls.length).toBe(1);
    });
});
describe('AgentRuntime · user event arriving after a finalised assistant', () => {
    it('tail = user event (after a previous final assistant) → calls LLM, does NOT exit', async () => {
        const store = new MemoryStore([
            userEvent('hi'),
            {
                type: 'assistant',
                content: 'previous final reply',
                timestamp: new Date(),
            },
            userEvent('and one more thing'),
        ]);
        const client = new MockLLMClient([{ content: 'replying to follow-up' }]);
        const runtime = new AgentRuntime({ store, sessionId: 's-tailuser' });
        await runtime.run({
            client,
            systemPrompt: '',
            tools: [],
            keyId: 'k1',
        });
        expect(client.calls.length).toBe(1);
        const tail = store.stored[store.stored.length - 1];
        expect(tail.type).toBe('assistant');
        expect((tail as AssistantMessage).content).toBe('replying to follow-up');
    });
    it('tail = previous tool result (no terminal assistant yet) → calls LLM', async () => {
        const store = new MemoryStore([
            userEvent('do it'),
            {
                type: 'assistant',
                content: null,
                toolCalls: [{ id: 'tc1', name: 'echo', arguments: '{"text":"x"}' }],
                timestamp: new Date(),
            },
            {
                type: 'tool',
                toolCallId: 'tc1',
                content: 'echo:x',
                isError: false,
                timestamp: new Date(),
            },
        ]);
        const client = new MockLLMClient([{ content: 'wrap' }]);
        const runtime = new AgentRuntime({ store, sessionId: 's-tailtool' });
        await runtime.run({
            client,
            systemPrompt: '',
            tools: [makeEchoTool()],
            keyId: 'k1',
        });
        expect(client.calls.length).toBe(1);
        const tail = store.stored[store.stored.length - 1];
        expect((tail as AssistantMessage).content).toBe('wrap');
    });
});
describe('AgentRuntime · pod-restart recovery', () => {
    it('tail = final assistant (no toolCalls) → exits done without LLM call', async () => {
        const store = new MemoryStore([
            userEvent('hi'),
            { type: 'assistant', content: 'finished previously', timestamp: new Date() },
        ]);
        const client = new MockLLMClient([{ content: 'should not run' }]);
        const usage = new CapturingUsageRecorder();
        const runtime = new AgentRuntime({ store, sessionId: 's13', usage });
        await runtime.run({
            client,
            systemPrompt: '',
            tools: [],
            keyId: 'k1',
        });
        expect(client.calls.length).toBe(0);
        expect(usage.entries[0].exitKind).toBe('done');
    });
    it('tail = assistant + partial tool results → calls LLM with current context (no implicit re-execution)', async () => {
        const partialAssistant: AssistantMessage = {
            type: 'assistant',
            content: null,
            toolCalls: [
                { id: 'tc1', name: 'echo', arguments: '{"text":"a"}' },
                { id: 'tc2', name: 'echo', arguments: '{"text":"b"}' },
            ],
            timestamp: new Date(),
        };
        const fulfilledResult: AgentMessage = {
            type: 'tool',
            toolCallId: 'tc1',
            content: 'echo:a-old',
            isError: false,
            timestamp: new Date(),
        };
        const store = new MemoryStore([
            userEvent('go'),
            partialAssistant,
            fulfilledResult,
        ]);
        const echo = makeEchoTool();
        const client = new MockLLMClient([{ content: 'fin' }]);
        const runtime = new AgentRuntime({ store, sessionId: 's13b' });
        await runtime.run({
            client,
            systemPrompt: '',
            tools: [echo],
            keyId: 'k1',
        });
        expect(echo.calls).toEqual([]);
        expect(client.calls.length).toBe(1);
    });
});
describe('AgentRuntime · afterPersist runs after pending is flushed', () => {
    it('afterPersist sees the assistant in messages, pending empty', async () => {
        const store = new MemoryStore([userEvent('hi')]);
        const client = new MockLLMClient([{ content: 'fine' }]);
        let observedPendingLen = -1;
        let observedTailType = '';
        const hook: AgentHooks = {
            afterPersist(state) {
                observedPendingLen = state.pending.length;
                observedTailType = state.messages[state.messages.length - 1]?.type ?? '';
            },
        };
        const runtime = new AgentRuntime({ store, sessionId: 's14' });
        await runtime.run({
            client,
            systemPrompt: '',
            tools: [],
            keyId: 'k1',
            hooks: [hook],
        });
        expect(observedPendingLen).toBe(0);
        expect(observedTailType).toBe('assistant');
    });
});
describe('AgentRuntime · afterFetch can inject business events into pending', () => {
    it('injected event message gets persisted alongside LLM output', async () => {
        const store = new MemoryStore([userEvent('hi')]);
        const client = new MockLLMClient([{ content: 'fine' }]);
        const injectHook: AgentHooks = {
            afterFetch(state) {
                if (state.loopIteration !== 1)
                    return;
                state.pending.push({
                    type: 'event',
                    eventType: 'business.injected',
                    content: 'system note',
                    timestamp: new Date(),
                });
            },
        };
        const runtime = new AgentRuntime({ store, sessionId: 's16' });
        await runtime.run({
            client,
            systemPrompt: '',
            tools: [],
            keyId: 'k1',
            hooks: [injectHook],
        });
        const injectedEv = store.stored.find((m) => m.type === 'event' && m.eventType === 'business.injected');
        expect(injectedEv).toBeDefined();
    });
});
describe('AgentRuntime · setting exit in a hook short-circuits later hooks', () => {
    it('once afterFetch sets exit, afterLLM never runs', async () => {
        const store = new MemoryStore([userEvent('hi')]);
        const client = new MockLLMClient([{ content: 'fine' }]);
        let afterLLMCalled = false;
        const hooks: AgentHooks = {
            afterFetch(state) {
                state.exit = { kind: 'skip' };
            },
            afterLLM() {
                afterLLMCalled = true;
            },
        };
        const runtime = new AgentRuntime({ store, sessionId: 's15' });
        await runtime.run({
            client,
            systemPrompt: '',
            tools: [],
            keyId: 'k1',
            hooks: [hooks],
        });
        expect(afterLLMCalled).toBe(false);
    });
    it('afterFetch persists an injected assistant/tool pair before exit=skip', async () => {
        const store = new MemoryStore([userEvent('system.send')]);
        const client = new MockLLMClient([{ content: 'must not run' }]);
        const toolCallId = 'mock_system_send_1';
        const hooks: AgentHooks = {
            afterFetch(state) {
                state.pending.push({
                    type: 'assistant',
                    content: null,
                    toolCalls: [{
                            id: toolCallId,
                            name: 'send_message',
                            arguments: JSON.stringify({ mode: 'chat', messages: [{ content: 'hello' }] }),
                        }],
                    timestamp: new Date(),
                }, {
                    type: 'tool',
                    toolCallId,
                    content: '消息已发送成功。(系统旁路下发)',
                    timestamp: new Date(),
                });
                state.exit = { kind: 'skip' };
            },
        };
        const runtime = new AgentRuntime({ store, sessionId: 'system-send-skip' });
        await runtime.run({
            client,
            systemPrompt: '',
            tools: [],
            keyId: 'k1',
            hooks: [hooks],
        });
        expect(client.calls).toHaveLength(0);
        expect(store.stored.slice(-2)).toMatchObject([
            { type: 'assistant', toolCalls: [{ id: toolCallId, name: 'send_message' }] },
            { type: 'tool', toolCallId, content: '消息已发送成功。(系统旁路下发)' },
        ]);
    });
    it('afterExecTools persists the completed tool batch before exit=skip', async () => {
        const base = new MemoryStore([userEvent('wait')]);
        let sawToolEndBeforePersist = false;
        let toolPersisted = false;
        const store = {
            stored: base.stored,
            inbox: base.inbox,
            loadAll: base.loadAll.bind(base),
            fetchNew: base.fetchNew.bind(base),
            hasNew: base.hasNew.bind(base),
            persist: async (messages: AgentMessage[]) => {
                base.stored.push(...messages);
                if (messages.some((m) => m.type === 'tool'))
                    toolPersisted = true;
            },
        };
        const echo = makeEchoTool();
        const client = new MockLLMClient([
            { toolCalls: [{ id: 'tc-skip', name: 'echo', arguments: '{"text":"done"}' }] },
            { content: 'must not run' },
        ]);
        const hooks: AgentHooks = {
            afterExecTools(state) {
                state.exit = { kind: 'skip' };
            },
        };
        const runtime = new AgentRuntime({ store, sessionId: 'tool-skip' });
        const { events, onEvent: capture } = captureEvents();
        const onEvent = (event: Parameters<typeof capture>[0]) => {
            if ((event as {
                type?: string;
            }).type === 'tool_call_end' && !toolPersisted) {
                sawToolEndBeforePersist = true;
            }
            capture(event);
        };
        await runtime.run({
            client,
            systemPrompt: '',
            tools: [echo],
            keyId: 'k1',
            hooks: [hooks],
            onEvent,
        });
        expect(client.calls).toHaveLength(1);
        expect(store.stored.slice(-2)).toMatchObject([
            { type: 'assistant', toolCalls: [{ id: 'tc-skip', name: 'echo' }] },
            { type: 'tool', toolCallId: 'tc-skip', content: 'echo:done' },
        ]);
        expect(events.some((e) => (e as {
            type?: string;
            toolCallId?: string;
        }).type === 'tool_call_end'
            && (e as {
                toolCallId?: string;
            }).toolCallId === 'tc-skip')).toBe(true);
        expect(sawToolEndBeforePersist).toBe(false);
    });
});
describe('AgentRuntime · formatMessagesForLLM hook', () => {
    it('without formatter: client receives raw canonical messages', async () => {
        const store = new MemoryStore([userEvent('Hello')]);
        const client = new MockLLMClient([{ content: 'fine' }]);
        const runtime = new AgentRuntime({ store, sessionId: 'fmt-noop' });
        await runtime.run({
            client,
            systemPrompt: '',
            tools: [],
            keyId: 'k1',
        });
        const seen = client.calls[0].messages as AgentMessage[];
        const ev = seen.find((m) => m.type === 'event');
        expect(ev?.content).toBe('Hello');
    });
    it('with formatter: client receives formatted messages; state.messages stays raw', async () => {
        const store = new MemoryStore([userEvent('Hello', 'u-alice')]);
        const client = new MockLLMClient([{ content: 'fine' }]);
        const formatter = vi.fn(async (msgs: AgentMessage[]) => msgs.map((m) => m.type === 'event'
            ? { ...m, content: `[from ${(m.meta as {
                    userId?: string;
                })?.userId}] ${m.content}` }
            : m));
        let observedTailContent: string | undefined;
        const observer: AgentHooks = {
            afterPersist(state) {
                const ev = state.messages.find((m) => m.type === 'event');
                observedTailContent = ev?.content;
            },
        };
        const runtime = new AgentRuntime({
            store,
            sessionId: 'fmt-applied',
            formatMessagesForLLM: formatter,
        });
        await runtime.run({
            client,
            systemPrompt: '',
            tools: [],
            keyId: 'k1',
            hooks: [observer],
        });
        expect(formatter).toHaveBeenCalledTimes(1);
        const seen = client.calls[0].messages as AgentMessage[];
        const formattedEv = seen.find((m) => m.type === 'event');
        expect(formattedEv?.content).toBe('[from u-alice] Hello');
        expect(observedTailContent).toBe('Hello');
        const storedEv = store.stored.find((m) => m.type === 'event');
        expect(storedEv?.content).toBe('Hello');
    });
    it('formatter throws → fallback to raw messages + warn log; turn still completes', async () => {
        const store = new MemoryStore([userEvent('Hi')]);
        const client = new MockLLMClient([{ content: 'fine' }]);
        const warn = vi.fn();
        const logger = {
            debug: vi.fn(),
            info: vi.fn(),
            warn,
            error: vi.fn(),
        };
        const formatter = vi.fn(async () => {
            throw new Error('boom in formatter');
        });
        const runtime = new AgentRuntime({
            store,
            sessionId: 'fmt-throws',
            formatMessagesForLLM: formatter,
            logger,
        });
        await runtime.run({
            client,
            systemPrompt: '',
            tools: [],
            keyId: 'k1',
        });
        expect(client.calls.length).toBe(1);
        const seen = client.calls[0].messages as AgentMessage[];
        expect(seen.find((m) => m.type === 'event')?.content).toBe('Hi');
        expect(warn).toHaveBeenCalled();
        const warnArgs = warn.mock.calls[0];
        expect(warnArgs[1]).toMatch(/formatMessagesForLLM/);
        const ctx = warnArgs[0] as {
            err?: Error;
        };
        expect(ctx.err).toBeInstanceOf(Error);
        expect((ctx.err as Error).message).toBe('boom in formatter');
        const tail = store.stored[store.stored.length - 1];
        expect(tail.type).toBe('assistant');
    });
});
describe('AgentRuntime · stream event ordering', () => {
    it('emits thinking_end before tool_input_start when LLM streams thinking → tool_use', async () => {
        const store = new MemoryStore([userEvent('Use the tool')]);
        const echo = makeEchoTool();
        const client = new MockLLMClient([
            {
                toolCalls: [{ id: 'tc1', name: 'echo', arguments: '{"text":"hi"}' }],
                streamDeltas: [
                    { type: 'thinking', content: 'pondering…' },
                    { type: 'thinking', content: ' more…' },
                    { type: 'tool_input_start', content: '', toolCallId: 'tc1', toolName: 'echo' },
                ],
            },
            { content: 'Done.' },
        ]);
        const runtime = new AgentRuntime({ store, sessionId: 's-stream-order' });
        const { events, onEvent } = captureEvents();
        await runtime.run({
            client,
            systemPrompt: '',
            tools: [echo],
            keyId: 'k1',
            onEvent,
        });
        const types = events.map((e) => (e as {
            type: string;
        }).type);
        const idxThinkingStart = types.indexOf('thinking_start');
        const idxThinkingEnd = types.indexOf('thinking_end');
        const idxToolInputStart = types.indexOf('tool_input_start');
        expect(idxThinkingStart).toBeGreaterThanOrEqual(0);
        expect(idxThinkingEnd).toBeGreaterThanOrEqual(0);
        expect(idxToolInputStart).toBeGreaterThanOrEqual(0);
        expect(idxThinkingEnd).toBeGreaterThan(idxThinkingStart);
        expect(idxToolInputStart).toBeGreaterThan(idxThinkingEnd);
        const thinkingEnds = types.filter((t) => t === 'thinking_end');
        expect(thinkingEnds.length).toBe(1);
    });
});
describe('AgentRuntime · state.newMessages', () => {
    it('exposes the top-of-loop fetch batch on afterFetch (and is [] when empty)', async () => {
        const store = new MemoryStore([userEvent('Hello')]);
        store.enqueue(userEvent('and another'));
        const client = new MockLLMClient([{ content: 'Hi.' }]);
        const seenBatches: AgentMessage[][] = [];
        const captureHook: AgentHooks = {
            afterFetch(state) {
                seenBatches.push([...state.newMessages]);
            },
        };
        const runtime = new AgentRuntime({ store, sessionId: 's-newmsgs-1' });
        await runtime.run({
            client,
            systemPrompt: '',
            tools: [],
            keyId: 'k1',
            hooks: [captureHook],
        });
        expect(seenBatches.length).toBeGreaterThanOrEqual(2);
        expect(seenBatches[0].length).toBe(1);
        expect((seenBatches[0][0] as {
            content?: string;
        }).content).toBe('and another');
        const last = seenBatches[seenBatches.length - 1];
        expect(Array.isArray(last)).toBe(true);
        expect(last.length).toBe(0);
    });
    it('initial value before first fetch is []', async () => {
        const store = new MemoryStore([userEvent('Hi')]);
        const client = new MockLLMClient([{ content: 'Hi back.' }]);
        let seenBeforeTurn: readonly AgentMessage[] | undefined;
        const hook: AgentHooks = {
            beforeTurn(state) {
                seenBeforeTurn = state.newMessages;
            },
        };
        const runtime = new AgentRuntime({ store, sessionId: 's-newmsgs-init' });
        await runtime.run({
            client,
            systemPrompt: '',
            tools: [],
            keyId: 'k1',
            hooks: [hook],
        });
        expect(Array.isArray(seenBeforeTurn)).toBe(true);
        expect(seenBeforeTurn?.length).toBe(0);
    });
    it('exposes an interleave fetch exactly once and preserves canonical ordering', async () => {
        const store = new MemoryStore([userEvent('go')]);
        const client = new MockLLMClient([
            { toolCalls: [{ id: 'tc1', name: 'echo', arguments: '{"text":"a"}' }] },
            { content: 'done' },
        ]);
        const interleavedMsg = userEvent('mid-tool inbound');
        const echo: Tool = {
            name: 'echo',
            description: '',
            inputSchema: { type: 'object', properties: {} },
            execute: async () => {
                store.enqueue(interleavedMsg);
                return 'real result';
            },
        };
        const seenBatches: AgentMessage[][] = [];
        const hook: AgentHooks = {
            afterFetch(state) {
                seenBatches.push([...state.newMessages]);
            },
        };
        await new AgentRuntime({ store, sessionId: 's-newmsgs-interleave' }).run({
            client,
            systemPrompt: '',
            tools: [echo],
            keyId: 'k1',
            hooks: [hook],
        });
        const batchesWithInterleavedInput = seenBatches.filter((batch) => batch.some((m) => m === interleavedMsg));
        expect(batchesWithInterleavedInput).toEqual([[interleavedMsg]]);
        const interleaveHookIdx = seenBatches.findIndex((batch) => batch[0] === interleavedMsg);
        expect(seenBatches[interleaveHookIdx + 1]).toEqual([]);
        const persistedTurn = store.stored.slice(1);
        const assistantIdx = persistedTurn.findIndex((m) => m.type === 'assistant' && m.toolCalls?.[0]?.id === 'tc1');
        expect(persistedTurn.slice(assistantIdx, assistantIdx + 4)).toMatchObject([
            { type: 'assistant', toolCalls: [{ id: 'tc1', name: 'echo' }] },
            { type: 'tool', toolCallId: 'tc1', content: '[Tool running...]' },
            { type: 'event', eventType: 'message.received', content: 'mid-tool inbound' },
            { type: 'event', eventType: 'tool.result', content: expect.stringContaining('real result') },
        ]);
    });
    it('does not fire an extra afterFetch when an interleave probe drains no input', async () => {
        class StaleHasNewStore extends MemoryStore {
            private hasNewCalls = 0;
            override async hasNew(): Promise<boolean> {
                this.hasNewCalls += 1;
                return this.hasNewCalls === 1;
            }
        }
        const store = new StaleHasNewStore([userEvent('go')]);
        const client = new MockLLMClient([
            { toolCalls: [{ id: 'tc-empty', name: 'echo', arguments: '{"text":"a"}' }] },
            { content: 'done' },
        ]);
        const hookCalls: AgentMessage[][] = [];
        await new AgentRuntime({ store, sessionId: 's-newmsgs-empty-interleave' }).run({
            client,
            systemPrompt: '',
            tools: [makeEchoTool()],
            keyId: 'k1',
            hooks: [{
                    afterFetch: (state) => hookCalls.push([...state.newMessages]),
                }],
        });
        expect(hookCalls).toEqual([[], [], []]);
    });
    it.each([
        { label: 'requests skip', hook: (state: RuntimeState) => { state.exit = { kind: 'skip' }; }, exitKind: 'skip' },
        { label: 'throws', hook: () => { throw new Error('interleave hook failed'); }, exitKind: 'error' },
    ])('persists completed interleave tool results when afterFetch $label', async ({ hook, exitKind }) => {
        const store = new MemoryStore([userEvent('go')]);
        const client = new MockLLMClient([
            { toolCalls: [{ id: 'tc-exit', name: 'echo', arguments: '{}' }] },
            { content: 'must not run' },
        ]);
        const midTurnInput = userEvent('stop after this input');
        const usage = new CapturingUsageRecorder();
        const tool: Tool = {
            name: 'echo',
            description: '',
            inputSchema: { type: 'object', properties: {} },
            execute: async () => {
                store.enqueue(midTurnInput);
                return 'already-completed real result';
            },
        };
        const { events, onEvent } = captureEvents();
        await new AgentRuntime({
            store,
            sessionId: 's-newmsgs-interleave-exit',
            usage,
        }).run({
            client,
            systemPrompt: '',
            tools: [tool],
            keyId: 'k1',
            hooks: [{
                    afterFetch(state) {
                        if (state.newMessages.includes(midTurnInput))
                            hook(state);
                    },
                }],
            onEvent,
        });
        expect(client.calls).toHaveLength(1);
        expect(store.stored.slice(1)).toMatchObject([
            { type: 'assistant', toolCalls: [{ id: 'tc-exit', name: 'echo' }] },
            { type: 'tool', toolCallId: 'tc-exit', content: '[Tool running...]' },
            { type: 'event', eventType: 'message.received', content: 'stop after this input' },
            {
                type: 'event',
                eventType: 'tool.result',
                content: expect.stringContaining('already-completed real result'),
            },
        ]);
        expect(events.filter((e) => (e as {
            type?: string;
            toolCallId?: string;
        }).type === 'tool_call_end'
            && (e as {
                toolCallId?: string;
            }).toolCallId === 'tc-exit')).toHaveLength(1);
        expect(usage.entries).toHaveLength(1);
        expect(usage.entries[0].exitKind).toBe(exitKind);
    });
});
describe('AgentRuntime · interleave trailing hook messages', () => {
    const injection = (content: string): AgentMessage => ({
        type: 'system_injection', content, timestamp: new Date(),
    });
    it.each(['system_injection', 'event'] as const)('persists afterExecTools %s after the complete placeholder/user/result sequence', async (type) => {
        const store = new MemoryStore([userEvent('go')]);
        const trailing: AgentMessage = type === 'system_injection'
            ? injection('<scenario-guidance>tool guidance</scenario-guidance>')
            : { ...userEvent('business follow-up'), eventType: 'business.injected' };
        const client = new MockLLMClient([
            { toolCalls: [{ id: 'tc1', name: 'echo', arguments: '{}' }, { id: 'tc2', name: 'echo', arguments: '{}' }] },
            { content: 'done' },
        ]);
        await new AgentRuntime({ store, sessionId: 'trailing-exec' }).run({
            client, systemPrompt: '', keyId: 'k1', tools: [{
                    ...makeEchoTool(), execute: async () => 'real result',
                }],
            hooks: { afterExecTools(state) {
                    store.enqueue(userEvent('mid-tool input'));
                    state.pending.push(trailing);
                } },
        });
        expect(store.stored.slice(1, 8)).toMatchObject([
            { type: 'assistant', toolCalls: [{ id: 'tc1' }, { id: 'tc2' }] },
            { type: 'tool', toolCallId: 'tc1', content: '[Tool running...]' },
            { type: 'tool', toolCallId: 'tc2', content: '[Tool running...]' },
            { type: 'event', content: 'mid-tool input' },
            { type: 'event', eventType: 'tool.result' },
            { type: 'event', eventType: 'tool.result' },
            trailing,
        ]);
        expect(validateSystemInjectionPlacement(store.stored.slice(0, 7))).toEqual({ ok: true });
        expect(client.calls[1].messages).toContainEqual(trailing);
    });
    it.each(['continue', 'skip', 'error'] as const)('flushes interleave afterFetch output on %s', async (exit) => {
        const store = new MemoryStore([userEvent('go')]);
        const mid = userEvent('mid-tool input');
        const before = userEvent('afterExecTools follow-up');
        const trailing = injection('afterFetch guidance');
        const client = new MockLLMClient([
            { toolCalls: [{ id: 'tc1', name: 'echo', arguments: '{}' }] },
            { content: 'done' },
        ]);
        const usage = new CapturingUsageRecorder();
        let finalState: RuntimeState | undefined;
        await new AgentRuntime({ store, sessionId: 'trailing-fetch', usage }).run({
            client, systemPrompt: '', keyId: 'k1', tools: [{
                    ...makeEchoTool(), execute: async () => { store.enqueue(mid); return 'real result'; },
                }],
            hooks: {
                afterExecTools(state) { state.pending.push(before); },
                afterFetch(state) {
                    if (!state.newMessages.includes(mid))
                        return;
                    state.pending.push(trailing);
                    if (exit === 'skip')
                        state.exit = { kind: 'skip' };
                    if (exit === 'error')
                        throw new Error('hook failed after injection');
                },
                afterTurn(state) { finalState = state; },
            },
        });
        expect(store.stored.slice(1, 7)).toMatchObject([
            { type: 'assistant' }, { type: 'tool', content: '[Tool running...]' }, mid,
            { type: 'event', eventType: 'tool.result' }, before, trailing,
        ]);
        expect(validateSystemInjectionPlacement(store.stored.slice(0, 6))).toEqual({ ok: true });
        expect(finalState?.pending).toEqual([]);
        expect(client.calls).toHaveLength(exit === 'continue' ? 2 : 1);
        expect(usage.entries[0].exitKind).toBe(exit === 'continue' ? 'done' : exit);
        if (exit === 'continue')
            expect(client.calls[1].messages).toContainEqual(trailing);
    });
    it('flushes hook output even when no pending tool results remain', async () => {
        const store = new MemoryStore([userEvent('go')]);
        const trailing = injection('no-tool guidance');
        const client = new MockLLMClient([
            { toolCalls: [{ id: 'tc1', name: 'echo', arguments: '{}' }] }, { content: 'done' },
        ]);
        await new AgentRuntime({ store, sessionId: 'trailing-no-tools' }).run({
            client, systemPrompt: '', keyId: 'k1', tools: [makeEchoTool()],
            hooks: { afterExecTools(state) {
                    state.pending = [trailing];
                    store.enqueue(userEvent('mid-tool input'));
                } },
        });
        expect(store.stored.slice(1, 3)).toMatchObject([
            { type: 'event', content: 'mid-tool input' }, trailing,
        ]);
        expect(client.calls[1].messages).toContainEqual(trailing);
    });
    it.each(['assistant', 'placeholder', 'fetch', 'result', 'trailing'] as const)('retains all unpersisted hook messages when %s persistence fails', async (stage) => {
        const failure = new Error(`${stage} failed`);
        class FailingStore extends MemoryStore {
            override async persist(batch: AgentMessage[]) {
                const first = batch[0];
                if ((stage === 'assistant' && first.type === 'assistant')
                    || (stage === 'placeholder' && first.type === 'tool')
                    || (stage === 'result' && first.type === 'event' && first.eventType === 'tool.result')
                    || (stage === 'trailing' && first.type === 'system_injection'))
                    throw failure;
                await super.persist(batch);
            }
            override async fetchNew() {
                if (stage === 'fetch' && this.inbox.length)
                    throw failure;
                return super.fetchNew();
            }
        }
        const store = new FailingStore([userEvent('go')]);
        const original = injection('original hook output');
        const fetched = userEvent('fetch hook output');
        const mid = userEvent('mid-tool input');
        const client = new MockLLMClient([
            { toolCalls: [{ id: 'tc1', name: 'echo', arguments: '{}' }] },
        ]);
        let finalState: RuntimeState | undefined;
        const usage = new CapturingUsageRecorder();
        await new AgentRuntime({ store, sessionId: 'trailing-failure', usage }).run({
            client, systemPrompt: '', keyId: 'k1', tools: [{
                    ...makeEchoTool(), execute: async () => { store.enqueue(mid); return 'real result'; },
                }],
            hooks: {
                afterExecTools(state) { state.pending.push(original); },
                afterFetch(state) { if (state.newMessages.includes(mid))
                    state.pending.push(fetched); },
                afterTurn(state) { finalState = state; },
            },
        });
        expect(finalState?.exit).toEqual({ kind: 'error', error: failure });
        expect(finalState?.pending).toContainEqual(original);
        if (stage === 'result' || stage === 'trailing')
            expect(finalState?.pending).toContainEqual(fetched);
        if (stage !== 'trailing')
            expect(finalState?.pending).toContainEqual(expect.objectContaining({ type: 'tool', content: 'real result' }));
        expect(store.stored).not.toContainEqual(original);
        expect(usage.entries[0].exitKind).toBe('error');
        expect(client.calls).toHaveLength(1);
    });
    it('makes normal afterFetch injections visible to the very first LLM call', async () => {
        const store = new MemoryStore([userEvent('go')]);
        const trailing = injection('initial scenario guidance');
        const client = new MockLLMClient([
            { toolCalls: [{ id: 'tc1', name: 'echo', arguments: '{}' }] }, { content: 'done' },
        ]);
        await new AgentRuntime({ store, sessionId: 'fetch-visible' }).run({
            client, systemPrompt: '', keyId: 'k1', tools: [{
                    ...makeEchoTool(), execute: async () => { store.enqueue(userEvent('mid-tool input')); return 'real result'; },
                }],
            hooks: { afterFetch(state) { if (state.numLLMCalls === 0)
                    state.pending.push(trailing); } },
        });
        expect(client.calls[0].messages).toContainEqual(trailing);
        expect(store.stored.slice(0, 4)).toMatchObject([
            { type: 'event' }, trailing, { type: 'assistant' }, { type: 'tool' },
        ]);
        expect(validateSystemInjectionPlacement(store.stored.slice(0, 1))).toEqual({ ok: true });
        expect(store.stored.filter((m) => m === trailing)).toHaveLength(1);
    });
});
describe('AgentRuntime · beforeExecTools hook', () => {
    it('fires after assistant pushed to pending, before tool execution and tool_call_start', async () => {
        const store = new MemoryStore([userEvent('Use the tool')]);
        const echo = makeEchoTool();
        const client = new MockLLMClient([
            { toolCalls: [{ id: 'tc1', name: 'echo', arguments: '{"text":"hi"}' }] },
            { content: 'Done.' },
        ]);
        const observed: {
            pendingToolCalls?: string[];
            toolHadRunBefore?: boolean;
        } = {};
        let toolStartObservedAt = -1;
        let hookFiredAt = -1;
        let counter = 0;
        const hook: AgentHooks = {
            beforeExecTools(state) {
                hookFiredAt = ++counter;
                observed.toolHadRunBefore = echo.calls.length > 0;
                const tail = state.pending[state.pending.length - 1];
                if (tail?.type === 'assistant' && tail.toolCalls) {
                    observed.pendingToolCalls = tail.toolCalls.map((tc) => tc.id);
                }
            },
        };
        const runtime = new AgentRuntime({ store, sessionId: 's-beforeExec' });
        const events: AgentEvent[] = [];
        await runtime.run({
            client,
            systemPrompt: '',
            tools: [echo],
            keyId: 'k1',
            hooks: [hook],
            onEvent: (e) => {
                if ((e as {
                    type: string;
                }).type === 'tool_call_start' && toolStartObservedAt < 0) {
                    toolStartObservedAt = ++counter;
                }
                events.push(e);
            },
        });
        expect(observed.pendingToolCalls).toEqual(['tc1']);
        expect(observed.toolHadRunBefore).toBe(false);
        expect(hookFiredAt).toBeGreaterThan(0);
        expect(toolStartObservedAt).toBeGreaterThan(hookFiredAt);
    });
    it('throw sets exit.kind=error and skips tool execution', async () => {
        const store = new MemoryStore([userEvent('Use the tool')]);
        const echo = makeEchoTool();
        const client = new MockLLMClient([
            { toolCalls: [{ id: 'tc1', name: 'echo', arguments: '{"text":"hi"}' }] },
        ]);
        const usage = new CapturingUsageRecorder();
        const hook: AgentHooks = {
            beforeExecTools() {
                throw new Error('preflight refused');
            },
        };
        const runtime = new AgentRuntime({ store, sessionId: 's-beforeExec-throw', usage });
        await runtime.run({
            client,
            systemPrompt: '',
            tools: [echo],
            keyId: 'k1',
            hooks: [hook],
        });
        expect(echo.calls.length).toBe(0);
        expect(usage.entries[0].exitKind).toBe('error');
    });
});
describe('AgentRuntime · afterAssistantPersist hook', () => {
    it('fires once per assistant in a multi-call turn with the persisted msg', async () => {
        const store = new MemoryStore([userEvent('go')]);
        const echo = makeEchoTool();
        const client = new MockLLMClient([
            { toolCalls: [{ id: 'tc1', name: 'echo', arguments: '{"text":"a"}' }] },
            { content: 'final' },
        ]);
        const seen: Array<{
            content: string | null;
            toolCalls: number;
        }> = [];
        const hook: AgentHooks = {
            afterAssistantPersist(_state, msg) {
                seen.push({
                    content: msg.content,
                    toolCalls: msg.toolCalls?.length ?? 0,
                });
            },
        };
        const runtime = new AgentRuntime({ store, sessionId: 's-aap-multi' });
        await runtime.run({
            client,
            systemPrompt: '',
            tools: [echo],
            keyId: 'k1',
            hooks: [hook],
        });
        expect(seen.length).toBe(2);
        expect(seen[0].toolCalls).toBe(1);
        expect(seen[1].content).toBe('final');
    });
    it('throw sets exit.kind=error', async () => {
        const store = new MemoryStore([userEvent('hi')]);
        const client = new MockLLMClient([{ content: 'whatever' }]);
        const usage = new CapturingUsageRecorder();
        const hook: AgentHooks = {
            afterAssistantPersist() {
                throw new Error('observer blew up');
            },
        };
        const runtime = new AgentRuntime({ store, sessionId: 's-aap-throw', usage });
        await runtime.run({
            client,
            systemPrompt: '',
            tools: [],
            keyId: 'k1',
            hooks: [hook],
        });
        expect(usage.entries[0].exitKind).toBe('error');
    });
});
describe('AgentRuntime · formatMessagesForLLM array form', () => {
    it('reduces a chain left-to-right; single Fn keeps old behavior', async () => {
        const store = new MemoryStore([userEvent('Hello', 'u-1')]);
        const client = new MockLLMClient([{ content: 'ok' }]);
        const f1 = vi.fn(async (msgs: AgentMessage[]) => msgs.map((m) => m.type === 'event' ? { ...m, content: `<<${m.content}>>` } : m));
        const f2 = vi.fn(async (msgs: AgentMessage[]) => msgs.map((m) => m.type === 'event' ? { ...m, content: `[wrapped] ${m.content}` } : m));
        const runtime = new AgentRuntime({
            store,
            sessionId: 's-fmt-array',
            formatMessagesForLLM: [f1, f2],
        });
        await runtime.run({
            client,
            systemPrompt: '',
            tools: [],
            keyId: 'k1',
        });
        expect(f1).toHaveBeenCalledTimes(1);
        expect(f2).toHaveBeenCalledTimes(1);
        const seen = client.calls[0].messages as AgentMessage[];
        expect(seen.find((m) => m.type === 'event')?.content).toBe('[wrapped] <<Hello>>');
    });
});
describe('AgentRuntime · prefetchHook', () => {
    it('fires once before loadAll; loadAll sees the prefetch-side-effect', async () => {
        const store = new MemoryStore([]);
        const client = new MockLLMClient([{ content: 'ok' }]);
        const order: string[] = [];
        const prefetchHook = vi.fn(async (sid: string) => {
            order.push('prefetch:' + sid);
            store.stored.push(userEvent('hello-from-prefetch'));
        });
        const origLoadAll = store.loadAll.bind(store);
        store.loadAll = async () => {
            order.push('loadAll');
            return origLoadAll();
        };
        const runtime = new AgentRuntime({
            store,
            sessionId: 's-pref',
            prefetchHook,
        });
        await runtime.run({
            client,
            systemPrompt: '',
            tools: [],
            keyId: 'k1',
        });
        expect(prefetchHook).toHaveBeenCalledTimes(1);
        expect(prefetchHook).toHaveBeenCalledWith('s-pref');
        expect(order).toEqual(['prefetch:s-pref', 'loadAll']);
        const seen = client.calls[0].messages as AgentMessage[];
        expect(seen.some((m) => m.type === 'event' && m.content.includes('hello-from-prefetch'))).toBe(true);
    });
    it('prefetchHook throw is caught; turn proceeds with empty store', async () => {
        const store = new MemoryStore([userEvent('hi')]);
        const client = new MockLLMClient([{ content: 'ok' }]);
        const prefetchHook = vi.fn(async () => {
            throw new Error('prefetch failed');
        });
        const runtime = new AgentRuntime({
            store,
            sessionId: 's-pref-err',
            prefetchHook,
        });
        await runtime.run({
            client,
            systemPrompt: '',
            tools: [],
            keyId: 'k1',
        });
        expect(prefetchHook).toHaveBeenCalled();
        expect(client.calls.length).toBe(1);
    });
});
describe('AgentRuntime · largeToolResult step', () => {
    it('replaces over-threshold non-error tool content with preview block', async () => {
        const store = new MemoryStore([userEvent('go')]);
        const big = 'x'.repeat(500);
        const echo = makeEchoTool();
        echo.execute = vi.fn(async () => big);
        const client = new MockLLMClient([
            { toolCalls: [{ id: 'tc-big', name: 'echo', arguments: '{}' }] },
            { content: 'done' },
        ]);
        const writes: Array<{
            name: string;
            content: string;
        }> = [];
        const runtime = new AgentRuntime({
            store,
            sessionId: 's-large',
            plugins: createDefaultBuiltinPlugins({ largeToolResult: {
                    thresholdChars: 100,
                    previewChars: 50,
                    store: {
                        async write(name, content) {
                            writes.push({ name, content });
                            return { uri: `mem://${name}/${writes.length}` };
                        },
                    },
                } }),
        });
        await runtime.run({
            client,
            systemPrompt: '',
            tools: [echo],
            keyId: 'k1',
        });
        expect(writes).toHaveLength(1);
        expect(writes[0]).toMatchObject({ name: 'echo' });
        const toolMsg = store.stored.find((m) => m.type === 'tool') as {
            content: string;
        } | undefined;
        expect(toolMsg).toBeDefined();
        expect(toolMsg!.content).toContain('mem://echo/1');
        expect(toolMsg!.content).not.toBe(big);
    });
    it('does not touch under-threshold tool results', async () => {
        const store = new MemoryStore([userEvent('go')]);
        const echo = makeEchoTool();
        echo.execute = vi.fn(async () => 'short');
        const client = new MockLLMClient([
            { toolCalls: [{ id: 'tc', name: 'echo', arguments: '{}' }] },
            { content: 'done' },
        ]);
        const writes: number[] = [];
        const runtime = new AgentRuntime({
            store,
            sessionId: 's-small',
            plugins: createDefaultBuiltinPlugins({ largeToolResult: {
                    thresholdChars: 100,
                    store: {
                        async write(_, c) {
                            writes.push(c.length);
                            return { uri: 'never' };
                        },
                    },
                } }),
        });
        await runtime.run({
            client,
            systemPrompt: '',
            tools: [echo],
            keyId: 'k1',
        });
        expect(writes).toEqual([]);
        const toolMsg = store.stored.find((m) => m.type === 'tool') as {
            content: string;
        };
        expect(toolMsg.content).toBe('short');
    });
});
describe('AgentRuntime · typed AI post-context', () => {
    it('persists structured tool guidance without appending it to content', async () => {
        const store = new MemoryStore([userEvent('Use the tool')]);
        const tool: Tool = {
            name: 'typed',
            description: 'typed',
            inputSchema: { type: 'object', properties: {} },
            execute: async () => ({
                content: 'business result',
                guidance: [{ kind: 'text', text: 'Approval required' }],
            }),
        };
        const client = new MockLLMClient([
            { toolCalls: [{ id: 'typed-call', name: 'typed', arguments: '{}' }] },
            { content: 'done' },
        ]);
        const runtime = new AgentRuntime({ store, sessionId: 'typed-guidance' });
        await runtime.run({ client, systemPrompt: '', tools: [tool], keyId: 'k' });
        const result = store.stored.find((m) => m.type === 'tool') as Extract<AgentMessage, {
            type: 'tool';
        }>;
        expect(result.content).toBe('business result');
        expect(result.guidance).toEqual([{ kind: 'text', text: 'Approval required' }]);
    });
});
describe('AgentRuntime · normalized client boundary', () => {
    it.each(['unknown-provider', 'anthropic', 'gemini', 'openai'])('persists normalized response metadata from %s without provider lookup', async (provider) => {
        const store = new MemoryStore([userEvent('hi')]);
        const reasoningDetails = [{ type: 'reasoning.encrypted', data: 'opaque/signature==', format: 'future-format', extra: { keep: true } }];
        const client = new MockLLMClient([{ content: 'answer', reasoning: 'reason', reasoningSignature: 'sig' }], provider, 'primary-model');
        const providerSpy = vi.spyOn(client, 'getProviderName').mockImplementation(() => { throw new Error('must not inspect provider'); });
        const originalChat = client.chat.bind(client);
        client.chat = async (request) => ({ ...await originalChat(request), reasoningDetails, stopReason: 'refusal', usedFallbackModel: 'fallback-model' });
        await new AgentRuntime({ store }).run({ client, systemPrompt: 'system', tools: [], keyId: 'k' });
        expect(client.calls[0].messages[0]).toMatchObject({ type: 'event', content: 'hi' });
        expect(client.calls[0].systemPrompt).toBe('system');
        expect(store.stored.at(-1)).toMatchObject({ type: 'assistant', content: 'answer', reasoning: 'reason', reasoningSignature: 'sig', reasoningDetails, model: 'primary-model', stopReason: 'refusal', usedFallbackModel: 'fallback-model' });
        expect(providerSpy).not.toHaveBeenCalled();
    });
    it('uses transient malformed diagnostics but persists only normalized arguments for canonical replay', async () => {
        const store = new MemoryStore([userEvent('go')]);
        const echo = makeEchoTool();
        const client = new MockLLMClient([{ content: null }, { content: 'done' }]);
        const originalChat = client.chat.bind(client);
        client.chat = async (request) => {
            const response = await originalChat(request);
            return client.calls.length === 1 ? { ...response, stopReason: 'tool_use', toolCalls: [{ id: 'broken', name: 'echo', arguments: '{broken', malformedError: 'invalid json' }] } : response;
        };
        await new AgentRuntime({ store }).run({ client, systemPrompt: '', tools: [echo], keyId: 'k' });
        expect(store.stored[1]).toMatchObject({ type: 'assistant', toolCalls: [{ id: 'broken', name: 'echo', arguments: '{}' }] });
        expect((store.stored[1] as import('../types.js').AssistantMessage).toolCalls?.[0]).not.toHaveProperty('malformedError');
        expect(client.calls[1].messages).toContainEqual(store.stored[1]);
        expect(echo.calls).toHaveLength(0);
        expect(store.stored[2]).toMatchObject({ type: 'tool', toolCallId: 'broken', isError: true, content: expect.stringContaining('The tool was NOT executed') });
    });
});
describe('AgentRuntime · removed adapter options', () => {
    it.each(['adapter', 'adapterCapabilities'])('rejects %s before calling the client or consuming input', async (field) => {
        const store = new MemoryStore([userEvent('go')]);
        const client = new MockLLMClient([{ content: 'done' }]);
        await expect(new AgentRuntime({ store }).run({
            client, systemPrompt: '', tools: [], keyId: 'k', [field]: {},
        } as Parameters<AgentRuntime['run']>[0])).rejects.toThrow(new RegExp(field));
        expect(client.calls).toHaveLength(0);
        expect(store.stored).toHaveLength(1);
    });
});
describe('standalone tool execution safety', () => {
    it.each(['{broken', 'null', '42', '"text"', '[]'])('rejects non-object arguments %s before plugins or execution', async (args) => {
        const store = new MemoryStore([userEvent('Run tool')]);
        const execute = vi.fn(async () => 'must not run');
        const beforeToolCall = vi.fn();
        const runtime = new AgentRuntime({ store, sessionId: 'malformed', plugins: [{ name: 'observer', create: () => ({ beforeToolCall }) }] });
        await runtime.run({
            client: new MockLLMClient([
                { toolCalls: [{ id: 'bad', name: 'example', arguments: args }] },
                { content: 'Please retry.' },
            ]), systemPrompt: '', tools: [{ ...makeEchoTool('example'), execute }],
        });
        expect(execute).not.toHaveBeenCalled();
        expect(beforeToolCall).not.toHaveBeenCalled();
        expect(store.stored.find((m) => m.type === 'tool')).toMatchObject({ isError: true, content: expect.stringContaining('not a valid JSON object') });
    });
    it('skips every tool in a max_tokens batch, including syntactically valid arguments', async () => {
        const store = new MemoryStore([userEvent('Run tools')]);
        const execute = vi.fn(async () => 'must not run');
        await new AgentRuntime({ store, sessionId: 'truncated' }).run({
            client: new MockLLMClient([
                { stopReason: 'max_tokens', toolCalls: [
                        { id: 'complete', name: 'example', arguments: '{}' },
                        { id: 'partial', name: 'example', arguments: '{' },
                    ] }, { content: 'Retrying concisely.' },
            ]), systemPrompt: '', tools: [{ ...makeEchoTool('example'), execute }],
        });
        expect(execute).not.toHaveBeenCalled();
        const results = store.stored.filter((m) => m.type === 'tool');
        expect(results).toHaveLength(2);
        for (const result of results)
            expect(result).toMatchObject({ isError: true, content: expect.stringContaining('max_tokens') });
    });
});
describe('explicit deferred scheduling', () => {
    it('defers any named tool and honors metadata overriding the subagent fallback', async () => {
        const store = new MemoryStore([userEvent('Run a batch')]);
        const lifecycle: string[] = [];
        const tool = (name: string, concurrency?: Tool['concurrency']): Tool => ({
            ...makeEchoTool(name), concurrency,
            execute: async () => { lifecycle.push(name); return 'ok'; },
        });
        await new AgentRuntime({ store, sessionId: 'waves' }).run({
            client: new MockLLMClient([
                { toolCalls: ['late', 'subagent', 'normal'].map((name) => ({ id: name, name, arguments: '{}' })) },
                { content: 'Done.' },
            ]),
            systemPrompt: '', tools: [tool('late', 'deferred'), tool('subagent', 'parallel'), tool('normal')],
        });
        expect(lifecycle).toEqual(['subagent', 'normal', 'late']);
    });
    it('records an empty billing key when omitted', async () => {
        const usage = new CapturingUsageRecorder();
        await new AgentRuntime({ store: new MemoryStore([userEvent('Hello')]), sessionId: 'no-billing', usage }).run({
            client: new MockLLMClient([{ content: 'Hi' }]), systemPrompt: '', tools: [],
        });
        expect(usage.entries[0].keyId).toBe('');
    });
});
