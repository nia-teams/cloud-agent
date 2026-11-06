import { describe, it, expect, vi } from 'vitest';
import { applyLargeToolResult, MAX_PREVIEW_CHARS, type LargeToolResultStore, } from '../builtins/large-tool-result.js';
import type { AgentMessage } from '../types.js';
function tool(toolCallId: string, content: string, isError = false): AgentMessage {
    return {
        type: 'tool',
        toolCallId,
        content,
        isError,
        turnId: 't',
        timestamp: new Date(),
    } as AgentMessage;
}
function assistantWith(calls: Array<{
    id: string;
    name: string;
}>): AgentMessage {
    return {
        type: 'assistant',
        content: '',
        turnId: 't',
        timestamp: new Date(),
        toolCalls: calls.map((c) => ({ id: c.id, name: c.name, arguments: '{}' })),
    } as AgentMessage;
}
function makeStore(): LargeToolResultStore & {
    writes: Array<{
        name: string;
        size: number;
    }>;
} {
    const writes: Array<{
        name: string;
        size: number;
    }> = [];
    return {
        writes,
        async write(name, content) {
            writes.push({ name, size: content.length });
            return { uri: `mock://${name}/${writes.length}` };
        },
    };
}
const THRESHOLD = 100;
describe('applyLargeToolResult', () => {
    it('writes to store + replaces content when over threshold', async () => {
        const store = makeStore();
        const pending: AgentMessage[] = [
            assistantWith([{ id: 'a', name: 'big_tool' }]),
            tool('a', 'x'.repeat(THRESHOLD + 50)),
        ];
        const n = await applyLargeToolResult(pending, { store, thresholdChars: THRESHOLD, previewChars: 50 });
        expect(n).toBe(1);
        expect(store.writes).toHaveLength(1);
        expect(store.writes[0]).toMatchObject({ name: 'big_tool' });
        const toolMsg = pending[1] as {
            content: string;
        };
        expect(toolMsg.content).toContain('mock://big_tool/1');
        expect(toolMsg.content).toContain('preview head');
        expect(toolMsg.content).toContain('preview tail');
    });
    it('leaves under-threshold tool result untouched', async () => {
        const store = makeStore();
        const pending: AgentMessage[] = [
            assistantWith([{ id: 'a', name: 'small_tool' }]),
            tool('a', 'short'),
        ];
        const n = await applyLargeToolResult(pending, { store, thresholdChars: THRESHOLD });
        expect(n).toBe(0);
        expect((pending[1] as {
            content: string;
        }).content).toBe('short');
    });
    it('skip:true short-circuits the whole pass', async () => {
        const store = makeStore();
        const big = 'x'.repeat(THRESHOLD * 5);
        const pending: AgentMessage[] = [
            assistantWith([{ id: 'a', name: 'big_tool' }]),
            tool('a', big),
        ];
        const n = await applyLargeToolResult(pending, { store, thresholdChars: THRESHOLD, skip: true });
        expect(n).toBe(0);
        expect((pending[1] as {
            content: string;
        }).content).toBe(big);
        expect(store.writes).toHaveLength(0);
    });
    it('truncates tool messages flagged isError in place without calling store.write', async () => {
        const store = makeStore();
        const pending: AgentMessage[] = [
            assistantWith([{ id: 'a', name: 'big_tool' }]),
            tool('a', 'x'.repeat(THRESHOLD * 2), true),
        ];
        const n = await applyLargeToolResult(pending, { store, thresholdChars: THRESHOLD, previewChars: 50 });
        expect(n).toBe(1);
        expect(store.writes).toHaveLength(0);
        const toolMsg = pending[1] as {
            content: string;
        };
        expect(toolMsg.content).toContain('[Tool result over threshold · truncated in place]');
        expect(toolMsg.content).not.toContain('resource uri:');
        expect(toolMsg.content).toContain('preview head');
        expect(toolMsg.content).toContain('preview tail');
    });
    it('envelope preservation: {_preserveEnvelope:true,...} bigger than threshold is NOT truncated', async () => {
        const store = makeStore();
        const envelope = JSON.stringify({ _preserveEnvelope: true, card: { huge: 'x'.repeat(THRESHOLD * 2) } });
        expect(envelope.length).toBeGreaterThan(THRESHOLD);
        const pending: AgentMessage[] = [
            assistantWith([{ id: 'a', name: 'card_tool' }]),
            tool('a', envelope),
        ];
        const n = await applyLargeToolResult(pending, { store, thresholdChars: THRESHOLD, envelopeMarkers: ['_preserveEnvelope'] });
        expect(n).toBe(0);
        expect((pending[1] as {
            content: string;
        }).content).toBe(envelope);
    });
    it('does not preserve product envelopes by default', async () => {
        const pending = [tool('a', JSON.stringify({ _niaCard: true, data: 'x'.repeat(THRESHOLD * 2) }))];
        expect(await applyLargeToolResult(pending, { store: makeStore(), thresholdChars: THRESHOLD })).toBe(1);
    });
    it('truncates explicitly preserved envelopes above the absolute cap', async () => {
        const pending = [tool('a', JSON.stringify({ _preserveEnvelope: true, data: 'x'.repeat(500001) }))];
        expect(await applyLargeToolResult(pending, {
            store: makeStore(), thresholdChars: THRESHOLD, envelopeMarkers: ['_preserveEnvelope'],
        })).toBe(1);
        expect(pending[0].content.length).toBeLessThan(500000);
    });
    it('idToName mapping comes from assistant.toolCalls', async () => {
        const store = makeStore();
        const pending: AgentMessage[] = [
            assistantWith([
                { id: 'a', name: 'web_search' },
                { id: 'b', name: 'web_fetch' },
            ]),
            tool('a', 'x'.repeat(THRESHOLD * 2)),
            tool('b', 'y'.repeat(THRESHOLD * 2)),
        ];
        await applyLargeToolResult(pending, { store, thresholdChars: THRESHOLD });
        expect(store.writes.map((w) => w.name)).toEqual(['web_search', 'web_fetch']);
    });
    it('store.write rejection: truncates content to preview without external URI + does not throw', async () => {
        const store: LargeToolResultStore = {
            async write() {
                throw new Error('redis down');
            },
        };
        const big = 'x'.repeat(THRESHOLD * 5);
        const pending: AgentMessage[] = [
            assistantWith([{ id: 'a', name: 'big_tool' }]),
            tool('a', big),
        ];
        const n = await applyLargeToolResult(pending, { store, thresholdChars: THRESHOLD, previewChars: 50 });
        expect(n).toBe(1);
        const toolMsg = pending[1] as {
            content: string;
        };
        expect(toolMsg.content).toContain('[Tool result over threshold · truncated in place]');
        expect(toolMsg.content).not.toContain('resource uri:');
        expect(toolMsg.content).toContain('preview head');
        expect(toolMsg.content).toContain('preview tail');
        expect(toolMsg.content.length).toBeLessThan(big.length);
    });
    it('clamps pathological previewChars/headFraction to BSON-safe bounds', async () => {
        const store = makeStore();
        const big = 'x'.repeat(MAX_PREVIEW_CHARS + 50000);
        const pending: AgentMessage[] = [
            assistantWith([{ id: 'a', name: 'big_tool' }]),
            tool('a', big),
        ];
        const n = await applyLargeToolResult(pending, {
            store,
            thresholdChars: 100,
            previewChars: 20000000,
            headFraction: 5,
        });
        expect(n).toBe(1);
        const toolMsg = pending[1] as {
            content: string;
        };
        expect(toolMsg.content.length).toBeLessThan(MAX_PREVIEW_CHARS + 1000);
        expect(toolMsg.content).toContain(`--- preview head (${MAX_PREVIEW_CHARS} chars) ---`);
        expect(toolMsg.content).toContain('--- preview tail (0 chars) ---');
    });
    it('UTF-16 surrogate boundary: safe slice does not produce invalid sequences', async () => {
        const rocket = '🚀';
        const body = rocket.repeat(80);
        expect(body.length).toBe(160);
        const store = makeStore();
        const pending: AgentMessage[] = [
            assistantWith([{ id: 'a', name: 'rockets' }]),
            tool('a', body),
        ];
        await applyLargeToolResult(pending, {
            store,
            thresholdChars: 50,
            previewChars: 50,
            headFraction: 0.5,
        });
        const truncated = (pending[1] as {
            content: string;
        }).content;
        for (let i = 0; i < truncated.length; i++) {
            const c = truncated.charCodeAt(i);
            if (c >= 0xd800 && c <= 0xdbff) {
                const next = truncated.charCodeAt(i + 1);
                expect(next).toBeGreaterThanOrEqual(0xdc00);
                expect(next).toBeLessThanOrEqual(0xdfff);
                i++;
            }
            else {
                expect(c < 0xd800 || c > 0xdfff).toBe(true);
            }
        }
    });
});
