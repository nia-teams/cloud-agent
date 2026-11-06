import { describe, it, expect } from 'vitest';
import { buildTurnStart, buildToolCallEnd, buildToolInputDelta, buildUserMessage, buildSessionUpdate, buildMessageRevoked, } from '../event-builders.js';
describe('event builders', () => {
    it('buildTurnStart fills timestamp and preserves headers', () => {
        const ev = buildTurnStart({ sessionId: 's1', turnId: 't1' });
        expect(ev.type).toBe('turn_start');
        expect(ev.sessionId).toBe('s1');
        expect(ev.turnId).toBe('t1');
        expect(typeof ev.timestamp).toBe('number');
        expect(ev.timestamp).toBeGreaterThan(0);
    });
    it('buildToolCallEnd carries durationMs + output + error', () => {
        const ev = buildToolCallEnd({
            sessionId: 's1',
            turnId: 't1',
            toolCallId: 'tc1',
            durationMs: 42,
            output: 'ok',
        });
        expect(ev.type).toBe('tool_call_end');
        expect(ev.toolCallId).toBe('tc1');
        expect(ev.durationMs).toBe(42);
        expect(ev.output).toBe('ok');
        expect(ev.error).toBeUndefined();
    });
    it('buildToolInputDelta passes partial_json through', () => {
        const ev = buildToolInputDelta({
            sessionId: 's1',
            turnId: 't1',
            toolCallId: 'tc1',
            partial_json: '{"k":"v',
        });
        expect(ev.type).toBe('tool_input_delta');
        expect(ev.partial_json).toBe('{"k":"v');
    });
    it('buildUserMessage requires userName + messageId + content', () => {
        const ev = buildUserMessage({
            sessionId: 's1',
            userId: 'u1',
            userName: 'Alice',
            messageId: 'm1',
            content: 'hello',
        });
        expect(ev.type).toBe('user_message');
        expect(ev.userId).toBe('u1');
        expect(ev.userName).toBe('Alice');
        expect(ev.messageId).toBe('m1');
        expect(ev.content).toBe('hello');
    });
    it('buildSessionUpdate forwards lastMessage / running / backgroundTaskCount / lastError', () => {
        const ev = buildSessionUpdate({
            sessionId: 's1',
            title: 'New title',
            running: true,
            backgroundTaskCount: 2,
            lastError: null,
            lastMessage: 'preview',
            lastMessageUser: 'Alice',
        });
        expect(ev.type).toBe('session_update');
        expect(ev.title).toBe('New title');
        expect(ev.running).toBe(true);
        expect(ev.backgroundTaskCount).toBe(2);
        expect(ev.lastError).toBeNull();
        expect(ev.lastMessage).toBe('preview');
    });
    it('buildSessionUpdate preserves an explicit zero background task count', () => {
        const ev = buildSessionUpdate({ sessionId: 's1', backgroundTaskCount: 0 });
        expect(Object.hasOwn(ev, 'backgroundTaskCount')).toBe(true);
        expect(ev.backgroundTaskCount).toBe(0);
    });
    it('buildMessageRevoked carries revokedBy', () => {
        const ev = buildMessageRevoked({
            sessionId: 's1',
            messageId: 'm1',
            revokedBy: 'u1',
        });
        expect(ev.type).toBe('message_revoked');
        expect(ev.messageId).toBe('m1');
        expect(ev.revokedBy).toBe('u1');
    });
    it('honors caller-provided timestamp', () => {
        const ev = buildTurnStart({ sessionId: 's', turnId: 't', timestamp: 12345 });
        expect(ev.timestamp).toBe(12345);
    });
});
