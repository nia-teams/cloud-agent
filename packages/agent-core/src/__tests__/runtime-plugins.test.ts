import { describe, expect, it, vi } from 'vitest';
import { AgentRuntime } from '../runtime.js';
import type { AgentEvent, AgentRuntimeConfig, RuntimePlugin, RuntimePluginHooks } from '../types.js';
import { createDefaultBuiltinPlugins, createLargeToolResultPlugin, createPendingHiddenPlugin } from '../builtins/index.js';
import { SubagentHandoffSignal } from '../tools/builtin/subagent.js';
import { CapturingUsageRecorder, MemoryStore, MockLLMClient, makeEchoTool, makeFailingTool, userEvent } from './fixtures.js';
const toolCall = (id: string, name = 'echo') => ({ id, name, arguments: '{}' });
const plugin = (hooks: RuntimePluginHooks): RuntimePlugin => ({ name: 'test', create: () => hooks });
describe('runtime generic plugins', () => {
    it('bare core has no implicit guardrail', async () => {
        const fail = makeFailingTool();
        const client = new MockLLMClient([
            ...Array.from({ length: 8 }, (_, i) => ({ toolCalls: [toolCall(`${i}`, 'fail')] })),
            { content: 'done' },
        ]);
        await new AgentRuntime({ store: new MemoryStore([userEvent('go')]), sessionId: 'bare' }).run({
            client, systemPrompt: '', tools: [fail], keyId: 'k',
        });
        expect(fail.execute).toHaveBeenCalledTimes(8);
    });
    it.each(['contextPruning', 'contextPruner', 'guardrail', 'guardrailConfig', 'largeToolResult', 'builtinSteps'])('rejects removed core option %s rather than silently dropping policy', (field) => {
        const store = new MemoryStore();
        expect(() => new AgentRuntime({ store, sessionId: 's', [field]: false } as AgentRuntimeConfig))
            .toThrow('pass plugins: createDefaultBuiltinPlugins');
        expect(store.stored).toEqual([]);
    });
    it('composes async context stages before formatting without changing canonical history', async () => {
        const store = new MemoryStore([userEvent('raw')]);
        const client = new MockLLMClient([{ content: 'done' }]);
        const order: string[] = [];
        const stage = (suffix: string): RuntimePlugin => plugin({
            transformContext: async ({ messages, state, model, contextWindow }) => {
                expect(state.messages[0].content).toBe('raw');
                expect(model).toBe('mock-model-1');
                expect(contextWindow).toBe(123);
                order.push(suffix);
                return messages.map(m => ({ ...m, content: m.content + suffix }));
            },
        });
        await new AgentRuntime({
            store, sessionId: 'view', plugins: [stage('A'), stage('B')],
            formatMessagesForLLM: async (messages) => {
                order.push('format');
                expect(messages[0].content).toBe('rawAB');
                return messages;
            },
        }).run({ client, systemPrompt: '', tools: [], keyId: 'k', contextWindow: 123 });
        expect(order).toEqual(['A', 'B', 'format']);
        expect(client.calls[0].messages[0].content).toBe('rawAB');
        expect(store.stored[0].content).toBe('raw');
    });
    it('first synthetic result wins, preserves typed guidance, and bypasses observation', async () => {
        const echo = makeEchoTool();
        const observe = vi.fn();
        const second = vi.fn();
        const store = new MemoryStore([userEvent('go')]);
        const client = new MockLLMClient([{ toolCalls: [toolCall('blocked')] }, { content: 'done' }]);
        await new AgentRuntime({
            store, sessionId: 'short-circuit', plugins: [plugin({
                    beforeToolCall: async () => ({ content: 'blocked', isError: true,
                        guidance: [{ kind: 'tool_loop_warning', warningType: 'exact_failure', toolName: 'echo', count: 1 }] }),
                    afterToolCall: observe,
                }), plugin({ beforeToolCall: second })],
        }).run({ client, systemPrompt: '', tools: [echo], keyId: 'k' });
        expect(echo.execute).not.toHaveBeenCalled();
        expect(second).not.toHaveBeenCalled();
        expect(observe).not.toHaveBeenCalled();
        expect(store.stored.find(m => m.type === 'tool')).toMatchObject({
            content: 'blocked', isError: true,
            guidance: [{ kind: 'tool_loop_warning', count: 1 }],
        });
    });
    it('observes in authored order despite reverse completion, before host hooks and batch transforms', async () => {
        const store = new MemoryStore([userEvent('go')]);
        const echo = makeEchoTool();
        const completed: string[] = [];
        const observed: string[] = [];
        let release!: () => void;
        const slow = new Promise<void>(resolve => { release = resolve; });
        echo.execute = async (args) => {
            if (args.n === 1)
                await slow;
            else
                release();
            completed.push(String(args.n));
            return String(args.n);
        };
        const client = new MockLLMClient([{ toolCalls: [
                    { ...toolCall('one'), arguments: '{"n":1}' }, { ...toolCall('two'), arguments: '{"n":2}' },
                ] }, { content: 'done' }]);
        const events: AgentEvent[] = [];
        await new AgentRuntime({ store, sessionId: 'order', plugins: [plugin({
                    afterToolCall: ({ toolCallId, message }) => { observed.push(toolCallId); message.content += ':observed'; },
                    afterToolBatch: state => {
                        expect(state.pending.filter(m => m.type === 'tool').map(m => m.content)).toEqual(['1:observed:host', '2:observed:host']);
                        for (const m of state.pending)
                            if (m.type === 'tool')
                                m.content += ':batch';
                    },
                })] }).run({
            client, systemPrompt: '', tools: [echo], keyId: 'k', onEvent: event => events.push(event),
            hooks: { afterExecTools: state => {
                    for (const m of state.pending)
                        if (m.type === 'tool')
                            m.content += ':host';
                } },
        });
        expect(completed).toEqual(['2', '1']);
        expect(observed).toEqual(['one', 'two']);
        expect(store.stored.filter(m => m.type === 'tool').map(m => m.content)).toEqual(['1:observed:host:batch', '2:observed:host:batch']);
        expect(events.filter(e => e.type === 'tool_call_end')).toHaveLength(2);
    });
    it('does not observe a discarded handoff batch or run post-batch transforms', async () => {
        const observe = vi.fn();
        const batch = vi.fn();
        const echo = makeEchoTool();
        echo.execute = async () => { throw new SubagentHandoffSignal('handoff'); };
        const store = new MemoryStore([userEvent('go')]);
        const events: AgentEvent[] = [];
        await new AgentRuntime({ store, sessionId: 'handoff', plugins: [plugin({ afterToolCall: observe, afterToolBatch: batch })] })
            .run({ client: new MockLLMClient([{ toolCalls: [toolCall('handoff')] }]), systemPrompt: '', tools: [echo], keyId: 'k', onEvent: e => events.push(e) });
        expect(observe).not.toHaveBeenCalled();
        expect(batch).not.toHaveBeenCalled();
        expect(store.stored).toHaveLength(1);
        expect(events.some(e => e.type === 'tool_call_end')).toBe(false);
    });
    it('fresh builtin controllers on every run, even when the bundle and runtime are reused', async () => {
        const store = new MemoryStore([userEvent('go')]);
        const fail = makeFailingTool();
        const runtime = new AgentRuntime({ store, sessionId: 'reuse', plugins: createDefaultBuiltinPlugins({
                contextPruning: false, guardrailConfig: { halt: { exactFailure: 1 } },
            }) });
        for (const turn of ['a', 'b']) {
            if (turn === 'b')
                store.enqueue(userEvent('again'));
            await runtime.run({ client: new MockLLMClient([
                    { toolCalls: [toolCall(turn + '1', 'fail')] },
                    { toolCalls: [toolCall(turn + '2', 'fail')] }, { content: 'done' },
                ]), systemPrompt: '', tools: [fail], keyId: 'k' });
        }
        expect(fail.execute).toHaveBeenCalledTimes(2);
        expect(store.stored.filter(m => m.type === 'tool' && m.content.includes('Tool loop halted'))).toHaveLength(2);
    });
    it.each(['create', 'transformContext', 'beforeToolCall', 'afterToolCall', 'afterToolBatch'] as const)('%s errors use normal turn_error, usage, afterTurn and turn_end lifecycle', async (slot) => {
        const error = new Error(`bad ${slot}`);
        const broken: RuntimePlugin = slot === 'create'
            ? { name: 'broken', create: () => { throw error; } }
            : plugin({ [slot]: async () => { throw error; } });
        const events: AgentEvent[] = [];
        const usage = new CapturingUsageRecorder();
        const afterTurn = vi.fn();
        const store = new MemoryStore([userEvent('go')]);
        await new AgentRuntime({ store, sessionId: 'errors', plugins: [broken], usage }).run({
            client: new MockLLMClient([{ toolCalls: [toolCall('x')] }]),
            systemPrompt: '', tools: [makeEchoTool()], keyId: 'k',
            onEvent: e => events.push(e), hooks: { afterTurn },
        });
        expect(events[0].type).toBe('turn_start');
        expect(events.filter(e => e.type === 'error')).toHaveLength(1);
        expect(events.at(-1)?.type).toBe('turn_end');
        expect(usage.entries[0]).toMatchObject({ exitKind: 'error', errorMessage: error.message });
        expect(afterTurn).toHaveBeenCalledOnce();
        expect(afterTurn.mock.calls[0][0].exit).toMatchObject({ kind: 'error', error });
        expect(events.some(e => e.type === 'tool_call_end')).toBe(false);
    });
    it('large-result plugin runs after raw host hooks and its final content is persisted', async () => {
        const store = new MemoryStore([userEvent('go')]);
        const echo = makeEchoTool();
        echo.execute = async () => 'x'.repeat(500);
        const write = vi.fn(async () => ({ uri: 'mem://full' }));
        await new AgentRuntime({ store, sessionId: 'large', plugins: [createLargeToolResultPlugin({
                    store: { write }, thresholdChars: 100,
                })] }).run({ client: new MockLLMClient([{ toolCalls: [toolCall('big')] }, { content: 'done' }]),
            systemPrompt: '', tools: [echo], keyId: 'k', hooks: {
                afterExecTools: state => expect(state.pending.find(m => m.type === 'tool')?.content).toBe('x'.repeat(500)),
            },
        });
        expect(write).toHaveBeenCalledWith('echo', 'x'.repeat(500));
        expect(store.stored.find(m => m.type === 'tool')?.content).toContain('mem://full');
    });
    it('pending-hidden is a view-only optional plugin and opts out of children', async () => {
        const hidden = createPendingHiddenPlugin({
            isSkippable: m => m.content === 'hidden', isUserActionable: m => m.content === 'actionable',
        });
        const store = new MemoryStore([userEvent('actionable'), userEvent('hidden')]);
        const client = new MockLLMClient([{ content: 'done' }]);
        await new AgentRuntime({ store, sessionId: 'hidden', plugins: [hidden] }).run({ client, systemPrompt: '', tools: [], keyId: 'k' });
        expect(client.calls[0].messages).toHaveLength(1);
        expect(store.stored[1].content).toBe('hidden');
        expect(hidden.forSubagent?.()).toBeUndefined();
    });
});
