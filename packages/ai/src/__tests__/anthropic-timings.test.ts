import { canonicalFixture } from './fixtures/canonical.js';
import { describe, it, expect, vi, beforeEach } from 'vitest';
type StreamEvent = {
    type: 'thinking';
    content: string;
} | {
    type: 'text';
    content: string;
} | {
    type: 'streamEvent';
    event: {
        type: 'content_block_start';
        index: number;
        content_block: {
            type: 'tool_use';
            id: string;
            name: string;
        };
    };
};
interface FakeFinal {
    content?: Array<{
        type: string;
        text?: string;
        input?: unknown;
        id?: string;
        name?: string;
    }>;
    stop_reason?: string;
    usage?: {
        input_tokens: number;
        output_tokens: number;
    };
}
interface FakeScript {
    events: Array<{
        delayMs: number;
        ev: StreamEvent;
    }>;
    final: FakeFinal;
    finalDelayMs?: number;
}
const hoisted = vi.hoisted(() => ({ script: null as FakeScript | null }));
function setScript(script: FakeScript) {
    hoisted.script = script;
}
vi.mock('@anthropic-ai/sdk', () => {
    class FakeAnthropic {
        messages: {
            create: (p: unknown) => Promise<FakeFinal>;
            stream: (p: unknown) => {
                on: (name: string, cb: (arg: unknown) => void) => void;
                finalMessage: () => Promise<FakeFinal>;
                currentMessage: FakeFinal | undefined;
            };
        };
        constructor() {
            const handlers = new Map<string, (arg: unknown) => void>();
            let scheduled = false;
            const script = () => hoisted.script;
            const runScript = async (): Promise<FakeFinal> => {
                const s = script();
                if (!s)
                    throw new Error('No script set — call setScript before stream()');
                for (const step of s.events) {
                    if (step.delayMs > 0)
                        await new Promise((r) => setTimeout(r, step.delayMs));
                    const ev = step.ev;
                    if (ev.type === 'thinking') {
                        handlers.get('thinking')?.(ev.content);
                    }
                    else if (ev.type === 'text') {
                        handlers.get('text')?.(ev.content);
                    }
                    else {
                        handlers.get('streamEvent')?.(ev.event);
                    }
                }
                if (s.finalDelayMs)
                    await new Promise((r) => setTimeout(r, s.finalDelayMs));
                return s.final;
            };
            this.messages = {
                create: vi.fn(async () => ({ content: [], stop_reason: 'end_turn', usage: { input_tokens: 0, output_tokens: 0 } })),
                stream: vi.fn(() => {
                    let finalPromise: Promise<FakeFinal> | null = null;
                    return {
                        on: (name: string, cb: (arg: unknown) => void) => {
                            handlers.set(name, cb);
                        },
                        finalMessage: () => {
                            if (!scheduled) {
                                scheduled = true;
                                finalPromise = runScript();
                            }
                            return finalPromise!;
                        },
                        get currentMessage() {
                            return script()?.final;
                        },
                    };
                }),
            };
        }
    }
    return { default: FakeAnthropic };
});
vi.mock('undici', () => ({ ProxyAgent: class {
    } }));
const { AnthropicClient } = await import('../clients/anthropic.js');
beforeEach(() => {
    hoisted.script = null;
});
describe('AnthropicClient · streaming timings', () => {
    it('populates ttftMs / generateMs / outputTokensPerSec when text-first', async () => {
        setScript({
            events: [
                { delayMs: 50, ev: { type: 'text', content: 'hello' } },
                { delayMs: 20, ev: { type: 'text', content: ' world' } },
            ],
            final: {
                content: [{ type: 'text', text: 'hello world' }],
                stop_reason: 'end_turn',
                usage: { input_tokens: 10, output_tokens: 200 },
            },
            finalDelayMs: 200,
        });
        const client = new AnthropicClient({ apiKey: 'k', model: 'claude-opus-4-7' });
        const res = await client.chat({
            messages: canonicalFixture([{ role: 'user', content: 'hi' }] as never),
            onStreamDelta: () => { },
        });
        expect(res.timings).toBeDefined();
        expect(res.timings!.ttftMs).toBeGreaterThanOrEqual(40);
        expect(res.timings!.ttftMs).toBeLessThan(500);
        expect(res.timings!.generateMs).toBeGreaterThanOrEqual(100);
        expect(res.timings!.outputTokensPerSec).toBeDefined();
        expect(res.timings!.outputTokensPerSec!).toBeGreaterThan(100);
    });
    it('first chunk on thinking event still marks TTFT', async () => {
        setScript({
            events: [
                { delayMs: 30, ev: { type: 'thinking', content: 'let me think...' } },
                { delayMs: 20, ev: { type: 'text', content: 'answer' } },
            ],
            final: {
                content: [
                    { type: 'thinking', text: 'let me think...' },
                    { type: 'text', text: 'answer' },
                ],
                stop_reason: 'end_turn',
                usage: { input_tokens: 10, output_tokens: 50 },
            },
            finalDelayMs: 200,
        });
        const client = new AnthropicClient({ apiKey: 'k', model: 'claude-opus-4-7' });
        const res = await client.chat({
            messages: canonicalFixture([{ role: 'user', content: 'hi' }] as never),
            onStreamDelta: () => { },
        });
        expect(res.timings).toBeDefined();
        expect(res.timings!.ttftMs).toBeLessThan(50);
    });
    it('first chunk on tool_input_start (content_block_start tool_use) marks TTFT', async () => {
        setScript({
            events: [
                {
                    delayMs: 40,
                    ev: {
                        type: 'streamEvent',
                        event: {
                            type: 'content_block_start',
                            index: 0,
                            content_block: { type: 'tool_use', id: 'tool_1', name: 'get_weather' },
                        },
                    },
                },
            ],
            final: {
                content: [{ type: 'tool_use', id: 'tool_1', name: 'get_weather', input: {} }],
                stop_reason: 'tool_use',
                usage: { input_tokens: 10, output_tokens: 20 },
            },
            finalDelayMs: 200,
        });
        const client = new AnthropicClient({ apiKey: 'k', model: 'claude-opus-4-7' });
        const res = await client.chat({
            messages: canonicalFixture([{ role: 'user', content: 'hi' }] as never),
            onStreamDelta: () => { },
        });
        expect(res.timings).toBeDefined();
        expect(res.timings!.ttftMs).toBeGreaterThanOrEqual(30);
        expect(res.timings!.ttftMs).toBeLessThan(200);
    });
    it('non-streaming call has no timings', async () => {
        const client = new AnthropicClient({ apiKey: 'k', model: 'claude-opus-4-7' });
        const res = await client.chat({
            messages: canonicalFixture([{ role: 'user', content: 'hi' }] as never),
        });
        expect(res.timings).toBeUndefined();
    });
    it('outputTokensPerSec undefined when generateMs < 100ms (unstable sample)', async () => {
        setScript({
            events: [{ delayMs: 20, ev: { type: 'text', content: 'ok' } }],
            final: {
                content: [{ type: 'text', text: 'ok' }],
                stop_reason: 'end_turn',
                usage: { input_tokens: 5, output_tokens: 1 },
            },
        });
        const client = new AnthropicClient({ apiKey: 'k', model: 'claude-opus-4-7' });
        const res = await client.chat({
            messages: canonicalFixture([{ role: 'user', content: 'hi' }] as never),
            onStreamDelta: () => { },
        });
        expect(res.timings).toBeDefined();
        expect(res.timings!.generateMs).toBeLessThan(100);
        expect(res.timings!.outputTokensPerSec).toBeUndefined();
    });
    it('outputTokensPerSec undefined when usage missing', async () => {
        setScript({
            events: [{ delayMs: 30, ev: { type: 'text', content: 'answer' } }],
            final: {
                content: [{ type: 'text', text: 'answer' }],
                stop_reason: 'end_turn',
            },
            finalDelayMs: 200,
        });
        const client = new AnthropicClient({ apiKey: 'k', model: 'claude-opus-4-7' });
        const res = await client.chat({
            messages: canonicalFixture([{ role: 'user', content: 'hi' }] as never),
            onStreamDelta: () => { },
        });
        expect(res.timings).toBeDefined();
        expect(res.timings!.generateMs).toBeGreaterThanOrEqual(100);
        expect(res.timings!.outputTokensPerSec).toBeUndefined();
    });
});
