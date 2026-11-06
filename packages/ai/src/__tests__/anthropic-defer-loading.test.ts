import { canonicalFixture } from './fixtures/canonical.js';
import { describe, it, expect, vi } from 'vitest';
import { AnthropicClient } from '../clients/anthropic.js';
import type Anthropic from '@anthropic-ai/sdk';
function makeClient(opts: {
    supportsDeferLoading?: boolean;
    disableToolDeferral?: boolean;
    supportsMidConversationTools?: boolean;
}) {
    const c = new AnthropicClient({
        apiKey: 'test',
        model: 'claude-test-model',
        baseURL: 'http://fake',
        supportsDeferLoading: opts.supportsDeferLoading,
        disableToolDeferral: opts.disableToolDeferral,
        supportsMidConversationTools: opts.supportsMidConversationTools,
    });
    const captured: Anthropic.MessageCreateParams[] = [];
    const capturedOptions: Array<{
        headers?: Record<string, string>;
    } | undefined> = [];
    (c as any).client = {
        messages: {
            create: vi.fn().mockImplementation((params: Anthropic.MessageCreateParams, options?: {
                headers?: Record<string, string>;
            }) => {
                captured.push(JSON.parse(JSON.stringify(params)));
                capturedOptions.push(options);
                return Promise.resolve({
                    id: 'msg_1',
                    model: 'claude-test-model',
                    role: 'assistant',
                    type: 'message',
                    content: [{ type: 'text', text: 'ok' }],
                    stop_reason: 'end_turn',
                    stop_sequence: null,
                    usage: { input_tokens: 10, output_tokens: 1 },
                });
            }),
        },
    };
    return { client: c, captured, capturedOptions };
}
const baseTools = [
    { name: 'always_loaded', description: 'always loaded', inputSchema: { type: 'object', properties: {} } },
    { name: 'deferred_a', description: 'deferred a', inputSchema: { type: 'object', properties: {} }, deferLoading: true },
    { name: 'deferred_b', description: 'deferred b', inputSchema: { type: 'object', properties: {} }, deferLoading: true },
];
describe('AnthropicClient · defer_loading 序列化', () => {
    it('supportsDeferLoading:true 时，deferLoading:true 的工具被序列化成 defer_loading:true', async () => {
        const { client, captured } = makeClient({ supportsDeferLoading: true });
        await client.chat({ messages: canonicalFixture([{ role: 'user', content: 'hi' }]), tools: baseTools });
        const tools = captured[0].tools as Array<Record<string, unknown>>;
        expect(tools.find((t) => t.name === 'always_loaded')?.defer_loading).toBeUndefined();
        expect(tools.find((t) => t.name === 'deferred_a')?.defer_loading).toBe(true);
        expect(tools.find((t) => t.name === 'deferred_b')?.defer_loading).toBe(true);
    });
    it('supportsDeferLoading 未设（模型不支持）时，deferLoading:true 被静默降级成完整 schema，不报错', async () => {
        const { client, captured } = makeClient({});
        await client.chat({ messages: canonicalFixture([{ role: 'user', content: 'hi' }]), tools: baseTools });
        const tools = captured[0].tools as Array<Record<string, unknown>>;
        for (const t of tools) {
            expect(t.defer_loading).toBeUndefined();
        }
    });
    it('disableToolDeferral:true 优先于 supportsDeferLoading:true —— 强制关闭 defer', async () => {
        const { client, captured } = makeClient({ supportsDeferLoading: true, disableToolDeferral: true });
        await client.chat({ messages: canonicalFixture([{ role: 'user', content: 'hi' }]), tools: baseTools });
        const tools = captured[0].tools as Array<Record<string, unknown>>;
        for (const t of tools) {
            expect(t.defer_loading).toBeUndefined();
        }
    });
    it('cache breakpoint 落在最后一个非 deferred 工具上，不落在 deferred 工具上', async () => {
        const { client, captured } = makeClient({ supportsDeferLoading: true });
        await client.chat({ messages: canonicalFixture([{ role: 'user', content: 'hi' }]), tools: baseTools });
        const tools = captured[0].tools as Array<Record<string, unknown>>;
        expect(tools[0].cache_control).toEqual({ type: 'ephemeral' });
        expect(tools[1].cache_control).toBeUndefined();
        expect(tools[2].cache_control).toBeUndefined();
    });
    it('breakpoint 落点：非 deferred 工具在数组末尾时，落在它身上而不是第一个 deferred 工具上', async () => {
        const { client, captured } = makeClient({ supportsDeferLoading: true });
        const tools = [
            { name: 'deferred_a', description: 'd', inputSchema: {}, deferLoading: true },
            { name: 'deferred_b', description: 'd', inputSchema: {}, deferLoading: true },
            { name: 'always_loaded', description: 'a', inputSchema: {} },
        ];
        await client.chat({ messages: canonicalFixture([{ role: 'user', content: 'hi' }]), tools });
        const sentTools = captured[0].tools as Array<Record<string, unknown>>;
        expect(sentTools[0].cache_control).toBeUndefined();
        expect(sentTools[1].cache_control).toBeUndefined();
        expect(sentTools[2].cache_control).toEqual({ type: 'ephemeral' });
    });
    it('supportsDeferLoading:false 时（等价于全部不 defer），breakpoint 落在最后一个工具（原有行为不回归）', async () => {
        const { client, captured } = makeClient({});
        await client.chat({ messages: canonicalFixture([{ role: 'user', content: 'hi' }]), tools: baseTools });
        const tools = captured[0].tools as Array<Record<string, unknown>>;
        expect(tools[tools.length - 1].cache_control).toEqual({ type: 'ephemeral' });
    });
    it('全部工具都 deferred（无一个非 deferred）时，跳过 breakpoint 而不是 400（防御分支）', async () => {
        const { client, captured } = makeClient({ supportsDeferLoading: true });
        const tools = [
            { name: 'a', description: 'a', inputSchema: {}, deferLoading: true },
            { name: 'b', description: 'b', inputSchema: {}, deferLoading: true },
        ];
        await client.chat({ messages: canonicalFixture([{ role: 'user', content: 'hi' }]), tools });
        const sentTools = captured[0].tools as Array<Record<string, unknown>>;
        for (const t of sentTools) {
            expect(t.cache_control).toBeUndefined();
            expect(t.defer_loading).toBe(true);
        }
    });
});
describe('AnthropicClient · mid-conversation tool changes beta header', () => {
    it('messages 含 role:system 且模型 supportsMidConversationTools:true → 注入 beta header', async () => {
        const { client, capturedOptions } = makeClient({ supportsMidConversationTools: true });
        await client.chat({
            messages: canonicalFixture([
                { role: 'user', content: 'hi' },
                {
                    role: 'system',
                    content: [{ type: 'tool_addition', tool: { type: 'tool_reference', name: 'deferred_a' } }],
                } as never,
            ]),
            tools: baseTools,
        });
        expect(capturedOptions[0]?.headers).toEqual({
            'anthropic-beta': 'mid-conversation-tool-changes-2026-07-01',
        });
    });
    it('messages 不含 role:system 时，即使模型支持也不注入 beta header（没用到就不加成本）', async () => {
        const { client, capturedOptions } = makeClient({ supportsMidConversationTools: true });
        await client.chat({
            messages: canonicalFixture([{ role: 'user', content: 'hi' }]),
            tools: baseTools,
        });
        expect(capturedOptions[0]?.headers).toBeUndefined();
    });
    it('falls back to a reminder when the constructor does not enable native tools', async () => {
        const { client, captured, capturedOptions } = makeClient({});
        await client.chat({ messages: [
                { type: 'event', eventType: 'message', content: 'hi', timestamp: new Date(0) },
                { type: 'system_injection', content: '', blocks: [{ type: 'tool_addition', toolName: 'deferred_a' }], timestamp: new Date(0) },
                { type: 'event', eventType: 'message', content: 'next', timestamp: new Date(0) },
            ], tools: baseTools });
        expect(capturedOptions[0]?.headers).toBeUndefined();
        expect(JSON.stringify(captured[0].messages)).toContain('<system-reminder>');
        expect(JSON.stringify(captured[0].messages)).toContain('deferred_a');
        expect(captured[0].messages.every((m: any) => m.role !== 'system')).toBe(true);
    });
});
