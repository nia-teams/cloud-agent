import { describe, it, expect, beforeEach } from 'vitest';
import { createConversationStore } from '../conversation-store.js';
import { enqueueInput } from '../pending-inputs.js';
import { acquireLock } from '../lock.js';
import { COL_SESSIONS } from '../schema.js';
import { createMemoryDocStore, type MockMemoryDocStore } from './fixtures.js';
import type { AgentMessage } from '../../types.js';
describe('host/conversation-store', () => {
    let store: MockMemoryDocStore;
    const sid = 'sess-1';
    const holder = 'h1';
    beforeEach(async () => {
        store = createMemoryDocStore();
        store.seed(COL_SESSIONS, { _id: sid, messages: [], pendingInputs: [] });
        await acquireLock(store, { sessionId: sid, holder, turnId: 't1', ttlMs: 60000 });
    });
    function makeStore(onLockLost: () => void = () => { }) {
        return createConversationStore({
            store,
            sessionId: sid,
            holder,
            renewTtlMs: 60000,
            onLockLost,
        });
    }
    describe('loadAll', () => {
        it('returns persisted messages array', async () => {
            const seedMsgs: AgentMessage[] = [
                { type: 'event', eventType: 'user_message', content: 'hi', timestamp: new Date() },
            ];
            store.seed(COL_SESSIONS, { _id: sid, messages: seedMsgs, pendingInputs: [] });
            await acquireLock(store, { sessionId: sid, holder, turnId: 't1', ttlMs: 60000 });
            const cs = makeStore();
            const all = await cs.loadAll();
            expect(all).toHaveLength(1);
        });
        it('returns [] when sessions doc has no messages field', async () => {
            store.seed(COL_SESSIONS, { _id: sid });
            await acquireLock(store, { sessionId: sid, holder, turnId: 't1', ttlMs: 60000 });
            const cs = makeStore();
            expect(await cs.loadAll()).toEqual([]);
        });
    });
    describe('fetchNew', () => {
        it('CAS-drains pendingInputs and persists batch into messages', async () => {
            await enqueueInput(store, { sessionId: sid, content: 'a', userId: 'u', userName: 'A' });
            await enqueueInput(store, { sessionId: sid, content: 'b', userId: 'u', userName: 'A' });
            const cs = makeStore();
            const drained = await cs.fetchNew();
            expect(drained).toHaveLength(2);
            expect(drained.map((m) => (m as {
                content: string;
            }).content)).toEqual(['a', 'b']);
            const doc = store.inspect(COL_SESSIONS, sid) as {
                pendingInputs: unknown[];
                messages: unknown[];
            };
            expect(doc.pendingInputs).toEqual([]);
            expect(doc.messages).toHaveLength(2);
        });
        it('returns [] without persist when queue is empty', async () => {
            const cs = makeStore();
            const drained = await cs.fetchNew();
            expect(drained).toEqual([]);
            const doc = store.inspect(COL_SESSIONS, sid) as {
                messages: unknown[];
            };
            expect(doc.messages).toEqual([]);
        });
        it('non-holder fetch fires onLockLost without changing the inbox', async () => {
            await enqueueInput(store, { sessionId: sid, content: 'a', userId: 'u', userName: 'A' });
            let lostFired = false;
            const cs = createConversationStore({
                store,
                sessionId: sid,
                holder: 'wrong-holder',
                renewTtlMs: 60000,
                onLockLost: () => {
                    lostFired = true;
                },
            });
            const drained = await cs.fetchNew();
            expect(drained).toEqual([]);
            expect(lostFired).toBe(true);
            const doc = store.inspect(COL_SESSIONS, sid) as {
                pendingInputs: unknown[];
            };
            expect(doc.pendingInputs).toHaveLength(1);
        });
        it('doc absent — fetchNew returns [] without firing onLockLost', async () => {
            let lostFired = false;
            const cs = createConversationStore({
                store,
                sessionId: 'never-was',
                holder,
                renewTtlMs: 60000,
                onLockLost: () => {
                    lostFired = true;
                },
            });
            const drained = await cs.fetchNew();
            expect(drained).toEqual([]);
            expect(lostFired).toBe(false);
        });
        it('lock loss before transfer preserves the inbox and fires onLockLost', async () => {
            await enqueueInput(store, { sessionId: sid, content: 'a', userId: 'u', userName: 'A' });
            let lostFired = false;
            const original = store.updateOne.bind(store);
            let stolen = false;
            store.updateOne = async (collection, filter, update, options) => {
                if (!stolen && update.$push && 'messages' in (update.$push as object)) {
                    stolen = true;
                    await original(COL_SESSIONS, { _id: sid }, { $set: { 'activeRun.holder': 'peer' } });
                }
                return original(collection, filter, update, options);
            };
            expect(await makeStore(() => { lostFired = true; }).fetchNew()).toEqual([]);
            expect(lostFired).toBe(true);
            expect(store.inspect(COL_SESSIONS, sid)).toMatchObject({ pendingInputs: [{ content: 'a' }], messages: [] });
        });
        it('retries a concurrent enqueue without clearing the newly arrived input', async () => {
            await enqueueInput(store, { sessionId: sid, content: 'a', userId: 'u', userName: 'A' });
            const original = store.updateOne.bind(store);
            let raced = false;
            store.updateOne = async (collection, filter, update, options) => {
                if (!raced && update.$push && 'messages' in (update.$push as object)) {
                    raced = true;
                    await enqueueInput(store, { sessionId: sid, content: 'b', userId: 'u', userName: 'A' });
                }
                return original(collection, filter, update, options);
            };
            const batch = await makeStore().fetchNew();
            expect(batch.map(m => (m as {
                content: string;
            }).content)).toEqual(['a', 'b']);
            expect(store.inspect(COL_SESSIONS, sid)).toMatchObject({ pendingInputs: [], messages: [{ content: 'a' }, { content: 'b' }] });
        });
        it('does not resurrect an input revoked between the read and transfer', async () => {
            await enqueueInput(store, { sessionId: sid, content: 'revoked', userId: 'u', userName: 'A' });
            const original = store.updateOne.bind(store);
            let raced = false;
            store.updateOne = async (collection, filter, update, options) => {
                if (!raced && update.$push && 'messages' in (update.$push as object)) {
                    raced = true;
                    await original(COL_SESSIONS, { _id: sid }, { $set: { pendingInputs: [] } });
                }
                return original(collection, filter, update, options);
            };
            expect(await makeStore().fetchNew()).toEqual([]);
            expect(store.inspect(COL_SESSIONS, sid)).toMatchObject({ pendingInputs: [], messages: [] });
        });
        it('two overlapping fetches under one holder append each input only once', async () => {
            await enqueueInput(store, { sessionId: sid, content: 'a', userId: 'u', userName: 'A' });
            const cs = makeStore();
            const batches = await Promise.all([cs.fetchNew(), cs.fetchNew()]);
            expect(batches.flat()).toHaveLength(1);
            expect(store.inspect(COL_SESSIONS, sid)).toMatchObject({ pendingInputs: [], messages: [{ content: 'a' }] });
        });
        it('a failure before the transfer write leaves the durable inbox intact', async () => {
            await enqueueInput(store, { sessionId: sid, content: 'a', userId: 'u', userName: 'A' });
            store.updateOne = async () => { throw new Error('crash before CAS'); };
            await expect(makeStore().fetchNew()).rejects.toThrow('crash before CAS');
            expect(store.inspect(COL_SESSIONS, sid)).toMatchObject({ pendingInputs: [{ content: 'a' }], messages: [] });
        });
        it('a lost response after transfer leaves history committed without a duplicate inbox', async () => {
            await enqueueInput(store, { sessionId: sid, content: 'a', userId: 'u', userName: 'A' });
            const original = store.updateOne.bind(store);
            store.updateOne = async (...args) => {
                await original(...args);
                throw new Error('response lost after CAS');
            };
            await expect(makeStore().fetchNew()).rejects.toThrow('response lost after CAS');
            expect(store.inspect(COL_SESSIONS, sid)).toMatchObject({ pendingInputs: [], messages: [{ content: 'a' }] });
            store.updateOne = original;
            expect(await makeStore().fetchNew()).toEqual([]);
        });
    });
    describe('hasNew', () => {
        it('returns false when queue is empty', async () => {
            const cs = makeStore();
            expect(await cs.hasNew()).toBe(false);
        });
        it('returns true when queue is non-empty', async () => {
            await enqueueInput(store, { sessionId: sid, content: 'x', userId: 'u', userName: 'A' });
            const cs = makeStore();
            expect(await cs.hasNew()).toBe(true);
        });
        it('does NOT need holder claim (read-only probe)', async () => {
            await enqueueInput(store, { sessionId: sid, content: 'x', userId: 'u', userName: 'A' });
            const cs = createConversationStore({
                store,
                sessionId: sid,
                holder: 'who-knows',
                renewTtlMs: 60000,
                onLockLost: () => { },
            });
            expect(await cs.hasNew()).toBe(true);
        });
    });
    describe('persist', () => {
        it('appends to messages under holder filter', async () => {
            const cs = makeStore();
            const msg: AgentMessage = {
                type: 'assistant',
                content: 'hi',
                timestamp: new Date(),
            };
            await cs.persist([msg]);
            const doc = store.inspect(COL_SESSIONS, sid) as {
                messages: unknown[];
            };
            expect(doc.messages).toHaveLength(1);
        });
        it('is a no-op when messages array is empty', async () => {
            const cs = makeStore();
            await cs.persist([]);
            const doc = store.inspect(COL_SESSIONS, sid) as {
                messages: unknown[];
            };
            expect(doc.messages).toEqual([]);
        });
        it('fires onLockLost when modifiedCount=0 (lock stolen)', async () => {
            let lostFired = false;
            const cs = makeStore(() => {
                lostFired = true;
            });
            store.forceNextUpdateOneMiss();
            const msg: AgentMessage = { type: 'assistant', content: 'x', timestamp: new Date() };
            await expect(cs.persist([msg])).rejects.toThrow('lock lost');
            expect(lostFired).toBe(true);
            const doc = store.inspect(COL_SESSIONS, sid) as {
                messages: unknown[];
            };
            expect(doc.messages).toEqual([]);
        });
        it('renews activeRun.expiresAt on success', async () => {
            const before = (store.inspect(COL_SESSIONS, sid) as {
                activeRun: {
                    expiresAt: Date;
                };
            })
                .activeRun.expiresAt;
            await new Promise((r) => setTimeout(r, 5));
            const cs = makeStore();
            await cs.persist([{ type: 'assistant', content: 'x', timestamp: new Date() }]);
            const after = (store.inspect(COL_SESSIONS, sid) as {
                activeRun: {
                    expiresAt: Date;
                };
            })
                .activeRun.expiresAt;
            expect(after.getTime()).toBeGreaterThan(before.getTime());
        });
    });
});
