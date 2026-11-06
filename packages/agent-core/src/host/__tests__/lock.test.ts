import { describe, it, expect, beforeEach } from 'vitest';
import { acquireLock, renewLock, releaseLock, holderFilter } from '../lock.js';
import { COL_SESSIONS } from '../schema.js';
import { createMemoryDocStore, type MockMemoryDocStore } from './fixtures.js';
describe('host/lock', () => {
    let store: MockMemoryDocStore;
    const sid = 'sess-1';
    beforeEach(() => {
        store = createMemoryDocStore();
        store.seed(COL_SESSIONS, { _id: sid, messages: [], pendingInputs: [] });
    });
    describe('acquireLock', () => {
        it('wins when activeRun is null', async () => {
            const r = await acquireLock(store, {
                sessionId: sid,
                holder: 'h1',
                turnId: 't1',
                ttlMs: 60000,
            });
            expect(r.acquired).toBe(true);
            const doc = store.inspect(COL_SESSIONS, sid);
            expect((doc as {
                activeRun: {
                    holder: string;
                };
            }).activeRun.holder).toBe('h1');
        });
        it('rejects when activeRun is held and not expired', async () => {
            await acquireLock(store, { sessionId: sid, holder: 'h1', turnId: 't1', ttlMs: 60000 });
            const r = await acquireLock(store, {
                sessionId: sid,
                holder: 'h2',
                turnId: 't2',
                ttlMs: 60000,
            });
            expect(r.acquired).toBe(false);
            const doc = store.inspect(COL_SESSIONS, sid);
            expect((doc as {
                activeRun: {
                    holder: string;
                };
            }).activeRun.holder).toBe('h1');
        });
        it('on CAS loss surfaces currentHolder + currentExpiresAt for diagnostics', async () => {
            await acquireLock(store, { sessionId: sid, holder: 'h1', turnId: 't1', ttlMs: 60000 });
            const r = await acquireLock(store, {
                sessionId: sid,
                holder: 'h2',
                turnId: 't2',
                ttlMs: 60000,
            });
            expect(r.acquired).toBe(false);
            expect(r.currentHolder).toBe('h1');
            expect(r.currentExpiresAt).toBeInstanceOf(Date);
            expect((r.currentExpiresAt as Date).getTime()).toBeGreaterThan(Date.now());
        });
        it('re-acquires when expiresAt is in the past', async () => {
            store.seed(COL_SESSIONS, {
                _id: sid,
                messages: [],
                pendingInputs: [],
                activeRun: {
                    holder: 'h1',
                    turnId: 't1',
                    expiresAt: new Date(Date.now() - 1000),
                },
            });
            const r = await acquireLock(store, {
                sessionId: sid,
                holder: 'h2',
                turnId: 't2',
                ttlMs: 60000,
            });
            expect(r.acquired).toBe(true);
            const doc = store.inspect(COL_SESSIONS, sid);
            expect((doc as {
                activeRun: {
                    holder: string;
                };
            }).activeRun.holder).toBe('h2');
        });
        it('parallel acquire — only one wins', async () => {
            const [r1, r2] = await Promise.all([
                acquireLock(store, { sessionId: sid, holder: 'h1', turnId: 't1', ttlMs: 60000 }),
                acquireLock(store, { sessionId: sid, holder: 'h2', turnId: 't2', ttlMs: 60000 }),
            ]);
            expect([r1.acquired, r2.acquired].filter(Boolean).length).toBe(1);
        });
    });
    describe('renewLock', () => {
        it('refreshes expiresAt for current holder', async () => {
            await acquireLock(store, { sessionId: sid, holder: 'h1', turnId: 't1', ttlMs: 60000 });
            const before = store.inspect(COL_SESSIONS, sid) as {
                activeRun: {
                    expiresAt: Date;
                };
            };
            await new Promise((r) => setTimeout(r, 5));
            const ok = await renewLock(store, { sessionId: sid, holder: 'h1', ttlMs: 90000 });
            expect(ok).toBe(true);
            const after = store.inspect(COL_SESSIONS, sid) as {
                activeRun: {
                    expiresAt: Date;
                };
            };
            expect(after.activeRun.expiresAt.getTime()).toBeGreaterThan(before.activeRun.expiresAt.getTime());
        });
        it('does NOT touch acquiredAt — the anchor for stall detection', async () => {
            await acquireLock(store, { sessionId: sid, holder: 'h1', turnId: 't1', ttlMs: 60000 });
            const before = store.inspect(COL_SESSIONS, sid) as {
                activeRun: {
                    acquiredAt: Date;
                };
            };
            expect(before.activeRun.acquiredAt).toBeInstanceOf(Date);
            await new Promise((r) => setTimeout(r, 10));
            await renewLock(store, { sessionId: sid, holder: 'h1', ttlMs: 60000 });
            await renewLock(store, { sessionId: sid, holder: 'h1', ttlMs: 60000 });
            const after = store.inspect(COL_SESSIONS, sid) as {
                activeRun: {
                    acquiredAt: Date;
                };
            };
            expect(after.activeRun.acquiredAt.getTime()).toBe(before.activeRun.acquiredAt.getTime());
        });
        it('returns false for wrong holder (lock lost)', async () => {
            await acquireLock(store, { sessionId: sid, holder: 'h1', turnId: 't1', ttlMs: 60000 });
            const ok = await renewLock(store, { sessionId: sid, holder: 'h2', ttlMs: 60000 });
            expect(ok).toBe(false);
            const doc = store.inspect(COL_SESSIONS, sid) as {
                activeRun: {
                    holder: string;
                };
            };
            expect(doc.activeRun.holder).toBe('h1');
        });
        it('returns false when activeRun is null', async () => {
            const ok = await renewLock(store, { sessionId: sid, holder: 'h1', ttlMs: 60000 });
            expect(ok).toBe(false);
        });
    });
    describe('releaseLock', () => {
        it('unsets activeRun when holder matches', async () => {
            await acquireLock(store, { sessionId: sid, holder: 'h1', turnId: 't1', ttlMs: 60000 });
            expect(await releaseLock(store, { sessionId: sid, holder: 'h1' })).toBe(true);
            const doc = store.inspect(COL_SESSIONS, sid) as Record<string, unknown>;
            expect(doc.activeRun).toBeUndefined();
        });
        it('does NOT clear another holder’s claim', async () => {
            await acquireLock(store, { sessionId: sid, holder: 'h1', turnId: 't1', ttlMs: 60000 });
            expect(await releaseLock(store, { sessionId: sid, holder: 'h2' })).toBe(false);
            const doc = store.inspect(COL_SESSIONS, sid) as {
                activeRun: {
                    holder: string;
                };
            };
            expect(doc.activeRun.holder).toBe('h1');
        });
    });
    describe('holderFilter', () => {
        it('builds filter with _id and activeRun.holder', () => {
            expect(holderFilter('s1', 'h1')).toEqual({
                _id: 's1',
                'activeRun.holder': 'h1',
            });
        });
    });
});
