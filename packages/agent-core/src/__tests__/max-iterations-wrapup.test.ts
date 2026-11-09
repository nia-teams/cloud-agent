import { describe, expect, it, vi } from 'vitest';
import { AgentRuntime } from '../runtime.js';
import type { RuntimeState } from '../types.js';
import { MemoryStore, MockLLMClient, makeEchoTool } from './fixtures.js';

const step = (id: string) => ({ content: null, toolCalls: [{ id, name: 'echo', arguments: '{"text":"ok"}' }] });
const initial = () => new MemoryStore([{ type: 'event', eventType: 'user_message', content: 'Work', timestamp: new Date() }]);

describe('iteration ceiling', () => {
  it.each([true, false])('allows terminal text at the exact ceiling: %s', async (terminal) => {
    const client = new MockLLMClient([step('1'), step('2'), terminal ? { content: 'Done' } : step('3')]);
    let final!: RuntimeState;
    const iterations: number[] = [];
    await new AgentRuntime({ store: initial(), sessionId: 'cap', maxLoopIterations: 3 }).run({
      client, systemPrompt: 'Work', tools: [makeEchoTool()], keyId: 'test',
      hooks: { afterFetch: s => { iterations.push(s.loopIteration); }, afterTurn: s => { final = s; } },
    });
    expect(iterations).toEqual([1, 2, 3, 4]);
    expect(client.calls).toHaveLength(3);
    expect(final.exit?.kind).toBe(terminal ? 'done' : 'error');
    if (final.exit?.kind === 'error') expect(final.exit.error.message).toBe('Hit max loop iterations (3)');
  });

  it.each([0, -1])('does not call the model with ceiling %s', async (maxLoopIterations) => {
    const client = new MockLLMClient([]);
    let final!: RuntimeState;
    await new AgentRuntime({ store: initial(), sessionId: 'zero', maxLoopIterations }).run({
      client, systemPrompt: '', tools: [], keyId: 'test', hooks: { afterTurn: s => { final = s; } },
    });
    expect(client.calls).toHaveLength(0);
    expect(final.exit?.kind).toBe('error');
  });

  it('defers pending tool activation during wrap-up and still runs context transforms', async () => {
    const client = new MockLLMClient([step('1'), { content: 'Partial findings' }]);
    const activator = makeEchoTool();
    activator.execute = async (_input, ctx) => {
      ctx.activateTools?.(['extra']);
      return 'activated';
    };
    const resolveToolDefinitions = vi.fn(async () => [makeEchoTool('extra')]);
    const transformContext = vi.fn(({ messages }: { messages: readonly import('../types.js').AgentMessage[] }) => messages);
    const formatMessagesForLLM = vi.fn(async (messages: import('../types.js').AgentMessage[]) => messages);
    await new AgentRuntime({
      store: initial(), sessionId: 'activation', maxLoopIterations: 1,
      maxIterationsWrapUpPrompt: 'Summarize partial work',
      plugins: [{ name: 'context', create: () => ({ transformContext }) }], formatMessagesForLLM,
    }).run({ client, systemPrompt: '', tools: [activator], keyId: 'test', resolveToolDefinitions });
    expect(resolveToolDefinitions).not.toHaveBeenCalled();
    expect(client.calls[1].tools).toEqual(client.calls[0].tools);
    expect(transformContext).toHaveBeenCalledTimes(2);
    expect(formatMessagesForLLM).toHaveBeenCalledTimes(2);
  });

  it.each([true, false])('uses a transient text-only final call, with text=%s', async (hasText) => {
    const client = new MockLLMClient([step('1'), step('2'), step('3'), {
      ...step('ignored'), content: hasText ? 'Partial findings' : null,
      streamDeltas: [
        { type: 'tool_input_start', toolCallId: 'ignored', toolName: 'echo' },
        { type: 'tool_input_delta', toolCallId: 'ignored', partialJson: '{}' },
        ...(hasText ? [{ type: 'text' as const, content: 'Partial findings' }] : []),
      ],
    }]);
    const store = initial();
    const tool = makeEchoTool();
    const events: any[] = [];
    let final!: RuntimeState;
    await new AgentRuntime({ store, sessionId: 'wrap', maxLoopIterations: 3, maxIterationsWrapUpPrompt: 'Do NOT call tools' }).run({
      client, systemPrompt: '', tools: [tool], keyId: 'test',
      onEvent: e => { events.push(e); }, hooks: { afterTurn: s => { final = s; } },
    });
    expect(client.calls).toHaveLength(4);
    expect(client.calls[3].toolChoice).toBe('none');
    expect(client.calls[3].tools).toEqual(client.calls[2].tools);
    expect(client.calls[3].messages.at(-1)).toMatchObject({ type: 'event', eventType: 'runtime.max_iterations_wrap_up', content: 'Do NOT call tools' });
    expect(store.stored.some(m => m.type === 'event' && m.eventType === 'runtime.max_iterations_wrap_up')).toBe(false);
    expect(tool.calls).toHaveLength(3);
    expect(events.some(e => e.toolCallId === 'ignored')).toBe(false);
    expect(final.exit?.kind).toBe(hasText ? 'done' : 'error');
    expect(final.maxIterationsReached).toBe(hasText ? 3 : undefined);
    if (hasText) expect(store.stored.at(-1)).toMatchObject({ type: 'assistant', content: 'Partial findings', toolCalls: undefined });
    else expect(store.stored.at(-1)?.type).toBe('tool');
  });
});
