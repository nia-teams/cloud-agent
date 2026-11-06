import { describe, it, expect } from 'vitest';
import { AgentRuntime, type Tool } from '../index.js';
import { MemoryStore, MockLLMClient, userEvent } from './fixtures.js';
const tool = (name: string, description = ''): Tool => ({
    name, description, inputSchema: {}, execute: async () => description,
});
async function observe(tools: Tool[]): Promise<Tool[]> {
    const runtime = new AgentRuntime({ store: new MemoryStore([userEvent('hi')]), sessionId: 'explicit' });
    let observed: Tool[] = [];
    await runtime.run({
        client: new MockLLMClient([{ content: 'ok' }]),
        systemPrompt: '', tools, keyId: 'k',
        hooks: { beforeTurn: (s) => { observed = [...s.tools]; } },
    });
    return observed;
}
describe('explicit runtime tools', () => {
    it('rejects removed auto-mount configuration before any LLM call', async () => {
        const client = new MockLLMClient([{ content: 'must not run' }]);
        const runtime = new AgentRuntime({ store: new MemoryStore([userEvent('hi')]), sessionId: 'old-config' });
        await expect(runtime.run({
            client, systemPrompt: '', tools: [], keyId: 'k',
            ...{ builtinTools: {} },
        })).rejects.toThrow('builtinTools is no longer supported');
        expect(client.calls).toEqual([]);
    });
    it('uses only supplied tools', async () => {
        const supplied = tool('host_tool');
        expect(await observe([supplied])).toEqual([supplied]);
    });
    it('does not mount business tools for an empty list', async () => {
        expect(await observe([])).toEqual([]);
    });
    it('keeps the later duplicate and preserves first insertion order', async () => {
        const first = tool('same', 'first');
        const other = tool('other');
        const last = tool('same', 'last');
        expect(await observe([first, other, last])).toEqual([last, other]);
    });
});
