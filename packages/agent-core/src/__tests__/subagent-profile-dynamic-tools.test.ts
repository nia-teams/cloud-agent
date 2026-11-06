import { describe, it, expect, vi } from 'vitest';
import { AgentRuntime } from '../runtime.js';
import type { SubagentProfile, SubagentStore, Tool } from '../types.js';
import { MemoryStore, MockLLMClient, makeEchoTool, userEvent } from './fixtures.js';
function makeMemorySubagentStore(): SubagentStore & {
    runs: Map<string, {
        messages: unknown[];
    }>;
} {
    const runs = new Map<string, {
        messages: unknown[];
    }>();
    let seq = 0;
    return {
        runs,
        async insertRun(input) {
            const subagentId = `sa-${++seq}`;
            runs.set(subagentId, { messages: [...input.initialMessages] });
            return { subagentId };
        },
        async findByToolCallId() {
            return null;
        },
        async appendMessages(subagentId, messages) {
            const run = runs.get(subagentId);
            if (run)
                run.messages.push(...messages);
        },
        async finalize() {
        },
        async readActiveSubagentTurn() {
            return null;
        },
        async updateLastBlock() {
        },
    } as unknown as SubagentStore & {
        runs: Map<string, {
            messages: unknown[];
        }>;
    };
}
function makeActivatorTool(name: string, activate: string[]): Tool {
    return {
        name,
        description: 'Activates other tools as a side effect',
        inputSchema: { type: 'object', properties: {} },
        execute: vi.fn(async (_input, ctx) => {
            ctx.activateTools?.(activate);
            return `activated:${activate.join(',')}`;
        }),
    };
}
describe('subagent tool · per-profile dynamic-tool-activation forwarding', () => {
    it('profile.resolveToolDefinitions is used by the CHILD runtime activation, not the parent one', async () => {
        const parentStore = new MemoryStore([userEvent('go')]);
        const parentClient = new MockLLMClient([
            {
                toolCalls: [
                    { id: 'toolu_A', name: 'subagent', arguments: JSON.stringify({ task: 'do X', mode: 'full' }) },
                ],
            },
            { content: 'parent done' },
        ]);
        const childActivator = makeActivatorTool('activator', ['gitlab']);
        const childGitlabFull = makeEchoTool('gitlab');
        const subagentClient = new MockLLMClient([
            { toolCalls: [{ id: 'toolu_S1', name: 'activator', arguments: '{}' }] },
            { content: 'child done' },
        ]);
        const parentResolveToolDefinitions = vi.fn(async () => []);
        const profileResolveToolDefinitions = vi.fn(async (names: string[]) => names.includes('gitlab') ? [childGitlabFull] : []);
        const profile: SubagentProfile = {
            name: 'full',
            description: 'full mode',
            rolePrompt: 'You are the full subagent.',
            tools: [childActivator],
            client: subagentClient,
            resolveToolDefinitions: profileResolveToolDefinitions,
        };
        const runtime = new AgentRuntime({ store: parentStore, sessionId: 's-profile-defer' });
        await runtime.run({
            client: parentClient,
            systemPrompt: 'parent',
            tools: [],
            keyId: 'k1',
            resolveToolDefinitions: parentResolveToolDefinitions,
            subagent: {
                profiles: [profile],
                store: makeMemorySubagentStore(),
            },
        });
        expect(profileResolveToolDefinitions).toHaveBeenCalledWith(['gitlab']);
        expect(parentResolveToolDefinitions).not.toHaveBeenCalled();
        expect(subagentClient.calls.length).toBe(2);
        const secondCallTools = subagentClient.calls[1].tools ?? [];
        expect(secondCallTools.some((t) => t.name === 'gitlab')).toBe(true);
    });
    it('child receives its own role prompt and canonical messages independently of the parent', async () => {
        const parentStore = new MemoryStore([userEvent('go')]);
        const parentClient = new MockLLMClient([
            {
                toolCalls: [
                    { id: 'toolu_A', name: 'subagent', arguments: JSON.stringify({ task: 'do X', mode: 'full' }) },
                ],
            },
            { content: 'parent done' },
        ]);
        const subagentClient = new MockLLMClient([{ content: 'child done' }]);
        const profile: SubagentProfile = {
            name: 'full',
            description: 'full mode',
            rolePrompt: 'You are the full subagent.',
            tools: [],
            client: subagentClient,
        };
        const runtime = new AgentRuntime({ store: parentStore, sessionId: 's-profile-caps' });
        await runtime.run({
            client: parentClient,
            systemPrompt: 'parent',
            tools: [],
            keyId: 'k1',
            subagent: {
                profiles: [profile],
                store: makeMemorySubagentStore(),
            },
        });
        expect(subagentClient.calls).toHaveLength(1);
        expect(subagentClient.calls[0].systemPrompt).toContain('You are the full subagent.');
        expect(subagentClient.calls[0].messages.every((message) => 'type' in message && !('role' in message))).toBe(true);
    });
    it('bug fix 2026-07-26: child inherits its OWN deferredToolNames/modelTier, not the parent turn\'s — a tool the parent had already activated (so it dropped out of the parent\'s deferred list) must still be reported as deferred-and-activatable to the child if the profile says so', async () => {
        const parentStore = new MemoryStore([userEvent('go')]);
        const parentClient = new MockLLMClient([
            {
                toolCalls: [
                    { id: 'toolu_A', name: 'subagent', arguments: JSON.stringify({ task: 'do X', mode: 'full' }) },
                ],
            },
            { content: 'parent done' },
        ]);
        const requestToolsLikeTool: Tool = {
            name: 'request_tools_like',
            description: 'Validates a name against ctx.metadata.deferredToolNames, like request_tools',
            inputSchema: { type: 'object', properties: {} },
            execute: vi.fn(async (_input, ctx) => {
                const deferred = (ctx.metadata.deferredToolNames as string[] | undefined) ?? [];
                return deferred.includes('browser') ? 'browser IS deferred' : 'browser NOT deferred';
            }),
        };
        const subagentClient = new MockLLMClient([
            { toolCalls: [{ id: 'toolu_S1', name: 'request_tools_like', arguments: '{}' }] },
            { content: 'child done' },
        ]);
        const profile: SubagentProfile = {
            name: 'full',
            description: 'full mode',
            rolePrompt: 'You are the full subagent.',
            tools: [requestToolsLikeTool],
            client: subagentClient,
            deferredToolNames: ['browser'],
        };
        const subagentStore = makeMemorySubagentStore();
        const runtime = new AgentRuntime({ store: parentStore, sessionId: 's-profile-inherit-bug' });
        await runtime.run({
            client: parentClient,
            systemPrompt: 'parent',
            tools: [],
            keyId: 'k1',
            subagent: {
                profiles: [profile],
                store: subagentStore,
            },
            hooks: {
                beforeTurn: async (state) => {
                    state.metadata.deferredToolNames = ['some-other-tool'];
                },
            },
        });
        expect(requestToolsLikeTool.execute).toHaveBeenCalled();
        const executeMock = requestToolsLikeTool.execute as ReturnType<typeof vi.fn>;
        await expect(executeMock.mock.results[0]!.value).resolves.toBe('browser IS deferred');
    });
});
describe('subagent plugin propagation', () => {
    it('inherits factories with fresh child state, selects child overrides, and honors opt-out', async () => {
        const identities: string[] = [];
        const counts: number[] = [];
        const parentOnly = vi.fn(() => ({}));
        const overriddenParent = vi.fn(() => ({}));
        const overriddenChild = vi.fn(() => ({}));
        const shared: import('../types.js').RuntimePlugin = {
            name: 'inherited',
            create: ({ turnId }) => {
                identities.push(turnId);
                let count = 0;
                return { transformContext: ({ messages }) => { counts.push(++count); return messages; } };
            },
        };
        const childClient = new MockLLMClient([{ content: 'child one' }, { content: 'child two' }]);
        const parentClient = new MockLLMClient([{ toolCalls: ['one', 'two'].map(id => ({
                    id, name: 'subagent', arguments: JSON.stringify({ task: id, mode: 'full' }),
                })) }, { content: 'done' }]);
        await new AgentRuntime({
            store: new MemoryStore([userEvent('go')]), sessionId: 'plugins', plugins: [shared, {
                    name: 'parent-only', create: parentOnly, forSubagent: () => undefined,
                }, {
                    name: 'override', create: overriddenParent,
                    forSubagent: () => ({ name: 'child-override', create: overriddenChild }),
                }],
        }).run({ client: parentClient, systemPrompt: '', tools: [], keyId: 'k', subagent: {
                store: makeMemorySubagentStore(), profiles: [{
                        name: 'full', description: 'full', rolePrompt: 'child', client: childClient, tools: [],
                    }],
            } });
        expect(identities).toHaveLength(3);
        expect(new Set(identities).size).toBe(3);
        expect(counts.filter(count => count === 1)).toHaveLength(3);
        expect(counts.filter(count => count === 2)).toHaveLength(1);
        expect(parentOnly).toHaveBeenCalledOnce();
        expect(overriddenParent).toHaveBeenCalledOnce();
        expect(overriddenChild).toHaveBeenCalledTimes(2);
    });
});
describe('subagent idle timeout inheritance', () => {
    it('forwards the parent idle timeout to the child runtime', async () => {
        vi.useFakeTimers();
        try {
            const parent = new MockLLMClient([
                { toolCalls: [{ id: 'idle-child', name: 'subagent', arguments: JSON.stringify({ task: 'work', mode: 'full' }) }] },
                { content: 'parent done' },
            ]);
            const child = new MockLLMClient([]);
            let request!: Parameters<typeof child.chat>[0];
            let started!: () => void;
            const ready = new Promise<void>(resolve => { started = resolve; });
            child.chat = async (req) => {
                request = req;
                child.calls.push(req);
                started();
                return new Promise(() => { });
            };
            const running = new AgentRuntime({
                store: new MemoryStore([userEvent('go')]), sessionId: 'parent-idle',
                llmCallTimeoutMs: 1000, llmIdleTimeoutMs: 100,
            }).run({
                client: parent, systemPrompt: '', tools: [], keyId: 'test',
                subagent: {
                    profiles: [{ name: 'full', description: 'full', rolePrompt: 'child', tools: [], client: child }],
                    store: makeMemorySubagentStore(),
                },
            });
            await ready;
            await vi.advanceTimersByTimeAsync(99);
            expect(request.signal?.aborted).toBe(false);
            await vi.advanceTimersByTimeAsync(1);
            expect(request.signal?.reason.name).toBe('TimeoutError');
            expect(request.signal?.reason.message).toContain('stream idle timeout');
            await running;
            expect(child.calls).toHaveLength(1);
            expect(vi.getTimerCount()).toBe(0);
        }
        finally {
            vi.useRealTimers();
        }
    });
});
