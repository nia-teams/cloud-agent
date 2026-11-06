import { canonicalFixture } from './fixtures/canonical.js';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AnthropicClient } from '../clients/anthropic.js';
function makeClientWithMockedSdk(mockResolve: unknown) {
    const c = new AnthropicClient({
        apiKey: 'test',
        model: 'claude-opus-4-6-bc-east',
        baseURL: 'http://fake',
    });
    (c as any).client = {
        messages: {
            create: vi.fn().mockResolvedValue(mockResolve),
        },
    };
    return c;
}
const VALID_BODY = {
    id: 'msg_1',
    model: 'claude-opus-4-6',
    role: 'assistant',
    type: 'message',
    content: [
        { type: 'text', text: 'hello' },
    ],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 3 },
};
describe('AnthropicClient.parseResponse · text/plain 兜底', () => {
    beforeEach(() => {
        vi.restoreAllMocks();
    });
    afterEach(() => {
        vi.restoreAllMocks();
    });
    it('SDK 返字符串（text/plain 上游）时自动 JSON.parse 走通', async () => {
        const c = makeClientWithMockedSdk(JSON.stringify(VALID_BODY));
        const r = await c.chat({
            messages: canonicalFixture([{ role: 'user', content: 'hi' }]),
        });
        expect(r.content).toBe('hello');
        expect(r.stopReason).toBe('end_turn');
    });
    it('字符串 body 解 JSON 失败时抛带预览的错', async () => {
        const c = makeClientWithMockedSdk('not json !!!');
        await expect(c.chat({ messages: canonicalFixture([{ role: 'user', content: 'hi' }]) })).rejects.toThrow(/non-JSON string.*Body preview: not json/);
    });
    it('content 不是数组（如 null）时抛带 stop_reason 的错', async () => {
        const c = makeClientWithMockedSdk({ ...VALID_BODY, content: null });
        await expect(c.chat({ messages: canonicalFixture([{ role: 'user', content: 'hi' }]) })).rejects.toThrow(/content is not an array.*typeof=object.*stop_reason=end_turn/);
    });
    it('content 是 string 时抛带 typeof=string 的错（防御未来代理乱拼形态）', async () => {
        const c = makeClientWithMockedSdk({ ...VALID_BODY, content: 'oops' });
        await expect(c.chat({ messages: canonicalFixture([{ role: 'user', content: 'hi' }]) })).rejects.toThrow(/typeof=string/);
    });
    it('正常路径（SDK 返已解析对象）继续工作', async () => {
        const c = makeClientWithMockedSdk(VALID_BODY);
        const r = await c.chat({
            messages: canonicalFixture([{ role: 'user', content: 'hi' }]),
        });
        expect(r.content).toBe('hello');
    });
});
