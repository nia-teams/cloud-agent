import { canonicalFixture } from './fixtures/canonical.js';
import { describe, it, expect, vi } from 'vitest';
import { AnthropicClient } from '../clients/anthropic.js';
function makeClient(mockResolve: unknown, onRequestDump?: (info: unknown) => void) {
    const c = new AnthropicClient({
        apiKey: 'test',
        model: 'claude-opus-4-7',
        sessionId: 'sess-test',
        onRequestDump: onRequestDump as never,
    });
    (c as any).client = {
        messages: {
            create: vi.fn().mockResolvedValue(mockResolve),
        },
    };
    return c;
}
const REFUSAL_BODY = {
    id: 'msg_r1',
    model: 'claude-opus-4-7',
    role: 'assistant',
    type: 'message',
    content: [],
    stop_reason: 'refusal',
    stop_sequence: null,
    usage: { input_tokens: 34, output_tokens: 3 },
};
const PAUSE_TURN_BODY = {
    id: 'msg_p1',
    model: 'claude-opus-4-7',
    role: 'assistant',
    type: 'message',
    content: [{ type: 'text', text: 'thinking a bit...' }],
    stop_reason: 'pause_turn',
    stop_sequence: null,
    usage: { input_tokens: 20, output_tokens: 5 },
};
const NORMAL_TEXT_BODY = {
    id: 'msg_ok',
    model: 'claude-opus-4-7',
    role: 'assistant',
    type: 'message',
    content: [{ type: 'text', text: 'hello world' }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 3 },
};
const TOOL_USE_ONLY_BODY = {
    id: 'msg_t1',
    model: 'claude-opus-4-7',
    role: 'assistant',
    type: 'message',
    content: [
        {
            type: 'tool_use',
            id: 'toolu_1',
            name: 'search',
            input: { q: 'foo' },
        },
    ],
    stop_reason: 'tool_use',
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 20 },
};
const TRULY_EMPTY_BODY = {
    id: 'msg_empty',
    model: 'claude-opus-4-7',
    role: 'assistant',
    type: 'message',
    content: [],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 5, output_tokens: 0 },
};
describe('AnthropicClient · refusal handling', () => {
    it('stop_reason=refusal + content:[] → 兜底文案 · stopReason=refusal', async () => {
        const c = makeClient(REFUSAL_BODY);
        const r = await c.chat({ messages: canonicalFixture([{ role: 'user', content: 'x' }]) });
        expect(r.stopReason).toBe('refusal');
        expect(r.content).toBeTruthy();
        expect(r.content).toContain('model refused');
        expect(r.toolCalls).toBeUndefined();
    });
    it('stop_reason=pause_turn → 映射到 end_turn（不 fallback 到 undefined 语义）', async () => {
        const c = makeClient(PAUSE_TURN_BODY);
        const r = await c.chat({ messages: canonicalFixture([{ role: 'user', content: 'x' }]) });
        expect(r.stopReason).toBe('end_turn');
        expect(r.content).toBe('thinking a bit...');
    });
});
describe('AnthropicClient · empty response dump', () => {
    it('真 empty response（content=[], stop=end_turn）触发 onRequestDump reason=empty_response', async () => {
        const dumpFn = vi.fn();
        const c = makeClient(TRULY_EMPTY_BODY, dumpFn);
        const r = await c.chat({ messages: canonicalFixture([{ role: 'user', content: 'x' }]) });
        expect(r.content).toBeNull();
        expect(r.toolCalls).toBeUndefined();
        await new Promise((resolve) => setImmediate(resolve));
        expect(dumpFn).toHaveBeenCalledTimes(1);
        const arg = dumpFn.mock.calls[0][0] as {
            reason: string;
            rawMessage: unknown;
            sessionId: string;
        };
        expect(arg.reason).toBe('empty_response');
        expect(arg.sessionId).toBe('sess-test');
        expect(arg.rawMessage).toBeDefined();
        expect((arg.rawMessage as {
            stop_reason: string;
        }).stop_reason).toBe('end_turn');
    });
    it('refusal case 也算 empty response（parsed.content 是我们注入的兜底文案 → 不 empty）· 不触发 dump', async () => {
        const dumpFn = vi.fn();
        const c = makeClient(REFUSAL_BODY, dumpFn);
        await c.chat({ messages: canonicalFixture([{ role: 'user', content: 'x' }]) });
        await new Promise((resolve) => setImmediate(resolve));
        expect(dumpFn).not.toHaveBeenCalled();
    });
    it('正常 text response 不触发 dump', async () => {
        const dumpFn = vi.fn();
        const c = makeClient(NORMAL_TEXT_BODY, dumpFn);
        await c.chat({ messages: canonicalFixture([{ role: 'user', content: 'x' }]) });
        await new Promise((resolve) => setImmediate(resolve));
        expect(dumpFn).not.toHaveBeenCalled();
    });
    it('只有 tool_use 无 text 不算 empty（agent-loop 常态） · 不触发 dump', async () => {
        const dumpFn = vi.fn();
        const c = makeClient(TOOL_USE_ONLY_BODY, dumpFn);
        const r = await c.chat({ messages: canonicalFixture([{ role: 'user', content: 'x' }]) });
        expect(r.toolCalls).toHaveLength(1);
        expect(r.content).toBeNull();
        await new Promise((resolve) => setImmediate(resolve));
        expect(dumpFn).not.toHaveBeenCalled();
    });
});
