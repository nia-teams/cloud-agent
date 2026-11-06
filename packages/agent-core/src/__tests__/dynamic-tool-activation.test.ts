import { describe, it, expect, vi } from 'vitest';
import { AgentRuntime, type Tool } from '../index.js';
import { MemoryStore, MockLLMClient, makeEchoTool, userEvent, } from './fixtures.js';
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
describe('AgentRuntime · call-boundary dynamic tool activation (R2)', () => {
    it('call #1 tool activates a name → call #2 tools array carries its full definition', async () => {
        const store = new MemoryStore([userEvent('go')]);
        const activator = makeActivatorTool('activator', ['gitlab']);
        const gitlabTool = makeEchoTool('gitlab');
        const client = new MockLLMClient([
            { toolCalls: [{ id: 'tc1', name: 'activator', arguments: '{}' }] },
            { content: 'done' },
        ]);
        const resolveToolDefinitions = vi.fn(async (names: string[]) => names.includes('gitlab') ? [gitlabTool] : []);
        const runtime = new AgentRuntime({ store, sessionId: 's-activate' });
        await runtime.run({
            client,
            systemPrompt: '',
            tools: [activator],
            keyId: 'k1',
            resolveToolDefinitions,
        });
        expect(client.calls.length).toBe(2);
        const call1ToolNames = (client.calls[0].tools ?? []).map((t) => t.name);
        expect(call1ToolNames).not.toContain('gitlab');
        expect(call1ToolNames).toContain('activator');
        const call2Tools = client.calls[1].tools ?? [];
        const gitlabDef = call2Tools.find((t) => t.name === 'gitlab');
        expect(gitlabDef).toBeDefined();
        expect(gitlabDef?.description).toBe(gitlabTool.description);
        expect(gitlabDef?.inputSchema).toEqual(gitlabTool.inputSchema);
        expect(resolveToolDefinitions).toHaveBeenCalledWith(['gitlab']);
    });
    it('dedupes: a name already in state.tools is never sent to resolveToolDefinitions', async () => {
        const store = new MemoryStore([userEvent('go')]);
        const gitlabTool = makeEchoTool('gitlab');
        const activator = makeActivatorTool('activator', ['gitlab']);
        const client = new MockLLMClient([
            { toolCalls: [{ id: 'tc1', name: 'activator', arguments: '{}' }] },
            { content: 'done' },
        ]);
        const resolveToolDefinitions = vi.fn(async () => [gitlabTool]);
        const runtime = new AgentRuntime({ store, sessionId: 's-dedupe' });
        await runtime.run({
            client,
            systemPrompt: '',
            tools: [activator, gitlabTool],
            keyId: 'k1',
            resolveToolDefinitions,
        });
        expect(resolveToolDefinitions).not.toHaveBeenCalled();
    });
    it('a tool present but still deferLoading:true IS re-resolved (native-partial upgrade path)', async () => {
        const store = new MemoryStore([userEvent('go')]);
        const gitlabStub: Tool = { ...makeEchoTool('gitlab'), deferLoading: true };
        const gitlabFull = makeEchoTool('gitlab');
        const activator = makeActivatorTool('activator', ['gitlab']);
        const client = new MockLLMClient([
            { toolCalls: [{ id: 'tc1', name: 'activator', arguments: '{}' }] },
            { content: 'done' },
        ]);
        const resolveToolDefinitions = vi.fn(async () => [gitlabFull]);
        const runtime = new AgentRuntime({ store, sessionId: 's-defer-upgrade' });
        await runtime.run({
            client,
            systemPrompt: '',
            tools: [activator, gitlabStub],
            keyId: 'k1',
            resolveToolDefinitions,
        });
        expect(resolveToolDefinitions).toHaveBeenCalledWith(['gitlab']);
        const secondCallTools = client.calls[1].tools ?? [];
        const gitlabSent = secondCallTools.find((t) => t.name === 'gitlab');
        expect(gitlabSent?.deferLoading).toBeUndefined();
    });
    it('no resolveToolDefinitions wired → activateTools is a silent no-op, tools array unchanged', async () => {
        const store = new MemoryStore([userEvent('go')]);
        const activator = makeActivatorTool('activator', ['gitlab']);
        const client = new MockLLMClient([
            { toolCalls: [{ id: 'tc1', name: 'activator', arguments: '{}' }] },
            { content: 'done' },
        ]);
        const runtime = new AgentRuntime({ store, sessionId: 's-noresolver' });
        await runtime.run({
            client,
            systemPrompt: '',
            tools: [activator],
            keyId: 'k1',
        });
        expect(client.calls.length).toBe(2);
        const call2ToolNames = (client.calls[1].tools ?? []).map((t) => t.name);
        expect(call2ToolNames).toEqual(['activator']);
    });
    it('resolver returning a subset of requested names logs a warn but keeps the rest', async () => {
        const store = new MemoryStore([userEvent('go')]);
        const gitlabTool = makeEchoTool('gitlab');
        const activator = makeActivatorTool('activator', ['gitlab', 'unknown_tool']);
        const client = new MockLLMClient([
            { toolCalls: [{ id: 'tc1', name: 'activator', arguments: '{}' }] },
            { content: 'done' },
        ]);
        const resolveToolDefinitions = vi.fn(async (names: string[]) => names.filter((n) => n === 'gitlab').map(() => gitlabTool));
        const warn = vi.fn();
        const runtime = new AgentRuntime({ store, sessionId: 's-partial' });
        await runtime.run({
            client,
            systemPrompt: '',
            tools: [activator],
            keyId: 'k1',
            resolveToolDefinitions,
        });
        void warn;
        const call2ToolNames = (client.calls[1].tools ?? []).map((t) => t.name);
        expect(call2ToolNames).toContain('gitlab');
        expect(call2ToolNames).not.toContain('unknown_tool');
    });
    it('resolveToolDefinitions throwing does not kill the turn — activation just drops for that iteration', async () => {
        const store = new MemoryStore([userEvent('go')]);
        const activator = makeActivatorTool('activator', ['gitlab']);
        const client = new MockLLMClient([
            { toolCalls: [{ id: 'tc1', name: 'activator', arguments: '{}' }] },
            { content: 'done' },
        ]);
        const resolveToolDefinitions = vi.fn(async () => {
            throw new Error('registry lookup failed');
        });
        const runtime = new AgentRuntime({ store, sessionId: 's-throws' });
        await runtime.run({
            client,
            systemPrompt: '',
            tools: [activator],
            keyId: 'k1',
            resolveToolDefinitions,
        });
        expect(client.calls.length).toBe(2);
        const tail = store.stored[store.stored.length - 1];
        expect(tail.type).toBe('assistant');
    });
    it('same-batch: two tool calls each activating names → both resolved together, one resolver call', async () => {
        const store = new MemoryStore([userEvent('go')]);
        const gitlabTool = makeEchoTool('gitlab');
        const pdfTool = makeEchoTool('pdf');
        const activatorA = makeActivatorTool('activatorA', ['gitlab']);
        const activatorB = makeActivatorTool('activatorB', ['pdf']);
        const client = new MockLLMClient([
            {
                toolCalls: [
                    { id: 'tcA', name: 'activatorA', arguments: '{}' },
                    { id: 'tcB', name: 'activatorB', arguments: '{}' },
                ],
            },
            { content: 'done' },
        ]);
        const resolveToolDefinitions = vi.fn(async (names: string[]) => [gitlabTool, pdfTool].filter((t) => names.includes(t.name)));
        const runtime = new AgentRuntime({ store, sessionId: 's-batch' });
        await runtime.run({
            client,
            systemPrompt: '',
            tools: [activatorA, activatorB],
            keyId: 'k1',
            resolveToolDefinitions,
        });
        expect(resolveToolDefinitions).toHaveBeenCalledTimes(1);
        const namesArg = resolveToolDefinitions.mock.calls[0][0] as string[];
        expect(new Set(namesArg)).toEqual(new Set(['gitlab', 'pdf']));
        const call2ToolNames = (client.calls[1].tools ?? []).map((t) => t.name);
        expect(call2ToolNames).toContain('gitlab');
        expect(call2ToolNames).toContain('pdf');
    });
});
