import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ContextPruner, lookupContextWindow, createContextPruningPlugin } from '../builtins/context-pruning.js';
import { AgentRuntime } from '../index.js';
import { MemoryStore, MockLLMClient, userEvent } from './fixtures.js';
import type { AgentMessage } from '../protocol/llm-protocol.js';
function bigToolMsg(toolCallId: string, contentLen: number): AgentMessage {
    return {
        type: 'tool',
        toolCallId,
        content: 'X'.repeat(contentLen),
        isError: false,
        timestamp: new Date(),
    };
}
function assistantMsg(content: string): AgentMessage {
    return { type: 'assistant', content, timestamp: new Date() };
}
function bigEventMsg(toolCallId: string, contentLen: number, isError = false): AgentMessage {
    return {
        type: 'event',
        eventType: 'tool.result',
        content: `[Tool Result] toolCallId=${toolCallId} isError=${isError}\n${'X'.repeat(contentLen)}`,
        timestamp: new Date(),
    };
}
describe('AgentRuntime · RunOptions.contextWindow wiring', () => {
    function buildHistory(): AgentMessage[] {
        return [
            bigToolMsg('1', 37500),
            assistantMsg('a'),
            bigToolMsg('2', 37500),
            assistantMsg('b'),
            bigToolMsg('3', 37500),
            assistantMsg('c'),
            bigToolMsg('4', 37500),
            assistantMsg('d'),
            userEvent('please continue'),
        ];
    }
    const SYSTEM_PROMPT = 'S'.repeat(110000);
    it('opts.contextWindow=1,000,000 is honored end-to-end: 150k-char history reaches the LLM untouched', async () => {
        const store = new MemoryStore(buildHistory());
        const client = new MockLLMClient([{ content: 'ok' }]);
        const runtime = new AgentRuntime({ store, sessionId: 'ctxwin-1m', plugins: [createContextPruningPlugin()] });
        await runtime.run({
            client,
            systemPrompt: SYSTEM_PROMPT,
            tools: [],
            keyId: 'k1',
            contextWindow: 1000000,
        });
        const seenMessages = client.calls[0].messages as unknown as AgentMessage[];
        const tool1 = seenMessages.find((m) => m.type === 'tool' && m.toolCallId === '1') as Extract<AgentMessage, {
            type: 'tool';
        }>;
        expect(tool1.content.length).toBe(37500);
    });
    it('omitting opts.contextWindow falls back to lookupContextWindow (pre-change behavior, regression guard): same 150k history DOES get soft-trimmed', async () => {
        const store = new MemoryStore(buildHistory());
        const client = new MockLLMClient([{ content: 'ok' }]);
        const runtime = new AgentRuntime({ store, sessionId: 'ctxwin-fallback', plugins: [createContextPruningPlugin()] });
        await runtime.run({
            client,
            systemPrompt: SYSTEM_PROMPT,
            tools: [],
            keyId: 'k1',
        });
        expect(lookupContextWindow(client.getModelName())).toBe(200000);
        const seenMessages = client.calls[0].messages as unknown as AgentMessage[];
        const tool1 = seenMessages.find((m) => m.type === 'tool' && m.toolCallId === '1') as Extract<AgentMessage, {
            type: 'tool';
        }>;
        expect(tool1.content.length).toBeLessThan(37500);
    });
    it('the SAME 150k-char history soft-trims when opts.contextWindow=200,000 — proves the difference is the passed-in value, not an under-sized fixture', async () => {
        const store = new MemoryStore(buildHistory());
        const client = new MockLLMClient([{ content: 'ok' }]);
        const runtime = new AgentRuntime({ store, sessionId: 'ctxwin-200k', plugins: [createContextPruningPlugin()] });
        await runtime.run({
            client,
            systemPrompt: SYSTEM_PROMPT,
            tools: [],
            keyId: 'k1',
            contextWindow: 200000,
        });
        const seenMessages = client.calls[0].messages as unknown as AgentMessage[];
        const tool1 = seenMessages.find((m) => m.type === 'tool' && m.toolCallId === '1') as Extract<AgentMessage, {
            type: 'tool';
        }>;
        expect(tool1.content.length).toBeLessThan(37500);
    });
});
describe('lookupContextWindow', () => {
    it('returns default for unknown models', () => {
        expect(lookupContextWindow('unknown')).toBe(200000);
    });
    it('matches exact known models', () => {
        expect(lookupContextWindow('gemini-2.5-pro')).toBe(1000000);
    });
    it('matches by prefix', () => {
        expect(lookupContextWindow('gpt-4o-2024-11-20')).toBe(128000);
    });
});
describe('ContextPruner', () => {
    it('returns same array reference when below SOFT_TRIM_RATIO', () => {
        const pruner = new ContextPruner();
        const msgs: AgentMessage[] = [bigToolMsg('a', 100), assistantMsg('hi')];
        const out = pruner.prune(msgs, 200000, 's1');
        expect(out).toBe(msgs);
    });
    it('soft-trims big tool results when over threshold', () => {
        const pruner = new ContextPruner();
        const msgs: AgentMessage[] = [
            bigToolMsg('1', 80000),
            assistantMsg('a'),
            bigToolMsg('2', 80000),
            assistantMsg('b'),
            bigToolMsg('3', 80000),
            assistantMsg('c'),
            bigToolMsg('4', 80000),
            assistantMsg('d'),
        ];
        const out = pruner.prune(msgs, 200000, 's2');
        expect(out).not.toBe(msgs);
        const totalAfter = (out as AgentMessage[]).reduce((sum, m) => sum + ((m as {
            content?: string;
        }).content?.length ?? 0), 0);
        const totalBefore = msgs.reduce((sum, m) => sum + ((m as {
            content?: string;
        }).content?.length ?? 0), 0);
        expect(totalAfter).toBeLessThan(totalBefore);
    });
    it('cache TTL: second call within 5min still re-applies the decided cut (never returns raw input)', () => {
        const pruner = new ContextPruner();
        const msgs: AgentMessage[] = [
            bigToolMsg('1', 80000),
            assistantMsg('a'),
            bigToolMsg('2', 80000),
            assistantMsg('b'),
            bigToolMsg('3', 80000),
            assistantMsg('c'),
            bigToolMsg('4', 80000),
            assistantMsg('d'),
        ];
        const first = pruner.prune(msgs, 200000, 's3') as AgentMessage[];
        expect(first).not.toBe(msgs);
        const rebuilt: AgentMessage[] = [
            bigToolMsg('1', 80000),
            assistantMsg('a'),
            bigToolMsg('2', 80000),
            assistantMsg('b'),
            bigToolMsg('3', 80000),
            assistantMsg('c'),
            bigToolMsg('4', 80000),
            assistantMsg('d'),
        ];
        const second = pruner.prune(rebuilt, 200000, 's3') as AgentMessage[];
        expect(second).not.toBe(rebuilt);
        const totalSecond = second.reduce((sum, m) => sum + ((m as {
            content?: string;
        }).content?.length ?? 0), 0);
        const totalRebuilt = rebuilt.reduce((sum, m) => sum + ((m as {
            content?: string;
        }).content?.length ?? 0), 0);
        expect(totalSecond).toBeLessThan(totalRebuilt);
    });
    it('TTL suppresses widening: appending new messages within TTL keeps the same trimmed set/levels', () => {
        const pruner = new ContextPruner();
        const base: AgentMessage[] = [
            bigToolMsg('1', 80000),
            assistantMsg('a'),
            bigToolMsg('2', 80000),
            assistantMsg('b'),
            bigToolMsg('3', 80000),
            assistantMsg('c'),
            bigToolMsg('4', 80000),
            assistantMsg('d'),
        ];
        const first = pruner.prune(base, 200000, 's3b') as AgentMessage[];
        expect(first).not.toBe(base);
        const tool1First = first.find((m) => m.type === 'tool' && m.toolCallId === '1') as Extract<AgentMessage, {
            type: 'tool';
        }>;
        const rebuiltWithMore: AgentMessage[] = [
            ...base,
            bigToolMsg('5', 200000),
            assistantMsg('e'),
        ];
        const second = pruner.prune(rebuiltWithMore, 200000, 's3b') as AgentMessage[];
        const tool1Second = second.find((m) => m.type === 'tool' && m.toolCallId === '1') as Extract<AgentMessage, {
            type: 'tool';
        }>;
        expect(tool1Second.content).toBe(tool1First.content);
        const tool5 = second.find((m) => m.type === 'tool' && m.toolCallId === '5') as Extract<AgentMessage, {
            type: 'tool';
        }>;
        expect(tool5.content.length).toBe(200000);
    });
    it('keeps last 3 assistants intact', () => {
        const pruner = new ContextPruner();
        const big = bigToolMsg('latest', 80000);
        const msgs: AgentMessage[] = [
            bigToolMsg('1', 80000),
            assistantMsg('a'),
            bigToolMsg('2', 80000),
            assistantMsg('b'),
            bigToolMsg('3', 80000),
            assistantMsg('c'),
            big,
            assistantMsg('d'),
        ];
        const out = pruner.prune(msgs, 200000, 's4') as AgentMessage[];
        const latest = out.find((m) => m.type === 'tool' && m.toolCallId === 'latest') as Extract<AgentMessage, {
            type: 'tool';
        }>;
        expect(latest.content.length).toBe(80000);
    });
    it('respects custom softTrimRatio (0.3) — kicks in earlier', () => {
        const msgs: AgentMessage[] = [
            bigToolMsg('1', 50000),
            assistantMsg('a'),
            bigToolMsg('2', 50000),
            assistantMsg('b'),
            bigToolMsg('3', 50000),
            assistantMsg('c'),
            bigToolMsg('4', 50000),
            assistantMsg('d'),
        ];
        const defaultPruner = new ContextPruner();
        const outDefault = defaultPruner.prune(msgs, 200000, 's-default');
        expect(outDefault).toBe(msgs);
        const lowerPruner = new ContextPruner({ softTrimRatio: 0.3, hardClearRatio: 0.5 });
        const outLower = lowerPruner.prune(msgs, 200000, 's-lower');
        expect(outLower).not.toBe(msgs);
    });
    it('respects custom hardClearRatio — soft-trim stops earlier when raised', () => {
        const msgs: AgentMessage[] = [
            bigToolMsg('1', 80000),
            assistantMsg('a'),
            bigToolMsg('2', 80000),
            assistantMsg('b'),
            bigToolMsg('3', 80000),
            assistantMsg('c'),
            bigToolMsg('4', 80000),
            assistantMsg('d'),
        ];
        const pruner = new ContextPruner({ hardClearRatio: 0.9 });
        const out = pruner.prune(msgs, 200000, 's-hard') as AgentMessage[];
        expect(out).not.toBe(msgs);
        const hadHardClear = out.some((m) => m.type === 'tool' && m.content === '[Old tool result content cleared]');
        expect(hadHardClear).toBe(false);
    });
    describe('monotonic decisions across turns', () => {
        beforeEach(() => {
            vi.useFakeTimers();
            vi.setSystemTime(new Date('2026-07-27T00:00:00Z'));
        });
        afterEach(() => {
            vi.useRealTimers();
        });
        it('after TTL expiry, widening is allowed: new soft-trim + upgrade to hard-clear', () => {
            const pruner = new ContextPruner();
            const base: AgentMessage[] = [
                bigToolMsg('1', 80000),
                assistantMsg('a'),
                bigToolMsg('2', 80000),
                assistantMsg('b'),
                bigToolMsg('3', 80000),
                assistantMsg('c'),
                bigToolMsg('4', 80000),
                assistantMsg('d'),
            ];
            const first = pruner.prune(base, 200000, 's5') as AgentMessage[];
            expect(first).not.toBe(base);
            const hadHardClearFirst = first.some((m) => m.type === 'tool' && m.content === '[Old tool result content cleared]');
            expect(hadHardClearFirst).toBe(false);
            vi.advanceTimersByTime(6 * 60 * 1000);
            const grown: AgentMessage[] = [
                ...base,
                bigToolMsg('5', 300000),
                assistantMsg('e'),
            ];
            const second = pruner.prune(grown, 200000, 's5') as AgentMessage[];
            const hadHardClearSecond = second.some((m) => m.type === 'tool' && m.content === '[Old tool result content cleared]');
            expect(hadHardClearSecond).toBe(true);
        });
        it('monotonic: once hard-cleared, a later call never reverts to soft or original content', () => {
            const pruner = new ContextPruner({ hardClearRatio: 0.5 });
            const base: AgentMessage[] = [
                bigToolMsg('1', 80000),
                assistantMsg('a'),
                bigToolMsg('2', 80000),
                assistantMsg('b'),
                bigToolMsg('3', 80000),
                assistantMsg('c'),
                bigToolMsg('4', 80000),
                assistantMsg('d'),
            ];
            const first = pruner.prune(base, 10000, 's6') as AgentMessage[];
            const tool1First = first.find((m) => m.type === 'tool' && m.toolCallId === '1') as Extract<AgentMessage, {
                type: 'tool';
            }>;
            expect(tool1First.content).toBe('[Old tool result content cleared]');
            vi.advanceTimersByTime(6 * 60 * 1000);
            const rebuiltSmaller: AgentMessage[] = [
                bigToolMsg('1', 80000),
                assistantMsg('a'),
                assistantMsg('b'),
                assistantMsg('c'),
                assistantMsg('d'),
            ];
            const second = pruner.prune(rebuiltSmaller, 10000, 's6') as AgentMessage[];
            const tool1Second = second.find((m) => m.type === 'tool' && m.toolCallId === '1') as Extract<AgentMessage, {
                type: 'tool';
            }>;
            expect(tool1Second.content).toBe('[Old tool result content cleared]');
        });
    });
    it('no history + below threshold → returns the exact same array reference', () => {
        const pruner = new ContextPruner();
        const msgs: AgentMessage[] = [bigToolMsg('a', 100), assistantMsg('hi')];
        const out = pruner.prune(msgs, 200000, 's-identity');
        expect(out).toBe(msgs);
    });
    describe('event/tool.result form (interleave path, no meta)', () => {
        it('monotonicity: a cut decided on an event-form message survives a from-scratch rebuild (gap 1 core assertion)', () => {
            const pruner = new ContextPruner();
            const base: AgentMessage[] = [
                bigEventMsg('1', 80000),
                assistantMsg('a'),
                bigEventMsg('2', 80000),
                assistantMsg('b'),
                bigEventMsg('3', 80000),
                assistantMsg('c'),
                bigEventMsg('4', 80000),
                assistantMsg('d'),
            ];
            const first = pruner.prune(base, 200000, 'evt-1') as AgentMessage[];
            expect(first).not.toBe(base);
            const tool1First = first.find((m) => m.type === 'event' && m.content.startsWith('[Tool Result] toolCallId=1 '));
            expect(tool1First).toBeDefined();
            expect((tool1First as {
                content: string;
            }).content.length).toBeLessThan(80000);
            const rebuilt: AgentMessage[] = [
                bigEventMsg('1', 80000),
                assistantMsg('a'),
                bigEventMsg('2', 80000),
                assistantMsg('b'),
                bigEventMsg('3', 80000),
                assistantMsg('c'),
                bigEventMsg('4', 80000),
                assistantMsg('d'),
                assistantMsg('interleaved reply'),
            ];
            const second = pruner.prune(rebuilt, 200000, 'evt-1') as AgentMessage[];
            const tool1Second = second.find((m) => m.type === 'event' && m.content.startsWith('[Tool Result] toolCallId=1 '));
            expect(tool1Second).toBeDefined();
            expect((tool1Second as {
                content: string;
            }).content.length).toBeLessThan(80000);
        });
        it('mixed tool + event forms in the same session both get monotonic protection', () => {
            const pruner = new ContextPruner();
            const base: AgentMessage[] = [
                bigToolMsg('t1', 80000),
                assistantMsg('a'),
                bigEventMsg('e1', 80000),
                assistantMsg('b'),
                bigToolMsg('t2', 80000),
                assistantMsg('c'),
                bigEventMsg('e2', 80000),
                assistantMsg('d'),
            ];
            const first = pruner.prune(base, 200000, 'mixed-1') as AgentMessage[];
            expect(first).not.toBe(base);
            const rebuilt: AgentMessage[] = [
                bigToolMsg('t1', 80000),
                assistantMsg('a'),
                bigEventMsg('e1', 80000),
                assistantMsg('b'),
                bigToolMsg('t2', 80000),
                assistantMsg('c'),
                bigEventMsg('e2', 80000),
                assistantMsg('d'),
            ];
            const second = pruner.prune(rebuilt, 200000, 'mixed-1') as AgentMessage[];
            const t1 = second.find((m) => m.type === 'tool' && m.toolCallId === 't1') as Extract<AgentMessage, {
                type: 'tool';
            }>;
            const e1 = second.find((m) => m.type === 'event' && m.content.startsWith('[Tool Result] toolCallId=e1 ')) as Extract<AgentMessage, {
                type: 'event';
            }>;
            expect(t1.content.length).toBeLessThan(80000);
            expect(e1.content.length).toBeLessThan(80000 + 40);
        });
        it('event message whose content does not match the header prefix is handled from-scratch, never throws, never enters the decision table', () => {
            const pruner = new ContextPruner();
            const untrackable: AgentMessage = {
                type: 'event',
                eventType: 'tool.result',
                content: 'X'.repeat(80000),
                timestamp: new Date(),
            };
            const base: AgentMessage[] = [
                untrackable,
                assistantMsg('a'),
                bigToolMsg('t1', 80000),
                assistantMsg('b'),
                bigToolMsg('t2', 80000),
                assistantMsg('c'),
                bigToolMsg('t3', 80000),
                assistantMsg('d'),
            ];
            expect(() => pruner.prune(base, 200000, 'untrackable-1')).not.toThrow();
            const out = pruner.prune(base, 200000, 'untrackable-1') as AgentMessage[];
            const found = out.find((m) => m.type === 'event') as Extract<AgentMessage, {
                type: 'event';
            }>;
            expect(found).toBeDefined();
        });
        it('a mid-string occurrence of the header text does not get misparsed as the id (anchored to start only)', () => {
            const pruner = new ContextPruner();
            const msg: AgentMessage = {
                type: 'event',
                eventType: 'tool.result',
                content: `Some preamble.\n[Tool Result] toolCallId=should-not-match isError=false\n${'X'.repeat(80000)}`,
                timestamp: new Date(),
            };
            const base: AgentMessage[] = [
                msg,
                assistantMsg('a'),
                bigToolMsg('t1', 80000),
                assistantMsg('b'),
                bigToolMsg('t2', 80000),
                assistantMsg('c'),
                bigToolMsg('t3', 80000),
                assistantMsg('d'),
            ];
            const first = pruner.prune(base, 200000, 'anchor-1') as AgentMessage[];
            expect(first).not.toBe(base);
            const rebuilt: AgentMessage[] = [
                { ...msg },
                assistantMsg('a'),
                bigToolMsg('t1', 80000),
                assistantMsg('b'),
                bigToolMsg('t2', 80000),
                assistantMsg('c'),
                bigToolMsg('t3', 80000),
                assistantMsg('d'),
            ];
            const second = pruner.prune(rebuilt, 200000, 'anchor-1') as AgentMessage[];
            const t1 = second.find((m) => m.type === 'tool' && m.toolCallId === 't1') as Extract<AgentMessage, {
                type: 'tool';
            }>;
            expect(t1.content.length).toBeLessThan(80000);
        });
        it('hard-clear on an event message preserves the header so stableId can still recover the id afterward', () => {
            const pruner = new ContextPruner({ hardClearRatio: 0.5 });
            const base: AgentMessage[] = [
                bigEventMsg('e1', 80000),
                assistantMsg('a'),
                bigEventMsg('e2', 80000),
                assistantMsg('b'),
                bigEventMsg('e3', 80000),
                assistantMsg('c'),
                bigEventMsg('e4', 80000),
                assistantMsg('d'),
            ];
            const out = pruner.prune(base, 10000, 'hardclear-evt') as AgentMessage[];
            const e1 = out.find((m) => m.type === 'event' && m.content.startsWith('[Tool Result] toolCallId=e1 ')) as Extract<AgentMessage, {
                type: 'event';
            }>;
            expect(e1.content).toContain('[Old tool result content cleared]');
            expect(e1.content.startsWith('[Tool Result] toolCallId=e1 isError=false')).toBe(true);
        });
    });
    describe('internal state cleanup (no unbounded map growth)', () => {
        beforeEach(() => {
            vi.useFakeTimers();
            vi.setSystemTime(new Date('2026-07-27T00:00:00Z'));
        });
        afterEach(() => {
            vi.useRealTimers();
        });
        it('sessions that are evaluated but never actually pruned do not leak entries forever', () => {
            const pruner = new ContextPruner();
            type Internals = {
                toolResultLevels: Map<string, unknown>;
                lastEvalTimestamps: Map<string, unknown>;
                lastTouchedAt: Map<string, unknown>;
            };
            const internals = pruner as unknown as Internals;
            for (let i = 0; i < 50; i++) {
                pruner.prune([bigToolMsg(`t${i}`, 100), assistantMsg('hi')], 200000, `quiet-session-${i}`);
            }
            expect(internals.lastTouchedAt.size).toBe(50);
            vi.advanceTimersByTime(21 * 60 * 1000);
            pruner.prune([assistantMsg('trigger cleanup')], 200000, 'trigger-session');
            expect(internals.lastTouchedAt.size).toBe(1);
            expect(internals.toolResultLevels.size).toBe(0);
            expect(internals.lastEvalTimestamps.size).toBe(0);
        });
        it('sessions that DO get pruned are also cleaned up once stale', () => {
            const pruner = new ContextPruner();
            type Internals = {
                toolResultLevels: Map<string, unknown>;
            };
            const internals = pruner as unknown as Internals;
            const base: AgentMessage[] = [
                bigToolMsg('1', 80000),
                assistantMsg('a'),
                bigToolMsg('2', 80000),
                assistantMsg('b'),
                bigToolMsg('3', 80000),
                assistantMsg('c'),
                bigToolMsg('4', 80000),
                assistantMsg('d'),
            ];
            pruner.prune(base, 200000, 'active-session');
            expect(internals.toolResultLevels.has('active-session')).toBe(true);
            vi.advanceTimersByTime(21 * 60 * 1000);
            pruner.prune([assistantMsg('trigger cleanup')], 200000, 'trigger-session-2');
            expect(internals.toolResultLevels.has('active-session')).toBe(false);
        });
    });
});
