import { describe, it, expect } from 'vitest';
import { validateSystemInjectionPlacement, type AgentMessage, type SystemInjectionMessage } from '../index.js';
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
describe('validateSystemInjectionPlacement', () => {
    it('rejects being the first message in a session', () => {
        const result = validateSystemInjectionPlacement([]);
        expect(result.ok).toBe(false);
        expect(result.error).toBe('first_message');
    });
    it('rejects when tail is an assistant message', () => {
        const messages: AgentMessage[] = [
            { type: 'event', eventType: 'message.received', content: 'hi', timestamp: new Date() },
            { type: 'assistant', content: 'hello', timestamp: new Date() },
        ];
        const result = validateSystemInjectionPlacement(messages);
        expect(result.ok).toBe(false);
        expect(result.error).toBe('not_after_user_or_tool_result');
    });
    it('rejects when tail is another system_injection message', () => {
        const messages: AgentMessage[] = [
            { type: 'event', eventType: 'message.received', content: 'hi', timestamp: new Date() },
            reminderMsg('first reminder'),
        ];
        const result = validateSystemInjectionPlacement(messages);
        expect(result.ok).toBe(false);
        expect(result.error).toBe('not_after_user_or_tool_result');
    });
    it('accepts when tail is an event (user) message', () => {
        const messages: AgentMessage[] = [
            { type: 'event', eventType: 'message.received', content: 'hi', timestamp: new Date() },
        ];
        expect(validateSystemInjectionPlacement(messages).ok).toBe(true);
    });
    it('accepts when tail is a tool result message', () => {
        const messages: AgentMessage[] = [
            { type: 'event', eventType: 'message.received', content: 'hi', timestamp: new Date() },
            { type: 'assistant', content: null, toolCalls: [{ id: 'tc1', name: 'x', arguments: '{}' }], timestamp: new Date() },
            { type: 'tool', toolCallId: 'tc1', content: 'result', timestamp: new Date() },
        ];
        expect(validateSystemInjectionPlacement(messages).ok).toBe(true);
    });
    it('rejects mid-batch: tail is a tool result but a sibling tool_use from the same assistant batch is still unresolved', () => {
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
        ];
        const result = validateSystemInjectionPlacement(messages);
        expect(result.ok).toBe(false);
        expect(result.error).toBe('mid_batch_tool_result');
        expect(result.message).toContain('tc_B');
    });
    it('accepts once every sibling in the batch has closed (tc_B also landed)', () => {
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
            { type: 'tool', toolCallId: 'tc_B', content: 'result B', timestamp: new Date() },
        ];
        expect(validateSystemInjectionPlacement(messages).ok).toBe(true);
    });
    it('rejects mid-batch even when the OTHER sibling (tc_B) lands first and tc_A is still open', () => {
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
            { type: 'tool', toolCallId: 'tc_B', content: 'result B', timestamp: new Date() },
        ];
        const result = validateSystemInjectionPlacement(messages);
        expect(result.ok).toBe(false);
        expect(result.error).toBe('mid_batch_tool_result');
        expect(result.message).toContain('tc_A');
    });
    it('rejects mid-batch across a 3-way parallel batch with 2 landed / 1 pending', () => {
        const messages: AgentMessage[] = [
            { type: 'event', eventType: 'message.received', content: 'hi', timestamp: new Date() },
            {
                type: 'assistant',
                content: null,
                toolCalls: [
                    { id: 'tc_A', name: 'a', arguments: '{}' },
                    { id: 'tc_B', name: 'b', arguments: '{}' },
                    { id: 'tc_C', name: 'c', arguments: '{}' },
                ],
                timestamp: new Date(),
            },
            { type: 'tool', toolCallId: 'tc_A', content: 'result A', timestamp: new Date() },
            { type: 'tool', toolCallId: 'tc_B', content: 'result B', timestamp: new Date() },
        ];
        const result = validateSystemInjectionPlacement(messages);
        expect(result.ok).toBe(false);
        expect(result.error).toBe('mid_batch_tool_result');
    });
    it('a PRIOR fully-closed batch does not block validation of a later independent tool result', () => {
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
            { type: 'tool', toolCallId: 'tc_B', content: 'result B', timestamp: new Date() },
            { type: 'event', eventType: 'message.received', content: '继续', timestamp: new Date() },
            { type: 'assistant', content: null, toolCalls: [{ id: 'tc_C', name: 'c', arguments: '{}' }], timestamp: new Date() },
            { type: 'tool', toolCallId: 'tc_C', content: 'result C', timestamp: new Date() },
        ];
        expect(validateSystemInjectionPlacement(messages).ok).toBe(true);
    });
});
