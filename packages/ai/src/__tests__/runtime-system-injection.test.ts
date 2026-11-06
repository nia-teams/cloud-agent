import { describe, it, expect } from 'vitest';
import { AnthropicAdapter, OpenAIAdapter, GeminiAdapter, renderSystemInjectionFallbackText, mergeSystemInjectionsIntoFollowingMessage, } from '../adapters/index.js';
import type { AgentMessage, SystemInjectionMessage } from '@nia-teams/ai/protocol';
function toolActivationMsg(toolName: string): SystemInjectionMessage {
    return {
        type: 'system_injection',
        kind: 'tool_activation',
        blocks: [{ type: 'tool_addition', toolName }],
        timestamp: new Date(),
    };
}
function reminderMsg(content: string): SystemInjectionMessage {
    return {
        type: 'system_injection',
        kind: 'reminder',
        content,
        timestamp: new Date(),
    };
}
const baseLog: AgentMessage[] = [
    { type: 'event', eventType: 'message.received', content: '帮我查一下张伟的联系方式', timestamp: new Date() },
];
describe('AnthropicAdapter · SystemInjectionMessage', () => {
    it('native rendering when supportsMidConversationTools=true: standalone role:system entry with tool_addition block', () => {
        const log = [...baseLog, toolActivationMsg('search_crm_contacts')];
        const out = new AnthropicAdapter().fromStorage(log, '', 'claude-opus-5', {
            supportsMidConversationTools: true,
        }) as Array<{
            role: string;
            content: unknown;
        }>;
        const systemEntries = out.filter((m) => m.role === 'system');
        expect(systemEntries.length).toBe(1);
        const blocks = systemEntries[0].content as Array<Record<string, unknown>>;
        expect(blocks[0]).toEqual({
            type: 'tool_addition',
            tool: { type: 'tool_reference', name: 'search_crm_contacts' },
        });
        expect(out[out.length - 1].role).toBe('system');
    });
    it('native rendering: text-kind reminder becomes a text content block under role:system', () => {
        const log = [...baseLog, reminderMsg('会话已被 routine 调度触发，请继续未完成的任务。')];
        const out = new AnthropicAdapter().fromStorage(log, '', 'claude-opus-5', {
            supportsMidConversationTools: true,
        }) as Array<{
            role: string;
            content: Array<Record<string, unknown>>;
        }>;
        const sys = out.find((m) => m.role === 'system')!;
        expect(sys.content[0]).toEqual({ type: 'text', text: '会话已被 routine 调度触发，请继续未完成的任务。' });
    });
    it('degraded fallback when capabilities omitted: no role:system on the wire, reminder merged into next event text', () => {
        const log: AgentMessage[] = [
            ...baseLog,
            toolActivationMsg('search_crm_contacts'),
            { type: 'event', eventType: 'message.received', content: '继续', timestamp: new Date() },
        ];
        const out = new AnthropicAdapter().fromStorage(log, '', 'claude-sonnet-5') as Array<{
            role: string;
            content: string | Array<Record<string, unknown>>;
        }>;
        expect(out.some((m) => m.role === 'system')).toBe(false);
        const userEntries = out.filter((m) => m.role === 'user');
        expect(userEntries.length).toBe(1);
        const flat = JSON.stringify(userEntries[0].content);
        expect(flat).toContain('<system-reminder>');
        expect(flat).toContain('search_crm_contacts');
    });
    it('degraded fallback when supportsMidConversationTools=false explicitly: same as omitted', () => {
        const log = [...baseLog, reminderMsg('提醒内容')];
        const out = new AnthropicAdapter().fromStorage(log, '', 'claude-sonnet-5', {
            supportsMidConversationTools: false,
        }) as Array<{
            role: string;
            content: string | Array<Record<string, unknown>>;
        }>;
        expect(out.some((m) => m.role === 'system')).toBe(false);
    });
});
describe('OpenAIAdapter / GeminiAdapter · SystemInjectionMessage always degrades', () => {
    it('OpenAIAdapter: merges into the head of the next user/event message as <system-reminder>', () => {
        const log: AgentMessage[] = [
            ...baseLog,
            toolActivationMsg('search_crm_contacts'),
            { type: 'event', eventType: 'message.received', content: '继续', timestamp: new Date() },
        ];
        const out = new OpenAIAdapter().fromStorage(log, '') as Array<{
            role: string;
            content: string | null;
        }>;
        expect(out.some((m) => m.role === 'system')).toBe(false);
        const lastUser = out.filter((m) => m.role === 'user').slice(-1)[0];
        expect(lastUser.content).toContain('<system-reminder>');
        expect(lastUser.content).toContain('search_crm_contacts');
        expect(lastUser.content?.endsWith('继续')).toBe(true);
    });
    it('GeminiAdapter: merges into the head of the next user/event content parts', () => {
        const log: AgentMessage[] = [
            ...baseLog,
            reminderMsg('这是一条平台提醒'),
            { type: 'event', eventType: 'message.received', content: '继续', timestamp: new Date() },
        ];
        const out = new GeminiAdapter().fromStorage(log, '') as Array<{
            role: string;
            parts: Array<{
                text?: string;
            }>;
        }>;
        const userParts = out.filter((m) => m.role === 'user');
        const flat = userParts.map((m) => m.parts.map((p) => p.text).join('')).join('\n');
        expect(flat).toContain('<system-reminder>');
        expect(flat).toContain('这是一条平台提醒');
    });
    it('trailing system_injection with nothing after it becomes a standalone fallback message rather than being dropped', () => {
        const log: AgentMessage[] = [...baseLog, reminderMsg('末尾提醒，没有后续消息')];
        const out = new OpenAIAdapter().fromStorage(log, '') as Array<{
            role: string;
            content: string | null;
        }>;
        const last = out[out.length - 1];
        expect(last.role).toBe('user');
        expect(last.content).toContain('末尾提醒，没有后续消息');
    });
});
describe('renderSystemInjectionFallbackText', () => {
    it('tool_removal block renders a directive sentence', () => {
        const msg: SystemInjectionMessage = {
            type: 'system_injection',
            kind: 'tool_activation',
            blocks: [{ type: 'tool_removal', toolName: 'legacy_tool' }],
            timestamp: new Date(),
        };
        const text = renderSystemInjectionFallbackText(msg);
        expect(text).toContain('<system-reminder>');
        expect(text).toContain('legacy_tool');
        expect(text).toContain('is no longer available');
    });
});
describe('mergeSystemInjectionsIntoFollowingMessage · batch-integrity defense', () => {
    it('skips past an unclosed parallel batch: injection queued right after tc_A lands after tc_B closes, not between them', () => {
        const messages: AgentMessage[] = [
            { type: 'event', eventType: 'message.received', content: '帮我查一下 gitlab 上的 MR 状态并同时看看 CI', timestamp: new Date() },
            {
                type: 'assistant',
                content: null,
                toolCalls: [
                    { id: 'tc_A', name: 'gitlab_mr_status', arguments: '{}' },
                    { id: 'tc_B', name: 'gitlab_ci_status', arguments: '{}' },
                ],
                timestamp: new Date(),
            },
            { type: 'tool', toolCallId: 'tc_A', content: 'result A', timestamp: new Date() },
            toolActivationMsg('gitlab'),
            { type: 'tool', toolCallId: 'tc_B', content: 'result B', timestamp: new Date() },
            { type: 'event', eventType: 'message.received', content: '继续', timestamp: new Date() },
        ];
        const flattened = mergeSystemInjectionsIntoFollowingMessage(messages);
        expect(flattened.every((m) => m.type !== 'system_injection')).toBe(true);
        const idxA = flattened.findIndex((m) => m.type === 'tool' && m.toolCallId === 'tc_A');
        const idxB = flattened.findIndex((m) => m.type === 'tool' && m.toolCallId === 'tc_B');
        expect(idxB).toBe(idxA + 1);
        const nextEvent = flattened[idxB + 1];
        expect(nextEvent.type).toBe('event');
        expect((nextEvent as {
            content: string;
        }).content).toContain('<system-reminder>');
        expect((nextEvent as {
            content: string;
        }).content).toContain('gitlab');
        expect((nextEvent as {
            content: string;
        }).content.endsWith('继续')).toBe(true);
    });
    it('adapter-level repro: AnthropicAdapter degraded rendering never puts a text block between the two tool_result blocks of the same batch', () => {
        const messages: AgentMessage[] = [
            { type: 'event', eventType: 'message.received', content: '帮我查一下 gitlab 上的 MR 状态并同时看看 CI', timestamp: new Date() },
            {
                type: 'assistant',
                content: null,
                toolCalls: [
                    { id: 'tc_A', name: 'gitlab_mr_status', arguments: '{}' },
                    { id: 'tc_B', name: 'gitlab_ci_status', arguments: '{}' },
                ],
                timestamp: new Date(),
            },
            { type: 'tool', toolCallId: 'tc_A', content: 'result A', timestamp: new Date() },
            toolActivationMsg('gitlab'),
            { type: 'tool', toolCallId: 'tc_B', content: 'result B', timestamp: new Date() },
            { type: 'event', eventType: 'message.received', content: '继续', timestamp: new Date() },
        ];
        const out = new AnthropicAdapter().fromStorage(messages, '', 'claude-sonnet-5') as Array<{
            role: string;
            content: string | Array<Record<string, unknown>>;
        }>;
        const merged = out.find((m) => Array.isArray(m.content) && m.content.some((b) => b.type === 'tool_result' && b.tool_use_id === 'tc_A'))!;
        const blocks = merged.content as Array<Record<string, unknown>>;
        const idxA = blocks.findIndex((b) => b.type === 'tool_result' && b.tool_use_id === 'tc_A');
        const idxB = blocks.findIndex((b) => b.type === 'tool_result' && b.tool_use_id === 'tc_B');
        expect(idxB).toBe(idxA + 1);
        const flat = JSON.stringify(out);
        expect(flat).toContain('<system-reminder>');
        expect(flat).toContain('gitlab');
    });
    it('OpenAIAdapter degraded rendering: same batch-integrity guarantee (tool messages stay adjacent)', () => {
        const messages: AgentMessage[] = [
            { type: 'event', eventType: 'message.received', content: '帮我查一下 gitlab 上的 MR 状态并同时看看 CI', timestamp: new Date() },
            {
                type: 'assistant',
                content: null,
                toolCalls: [
                    { id: 'tc_A', name: 'gitlab_mr_status', arguments: '{}' },
                    { id: 'tc_B', name: 'gitlab_ci_status', arguments: '{}' },
                ],
                timestamp: new Date(),
            },
            { type: 'tool', toolCallId: 'tc_A', content: 'result A', timestamp: new Date() },
            toolActivationMsg('gitlab'),
            { type: 'tool', toolCallId: 'tc_B', content: 'result B', timestamp: new Date() },
            { type: 'event', eventType: 'message.received', content: '继续', timestamp: new Date() },
        ];
        const out = new OpenAIAdapter().fromStorage(messages, '') as Array<{
            role: string;
            content: string | null;
            tool_call_id?: string;
        }>;
        const toolEntries = out.filter((m) => m.role === 'tool');
        expect(toolEntries.map((m) => m.tool_call_id)).toEqual(['tc_A', 'tc_B']);
        const idxA = out.findIndex((m) => m.role === 'tool' && m.tool_call_id === 'tc_A');
        const idxB = out.findIndex((m) => m.role === 'tool' && m.tool_call_id === 'tc_B');
        expect(idxB).toBe(idxA + 1);
        const lastUser = out.filter((m) => m.role === 'user').slice(-1)[0];
        expect(lastUser.content).toContain('<system-reminder>');
        expect(lastUser.content).toContain('gitlab');
    });
    it('GeminiAdapter degraded rendering: same batch-integrity guarantee (functionResponse parts stay adjacent)', () => {
        const messages: AgentMessage[] = [
            { type: 'event', eventType: 'message.received', content: '帮我查一下 gitlab 上的 MR 状态并同时看看 CI', timestamp: new Date() },
            {
                type: 'assistant',
                content: null,
                toolCalls: [
                    { id: 'tc_A', name: 'gitlab_mr_status', arguments: '{}' },
                    { id: 'tc_B', name: 'gitlab_ci_status', arguments: '{}' },
                ],
                timestamp: new Date(),
            },
            { type: 'tool', toolCallId: 'tc_A', content: 'result A', timestamp: new Date() },
            toolActivationMsg('gitlab'),
            { type: 'tool', toolCallId: 'tc_B', content: 'result B', timestamp: new Date() },
            { type: 'event', eventType: 'message.received', content: '继续', timestamp: new Date() },
        ];
        const out = new GeminiAdapter().fromStorage(messages, '') as Array<{
            role: string;
            parts: Array<{
                text?: string;
                functionResponse?: {
                    name: string;
                };
            }>;
        }>;
        const merged = out.filter((m) => m.role === 'user');
        const allParts = merged.flatMap((m) => m.parts);
        const idxA = allParts.findIndex((p) => p.functionResponse?.name === 'gitlab_mr_status');
        const idxB = allParts.findIndex((p) => p.functionResponse?.name === 'gitlab_ci_status');
        expect(idxB).toBe(idxA + 1);
        const flat = JSON.stringify(out);
        expect(flat).toContain('<system-reminder>');
        expect(flat).toContain('gitlab');
    });
    it('carry from a mid-batch injection concatenates correctly with a LATER injection queued after batch close (order preserved)', () => {
        const messages: AgentMessage[] = [
            { type: 'event', eventType: 'message.received', content: 'hi', timestamp: new Date() },
            {
                type: 'assistant',
                content: null,
                toolCalls: [
                    { id: 'tc_A', name: 'a', arguments: '{}' },
                    { id: 'tc_B', name: 'b', arguments: '{}' },
                ],
                timestamp: new Date(),
            },
            { type: 'tool', toolCallId: 'tc_A', content: 'result A', timestamp: new Date() },
            reminderMsg('first: queued mid-batch'),
            { type: 'tool', toolCallId: 'tc_B', content: 'result B', timestamp: new Date() },
            reminderMsg('second: queued after batch closed'),
            { type: 'event', eventType: 'message.received', content: '继续', timestamp: new Date() },
        ];
        const flattened = mergeSystemInjectionsIntoFollowingMessage(messages);
        const lastEvent = flattened[flattened.length - 1] as {
            type: string;
            content: string;
        };
        expect(lastEvent.type).toBe('event');
        const firstIdx = lastEvent.content.indexOf('first: queued mid-batch');
        const secondIdx = lastEvent.content.indexOf('second: queued after batch closed');
        expect(firstIdx).toBeGreaterThanOrEqual(0);
        expect(secondIdx).toBeGreaterThan(firstIdx);
    });
});
