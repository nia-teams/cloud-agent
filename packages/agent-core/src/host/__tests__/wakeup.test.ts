import { describe, expect, it, beforeEach } from 'vitest';
import { findOrphanSlicePoint, isSessionSettled, shouldRunTurn, } from '../wakeup.js';
import { enqueueInput } from '../pending-inputs.js';
import { COL_SESSIONS } from '../schema.js';
import { createMemoryDocStore, type MockMemoryDocStore } from './fixtures.js';
import type { AgentMessage } from '../../types.js';
const sid = 'sess-wakeup';
describe('host/wakeup · isSessionSettled', () => {
    it('returns true only when tail is a toolless assistant AND no pending', () => {
        const tail: AgentMessage = {
            type: 'assistant',
            content: 'done',
            toolCalls: undefined,
            timestamp: new Date(),
        };
        expect(isSessionSettled(tail, false)).toBe(true);
    });
    it('returns false when pendingInputs is non-empty even with toolless assistant tail', () => {
        const tail: AgentMessage = {
            type: 'assistant',
            content: 'done',
            timestamp: new Date(),
        };
        expect(isSessionSettled(tail, true)).toBe(false);
    });
    it('returns false when tail = assistant + toolCalls (tool exec pending)', () => {
        const tail: AgentMessage = {
            type: 'assistant',
            content: null,
            toolCalls: [
                { id: 'tc-1', name: 'shell', arguments: '{}' },
            ],
            timestamp: new Date(),
        };
        expect(isSessionSettled(tail, false)).toBe(false);
    });
    it('returns false when tail = tool (result back, model should react)', () => {
        const tail: AgentMessage = {
            type: 'tool',
            toolCallId: 'tc-1',
            content: 'output',
            timestamp: new Date(),
        };
        expect(isSessionSettled(tail, false)).toBe(false);
    });
    it('returns false when tail = event (user message just drained, awaiting reply)', () => {
        const tail: AgentMessage = {
            type: 'event',
            eventType: 'user_message',
            content: 'hi',
            timestamp: new Date(),
            meta: {},
        };
        expect(isSessionSettled(tail, false)).toBe(false);
    });
    it('returns false when tail is undefined (empty session) AND no pending', () => {
        expect(isSessionSettled(undefined, false)).toBe(true);
    });
    it('returns false when tail is undefined BUT pending injected', () => {
        expect(isSessionSettled(undefined, true)).toBe(false);
    });
    it('returns false when tail = user', () => {
        const tail: AgentMessage = {
            type: 'user',
            content: 'hi',
            timestamp: new Date(),
        } as unknown as AgentMessage;
        expect(isSessionSettled(tail, false)).toBe(false);
    });
});
describe('host/wakeup · shouldRunTurn (integrates pending + tail)', () => {
    let store: MockMemoryDocStore;
    beforeEach(() => {
        store = createMemoryDocStore();
    });
    it('returns true when pendingInputs is non-empty (skips tail probe)', async () => {
        await enqueueInput(store, {
            sessionId: sid,
            content: 'hi',
            userId: 'u1',
            userName: 'Alice',
        });
        expect(await shouldRunTurn(store, sid)).toBe(true);
    });
    it('returns false when session has no doc at all AND no pending (no work)', async () => {
        expect(await shouldRunTurn(store, sid)).toBe(false);
    });
    it('returns true when tail is assistant + toolCalls', async () => {
        const tail: AgentMessage = {
            type: 'assistant',
            content: null,
            toolCalls: [{ id: 'tc-1', name: 'shell', arguments: '{}' }],
            timestamp: new Date(),
        };
        await store.updateOne(COL_SESSIONS, { _id: sid }, { $set: { messages: [tail] } }, { upsert: true });
        expect(await shouldRunTurn(store, sid)).toBe(true);
    });
    it('returns true when tail is tool', async () => {
        const messages: AgentMessage[] = [
            {
                type: 'assistant',
                content: null,
                toolCalls: [{ id: 'tc-1', name: 'shell', arguments: '{}' }],
                timestamp: new Date(),
            },
            {
                type: 'tool',
                toolCallId: 'tc-1',
                content: 'output',
                timestamp: new Date(),
            },
        ];
        await store.updateOne(COL_SESSIONS, { _id: sid }, { $set: { messages } }, { upsert: true });
        expect(await shouldRunTurn(store, sid)).toBe(true);
    });
    it('returns false when tail is toolless assistant AND no pending', async () => {
        const messages: AgentMessage[] = [
            {
                type: 'event',
                eventType: 'user_message',
                content: 'hi',
                timestamp: new Date(),
                meta: {},
            },
            {
                type: 'assistant',
                content: 'hello back',
                timestamp: new Date(),
            },
        ];
        await store.updateOne(COL_SESSIONS, { _id: sid }, { $set: { messages } }, { upsert: true });
        expect(await shouldRunTurn(store, sid)).toBe(false);
    });
    it('returns true when tail is toolless assistant BUT pending injected mid-flight', async () => {
        const messages: AgentMessage[] = [
            {
                type: 'assistant',
                content: 'hello',
                timestamp: new Date(),
            },
        ];
        await store.updateOne(COL_SESSIONS, { _id: sid }, { $set: { messages } }, { upsert: true });
        await enqueueInput(store, {
            sessionId: sid,
            content: 'follow-up',
            userId: 'u1',
            userName: 'Alice',
        });
        expect(await shouldRunTurn(store, sid)).toBe(true);
    });
});
describe('host/wakeup · findOrphanSlicePoint', () => {
    it('returns -1 for clean turn-pair', () => {
        const msgs: AgentMessage[] = [
            {
                type: 'event',
                eventType: 'user_message',
                content: 'hi',
                timestamp: new Date(),
                meta: {},
            },
            {
                type: 'assistant',
                content: 'ack',
                toolCalls: [{ id: 'tc-1', name: 'shell', arguments: '{}' }],
                timestamp: new Date(),
            },
            { type: 'tool', toolCallId: 'tc-1', content: 'out', timestamp: new Date() },
            { type: 'assistant', content: 'done', timestamp: new Date() },
        ];
        expect(findOrphanSlicePoint(msgs)).toBe(-1);
    });
    it('returns -1 when last assistant has no toolCalls (turn closed)', () => {
        const msgs: AgentMessage[] = [
            { type: 'assistant', content: 'final', timestamp: new Date() },
        ];
        expect(findOrphanSlicePoint(msgs)).toBe(-1);
    });
    it('detects trailing orphan: assistant + toolCalls but no following tool result', () => {
        const msgs: AgentMessage[] = [
            { type: 'assistant', content: 'previous', timestamp: new Date() },
            {
                type: 'assistant',
                content: null,
                toolCalls: [{ id: 'tc-orphan', name: 'shell', arguments: '{}' }],
                timestamp: new Date(),
            },
        ];
        expect(findOrphanSlicePoint(msgs)).toBe(1);
    });
    it('detects mid-history orphan: assistant.toolCalls not consumed before next assistant', () => {
        const msgs: AgentMessage[] = [
            {
                type: 'assistant',
                content: null,
                toolCalls: [{ id: 'tc-orphan', name: 'shell', arguments: '{}' }],
                timestamp: new Date(),
            },
            { type: 'assistant', content: 'oops', timestamp: new Date() },
        ];
        expect(findOrphanSlicePoint(msgs)).toBe(0);
    });
    it('detects partial-coverage orphan: 2 toolCalls declared, only 1 consumed', () => {
        const msgs: AgentMessage[] = [
            {
                type: 'assistant',
                content: null,
                toolCalls: [
                    { id: 'tc-a', name: 'shell', arguments: '{}' },
                    { id: 'tc-b', name: 'shell', arguments: '{}' },
                ],
                timestamp: new Date(),
            },
            { type: 'tool', toolCallId: 'tc-a', content: 'out', timestamp: new Date() },
            { type: 'assistant', content: 'wat', timestamp: new Date() },
        ];
        expect(findOrphanSlicePoint(msgs)).toBe(0);
    });
    it('event between assistant and tool result is fine', () => {
        const msgs: AgentMessage[] = [
            {
                type: 'assistant',
                content: null,
                toolCalls: [{ id: 'tc-1', name: 'shell', arguments: '{}' }],
                timestamp: new Date(),
            },
            {
                type: 'event',
                eventType: 'user_message',
                content: 'btw',
                timestamp: new Date(),
                meta: {},
            },
            { type: 'tool', toolCallId: 'tc-1', content: 'out', timestamp: new Date() },
            { type: 'assistant', content: 'done', timestamp: new Date() },
        ];
        expect(findOrphanSlicePoint(msgs)).toBe(-1);
    });
    it('empty array returns -1', () => {
        expect(findOrphanSlicePoint([])).toBe(-1);
    });
    it('detects reverse orphan: tool_result with no matching tool_use in preceding assistant', () => {
        const msgs: AgentMessage[] = [
            {
                type: 'assistant',
                content: 'plain',
                timestamp: new Date(),
            },
            {
                type: 'tool',
                toolCallId: 'tc-orphan',
                content: 'out',
                timestamp: new Date(),
            },
        ];
        expect(findOrphanSlicePoint(msgs)).toBe(0);
    });
    it('detects reverse orphan: tool_use_id mismatches assistant declared ids', () => {
        const msgs: AgentMessage[] = [
            {
                type: 'assistant',
                content: null,
                toolCalls: [{ id: 'tc-real', name: 'shell', arguments: '{}' }],
                timestamp: new Date(),
            },
            {
                type: 'tool',
                toolCallId: 'tc-different',
                content: 'out',
                timestamp: new Date(),
            },
        ];
        expect(findOrphanSlicePoint(msgs)).toBe(0);
    });
    it('detects reverse orphan with no preceding assistant: slice at the tool itself', () => {
        const msgs: AgentMessage[] = [
            {
                type: 'event',
                eventType: 'user_message',
                content: 'hi',
                timestamp: new Date(),
                meta: {},
            },
            {
                type: 'tool',
                toolCallId: 'tc-orphan',
                content: 'out',
                timestamp: new Date(),
            },
        ];
        expect(findOrphanSlicePoint(msgs)).toBe(1);
    });
});
describe('non-destructive orphan repair', () => {
    it('does not replay inputs across a complete turn after an earlier orphan', async () => {
        const { sanitizeOrphanToolCalls } = await import('../wakeup.js');
        const event = (content: string): AgentMessage => ({ type: 'event', eventType: 'user_message', content, timestamp: new Date() });
        const prefix = event('original');
        const trailing = event('new unhandled input');
        const messages: AgentMessage[] = [prefix, {
                type: 'assistant', content: null, toolCalls: [{ id: 'orphan', name: 'tool', arguments: '{}' }], timestamp: new Date(),
            }, event('already handled input'), {
                type: 'system_injection', kind: 'reminder', content: 'already handled context', timestamp: new Date(),
            }, {
                type: 'assistant', content: null, toolCalls: [{ id: 'complete', name: 'tool', arguments: '{}' }], timestamp: new Date(),
            }, {
                type: 'tool', toolCallId: 'complete', content: 'done', timestamp: new Date(),
            }, trailing];
        expect(findOrphanSlicePoint(messages)).toBe(1);
        expect(sanitizeOrphanToolCalls(messages)).toEqual([prefix, trailing]);
        expect(messages).toHaveLength(7);
    });
    it('preserves later events and system injections in order', async () => {
        const { sanitizeOrphanToolCalls } = await import('../wakeup.js');
        const prefix: AgentMessage = { type: 'event', eventType: 'user_message', content: 'first', timestamp: new Date() };
        const later: AgentMessage = { ...prefix, content: 'later input' };
        const injection: AgentMessage = { type: 'system_injection', kind: 'reminder', content: 'host input', timestamp: new Date() };
        const messages: AgentMessage[] = [prefix, {
                type: 'assistant', content: null, toolCalls: [{ id: 'orphan', name: 'tool', arguments: '{}' }], timestamp: new Date(),
            }, later, injection];
        expect(sanitizeOrphanToolCalls(messages)).toEqual([prefix, later, injection]);
        expect(messages).toHaveLength(4);
    });
});
