import { describe, it, expect } from 'vitest';
import { AgentRuntime, type Tool } from '../index.js';
import { MemoryStore, MockLLMClient, userEvent } from './fixtures.js';
function makeTool(name: string, deferLoading?: boolean): Tool {
    return {
        name,
        description: `tool ${name}`,
        inputSchema: { type: 'object', properties: {} },
        ...(deferLoading !== undefined ? { deferLoading } : {}),
        execute: async () => 'ok',
    };
}
describe('toToolDef · Tool.deferLoading forwarding', () => {
    it('deferLoading:true on a Tool carries through to the request tools[] ToolDefinition', async () => {
        const store = new MemoryStore([userEvent('go')]);
        const client = new MockLLMClient([{ content: 'done' }]);
        const runtime = new AgentRuntime({ store, sessionId: 's-defer-1' });
        await runtime.run({
            client,
            systemPrompt: '',
            tools: [makeTool('core_tool'), makeTool('deferred_tool', true)],
            keyId: 'k1',
        });
        expect(client.calls.length).toBe(1);
        const sentTools = client.calls[0].tools ?? [];
        const core = sentTools.find((t) => t.name === 'core_tool');
        const deferred = sentTools.find((t) => t.name === 'deferred_tool');
        expect(core?.deferLoading).toBeUndefined();
        expect(deferred?.deferLoading).toBe(true);
    });
    it('deferLoading:false / unset never adds the key (byte-for-byte pre-R2 shape)', async () => {
        const store = new MemoryStore([userEvent('go')]);
        const client = new MockLLMClient([{ content: 'done' }]);
        const runtime = new AgentRuntime({ store, sessionId: 's-defer-2' });
        await runtime.run({
            client,
            systemPrompt: '',
            tools: [makeTool('plain'), makeTool('explicit_false', false)],
            keyId: 'k1',
        });
        const sentTools = client.calls[0].tools ?? [];
        for (const t of sentTools) {
            expect('deferLoading' in t).toBe(false);
        }
    });
});
describe('host registry tool visibility across activation', () => {
    it('keeps a hidden tool absent on unrelated activation, then explicitly restores it', async () => {
        const hidden = makeTool('subagent');
        const other = makeTool('other');
        const client = new MockLLMClient([
            { toolCalls: [{ id: 'a', name: 'request_tools', arguments: '{"name":"other"}' }] },
            { toolCalls: [{ id: 'b', name: 'request_tools', arguments: '{"name":"subagent"}' }] },
            { content: 'done' },
        ]);
        const runtime = new AgentRuntime({ store: new MemoryStore([userEvent('go')]), sessionId: 'visibility' });
        await runtime.run({
            client, systemPrompt: '', keyId: 'k',
            tools: [{
                    ...makeTool('request_tools'),
                    execute: async (input, ctx) => { ctx.activateTools?.([String(input.name)]); return 'activated'; },
                }],
            resolveToolDefinitions: (names) => names.map((name) => name === 'subagent' ? hidden : other),
        });
        expect(client.calls).toHaveLength(3);
        expect(client.calls[0].tools?.some((t) => t.name === 'subagent')).toBe(false);
        expect(client.calls[1].tools?.some((t) => t.name === 'subagent')).toBe(false);
        expect(client.calls[1].tools?.some((t) => t.name === 'other')).toBe(true);
        expect(client.calls[2].tools?.filter((t) => t.name === 'subagent')).toHaveLength(1);
    });
});
