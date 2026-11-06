import { describe, it, expect, beforeEach } from 'vitest';
import { enqueueInput, drainPendingInputs, hasPendingInputs, pendingToAgentMessage, USER_MESSAGE_EVENT_TYPE, } from '../pending-inputs.js';
import { acquireLock } from '../lock.js';
import { COL_SESSIONS } from '../schema.js';
import { createMemoryDocStore, type MockMemoryDocStore } from './fixtures.js';
import type { PendingInput } from '../types.js';
describe('host/pending-inputs', () => {
    let store: MockMemoryDocStore;
    const sid = 'sess-1';
    beforeEach(() => {
        store = createMemoryDocStore();
    });
    describe('enqueueInput', () => {
        it('upserts the session doc on first inject', async () => {
            const r = await enqueueInput(store, {
                sessionId: sid,
                content: 'hi',
                userId: 'u1',
                userName: 'Alice',
            });
            expect(r.messageId).toBeTruthy();
            expect(r.timestamp).toBeGreaterThan(0);
            const doc = store.inspect(COL_SESSIONS, sid) as {
                pendingInputs: PendingInput[];
                createdAt?: Date;
            };
            expect(doc.pendingInputs).toHaveLength(1);
            expect(doc.pendingInputs[0].content).toBe('hi');
            expect(doc.createdAt).toBeInstanceOf(Date);
        });
        it('appends without resetting createdAt on subsequent inject', async () => {
            await enqueueInput(store, {
                sessionId: sid,
                content: 'one',
                userId: 'u1',
                userName: 'A',
            });
            const docAfter1 = store.inspect(COL_SESSIONS, sid) as {
                createdAt: Date;
            };
            const firstCreated = docAfter1.createdAt.getTime();
            await new Promise((r) => setTimeout(r, 5));
            await enqueueInput(store, {
                sessionId: sid,
                content: 'two',
                userId: 'u1',
                userName: 'A',
            });
            const docAfter2 = store.inspect(COL_SESSIONS, sid) as {
                pendingInputs: PendingInput[];
                createdAt: Date;
            };
            expect(docAfter2.pendingInputs).toHaveLength(2);
            expect(docAfter2.createdAt.getTime()).toBe(firstCreated);
        });
        it('atomically advances inputGeneration and resets retry state on every real inbound', async () => {
            store.seed(COL_SESSIONS, {
                _id: sid,
                pendingInputs: [],
                inputGeneration: 7,
                autoRetryAttempt: 2,
                runtimeWakeRequestedAt: new Date(),
                runtimeWakeSessionFilter: { inputGeneration: 7 },
                runtimeWakeRequestId: 'old-wake',
            });
            await enqueueInput(store, {
                sessionId: sid,
                content: 'new interaction',
                userId: 'u1',
                userName: 'A',
            });
            const doc = store.inspect(COL_SESSIONS, sid) as Record<string, unknown>;
            expect(doc.inputGeneration).toBe(8);
            expect(doc.autoRetryAttempt).toBe(0);
            expect(doc.runtimeWakeRequestedAt).toBeUndefined();
            expect(doc.runtimeWakeSessionFilter).toBeUndefined();
            expect(doc.runtimeWakeRequestId).toBeUndefined();
        });
        it('honors caller-supplied messageId', async () => {
            const r = await enqueueInput(store, {
                sessionId: sid,
                content: 'x',
                userId: 'u1',
                userName: 'A',
                messageId: 'msg-fixed-id',
            });
            expect(r.messageId).toBe('msg-fixed-id');
        });
        it('passes eventType through to PendingInput', async () => {
            await enqueueInput(store, {
                sessionId: sid,
                content: 'sys',
                userId: 'system',
                userName: 'System',
                eventType: 'cron_reminder',
            });
            const doc = store.inspect(COL_SESSIONS, sid) as {
                pendingInputs: PendingInput[];
            };
            expect(doc.pendingInputs[0].eventType).toBe('cron_reminder');
        });
    });
    describe('drainPendingInputs', () => {
        beforeEach(async () => {
            await enqueueInput(store, {
                sessionId: sid,
                content: 'a',
                userId: 'u1',
                userName: 'A',
            });
            await enqueueInput(store, {
                sessionId: sid,
                content: 'b',
                userId: 'u1',
                userName: 'A',
            });
            await acquireLock(store, { sessionId: sid, holder: 'h1', turnId: 't1', ttlMs: 60000 });
        });
        it('returns prior queue and clears it (returnDocument=before)', async () => {
            const drained = await drainPendingInputs(store, { sessionId: sid, holder: 'h1' });
            expect(drained).toHaveLength(2);
            expect(drained.map((p) => p.content)).toEqual(['a', 'b']);
            const doc = store.inspect(COL_SESSIONS, sid) as {
                pendingInputs: PendingInput[];
            };
            expect(doc.pendingInputs).toEqual([]);
        });
        it('returns [] for non-holder (lock lost / wrong holder)', async () => {
            const drained = await drainPendingInputs(store, { sessionId: sid, holder: 'h2' });
            expect(drained).toEqual([]);
            const doc = store.inspect(COL_SESSIONS, sid) as {
                pendingInputs: PendingInput[];
            };
            expect(doc.pendingInputs).toHaveLength(2);
        });
        it('parallel drain by two holders — only the actual holder gets the batch', async () => {
            const [a, b] = await Promise.all([
                drainPendingInputs(store, { sessionId: sid, holder: 'h1' }),
                drainPendingInputs(store, { sessionId: sid, holder: 'h2' }),
            ]);
            expect(a.length + b.length).toBe(2);
            expect(b).toEqual([]);
            expect(a).toHaveLength(2);
        });
    });
    describe('hasPendingInputs', () => {
        it('returns false when queue is empty', async () => {
            store.seed(COL_SESSIONS, { _id: sid, pendingInputs: [] });
            expect(await hasPendingInputs(store, sid)).toBe(false);
        });
        it('returns false when doc does not exist', async () => {
            expect(await hasPendingInputs(store, 'never-was')).toBe(false);
        });
        it('returns true when queue is non-empty', async () => {
            await enqueueInput(store, {
                sessionId: sid,
                content: 'x',
                userId: 'u',
                userName: 'A',
            });
            expect(await hasPendingInputs(store, sid)).toBe(true);
        });
    });
    describe('pendingToAgentMessage', () => {
        it('emits event message with default eventType=user_message', () => {
            const p: PendingInput = {
                id: 'm1',
                content: 'hi',
                userId: 'u1',
                userName: 'Alice',
                timestamp: 1700000000000,
            };
            const msg = pendingToAgentMessage(p);
            expect(msg.type).toBe('event');
            expect((msg as {
                eventType: string;
            }).eventType).toBe(USER_MESSAGE_EVENT_TYPE);
            expect((msg as {
                content: string;
            }).content).toBe('hi');
            const meta = (msg as {
                meta: Record<string, unknown>;
            }).meta;
            expect(meta.messageId).toBe('m1');
            expect(meta.userId).toBe('u1');
            expect(meta.userName).toBe('Alice');
        });
        it('honors PendingInput.eventType override', () => {
            const p: PendingInput = {
                id: 'm1',
                content: '到点吃药',
                userId: 'system',
                userName: 'System',
                eventType: 'cron_reminder',
            };
            const msg = pendingToAgentMessage(p);
            expect((msg as {
                eventType: string;
            }).eventType).toBe('cron_reminder');
        });
        it('flows optional sender + custom metadata into meta', () => {
            const p: PendingInput = {
                id: 'm1',
                content: 'with attach',
                userId: 'u1',
                userName: 'A',
                avatarUrl: 'https://x/a.png',
                bio: 'hi',
                eventSource: 'juzi',
                attachments: [{ kind: 'voice', url: 'x' }],
                metadata: { anchor: 'morning' },
            };
            const msg = pendingToAgentMessage(p);
            const meta = (msg as {
                meta: Record<string, unknown>;
            }).meta;
            expect(meta.avatarUrl).toBe('https://x/a.png');
            expect(meta.bio).toBe('hi');
            expect(meta.eventSource).toBe('juzi');
            expect(meta.attachments).toBeDefined();
            expect(meta.anchor).toBe('morning');
        });
        it('stamps current Date when timestamp omitted', () => {
            const p: PendingInput = {
                id: 'm1',
                content: 'x',
                userId: 'u',
                userName: 'A',
            };
            const msg = pendingToAgentMessage(p);
            expect((msg as {
                timestamp: Date;
            }).timestamp).toBeInstanceOf(Date);
        });
    });
});
