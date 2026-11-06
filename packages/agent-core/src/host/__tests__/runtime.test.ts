import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createAgentHost } from '../runtime.js';
import { broadcastChannel, triggerChannel, COL_SESSIONS } from '../schema.js';
import { nextEventSeq } from '../events.js';
import { INTERNAL_TIMINGS } from '../types.js';
import { createMemoryDocStore, createMemoryPubSub, createMockLogger, type MockMemoryDocStore, type MockPubSub, type MockLogger, } from './fixtures.js';
describe('host/runtime · wakeUp', () => {
    let store: MockMemoryDocStore;
    let pubSub: MockPubSub;
    let logger: MockLogger;
    beforeEach(() => {
        store = createMemoryDocStore();
        pubSub = createMemoryPubSub();
        logger = createMockLogger();
    });
    function makeRuntime() {
        return createAgentHost({
            docStore: store,
            pubSub,
            logger,
            resolveAgentConfig: async () => {
                throw new Error('not used in wakeUp tests');
            },
        });
    }
    it('persists a durable wake marker then publishes the trigger channel', async () => {
        store.seed(COL_SESSIONS, { _id: 'sess-abc', messages: [] });
        const rt = makeRuntime();
        await expect(rt.wakeUp('sess-abc')).resolves.toBe(true);
        expect(pubSub.published).toHaveLength(1);
        expect(pubSub.published[0]?.channel).toBe(triggerChannel(INTERNAL_TIMINGS.channelPrefix, 'sess-abc'));
        expect(JSON.parse(pubSub.published[0]!.payload)).toEqual({
            wakeRequestId: expect.any(String),
        });
        expect(store.inspect(COL_SESSIONS, 'sess-abc')).toMatchObject({
            runtimeWakeRequestedAt: expect.any(Date),
        });
    });
    it('does NOT touch pendingInputs or create a missing session', async () => {
        const rt = makeRuntime();
        await expect(rt.wakeUp('missing')).resolves.toBe(false);
        expect(store.inspect(COL_SESSIONS, 'missing')).toBeUndefined();
    });
    it('returns true when publish fails because the durable marker remains queued', async () => {
        store.seed(COL_SESSIONS, { _id: 'sess-abc', messages: [] });
        const rt = makeRuntime();
        const origPublish = pubSub.publish.bind(pubSub);
        pubSub.publish = async () => {
            throw new Error('redis pubsub disconnected');
        };
        await expect(rt.wakeUp('sess-abc')).resolves.toBe(true);
        expect(store.inspect(COL_SESSIONS, 'sess-abc')).toMatchObject({
            runtimeWakeRequestedAt: expect.any(Date),
        });
        pubSub.publish = origPublish;
    });
    it('multiple wakeUp calls publish independently', async () => {
        store.seed(COL_SESSIONS, { _id: 'sess-a', messages: [] });
        store.seed(COL_SESSIONS, { _id: 'sess-b', messages: [] });
        const rt = makeRuntime();
        await rt.wakeUp('sess-a');
        await rt.wakeUp('sess-b');
        await rt.wakeUp('sess-a');
        expect(pubSub.published).toHaveLength(3);
        expect(pubSub.published.map((p) => p.channel)).toEqual([
            triggerChannel(INTERNAL_TIMINGS.channelPrefix, 'sess-a'),
            triggerChannel(INTERNAL_TIMINGS.channelPrefix, 'sess-b'),
            triggerChannel(INTERNAL_TIMINGS.channelPrefix, 'sess-a'),
        ]);
    });
});
describe('host/runtime · getCurrentSeq', () => {
    let store: MockMemoryDocStore;
    let pubSub: MockPubSub;
    let logger: MockLogger;
    beforeEach(() => {
        store = createMemoryDocStore();
        pubSub = createMemoryPubSub();
        logger = createMockLogger();
    });
    function makeRuntime() {
        return createAgentHost({
            docStore: store,
            pubSub,
            logger,
            resolveAgentConfig: async () => {
                throw new Error('not used here');
            },
        });
    }
    it('returns 0 before any seq has been allocated', async () => {
        const rt = makeRuntime();
        await expect(rt.getCurrentSeq('sess-x')).resolves.toBe(0);
    });
    it('returns the last allocated seq after N nextEventSeq calls', async () => {
        const rt = makeRuntime();
        await nextEventSeq(store, 'sess-x');
        await nextEventSeq(store, 'sess-x');
        await nextEventSeq(store, 'sess-x');
        await expect(rt.getCurrentSeq('sess-x')).resolves.toBe(3);
        await expect(rt.getCurrentSeq('sess-y')).resolves.toBe(0);
    });
});
describe('host/runtime · broadcastChannel / publish / subscribeBroadcast', () => {
    let store: MockMemoryDocStore;
    let pubSub: MockPubSub;
    let logger: MockLogger;
    beforeEach(() => {
        store = createMemoryDocStore();
        pubSub = createMemoryPubSub();
        logger = createMockLogger();
    });
    function makeRuntime() {
        return createAgentHost({
            docStore: store,
            pubSub,
            logger,
            resolveAgentConfig: async () => {
                throw new Error('not used here');
            },
        });
    }
    it('broadcastChannel returns the lib-internal channel name', () => {
        const rt = makeRuntime();
        expect(rt.broadcastChannel('sess-a')).toBe(broadcastChannel(INTERNAL_TIMINGS.channelPrefix, 'sess-a'));
    });
    it('publish writes to the same channel that the lib uses internally', async () => {
        const rt = makeRuntime();
        await rt.publish('sess-a', '{"x":1}');
        expect(pubSub.published).toHaveLength(1);
        expect(pubSub.published[0]).toEqual({
            channel: broadcastChannel(INTERNAL_TIMINGS.channelPrefix, 'sess-a'),
            payload: '{"x":1}',
        });
    });
    it('subscribeBroadcast subscribes to the same channel and receives publishes', async () => {
        const rt = makeRuntime();
        const got: string[] = [];
        const unsubscribe = await rt.subscribeBroadcast('sess-b', (p) => got.push(p));
        await rt.publish('sess-b', 'hi');
        await rt.publish('sess-b', 'there');
        expect(got).toEqual(['hi', 'there']);
        await unsubscribe();
        await rt.publish('sess-b', 'late');
        expect(got).toEqual(['hi', 'there']);
    });
});
describe('host/runtime · stop · drain timeout handoff', () => {
    let store: MockMemoryDocStore;
    let pubSub: MockPubSub;
    let logger: MockLogger;
    beforeEach(() => {
        store = createMemoryDocStore();
        pubSub = createMemoryPubSub();
        logger = createMockLogger();
    });
    it('publishes nothing when no sessions are in-flight (clean drain)', async () => {
        const rt = createAgentHost({
            docStore: store,
            pubSub,
            logger,
            resolveAgentConfig: async () => {
                throw new Error('not used — no work injected');
            },
        });
        await rt.start();
        await rt.stop();
        const triggerPrefix = triggerChannel(INTERNAL_TIMINGS.channelPrefix, '');
        const handoffs = pubSub.published.filter((p) => p.channel.startsWith(triggerPrefix));
        expect(handoffs).toEqual([]);
    });
});
describe('host/runtime · selfHealingScan · two orphan classes', () => {
    let store: MockMemoryDocStore;
    let pubSub: MockPubSub;
    let logger: MockLogger;
    beforeEach(() => {
        store = createMemoryDocStore();
        pubSub = createMemoryPubSub();
        logger = createMockLogger();
    });
    function lastScanResult(): {
        inbox: number;
        staleLock: number;
        wakeRequested: number;
        scanMs: number;
    } | undefined {
        for (let i = logger.records.length - 1; i >= 0; i--) {
            const r = logger.records[i];
            if (r.args[r.args.length - 1] === 'host.scan · result') {
                const payload = r.args[0] as {
                    inbox: number;
                    staleLock: number;
                    wakeRequested: number;
                    scanMs: number;
                };
                return payload;
            }
        }
        return undefined;
    }
    async function waitForFirstScanResult(timeoutMs = 1000): Promise<void> {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            if (lastScanResult() !== undefined)
                return;
            await new Promise((r) => setTimeout(r, 5));
        }
        throw new Error('selfHealingScan did not emit "host.scan · result" within timeout');
    }
    async function startRuntime() {
        const rt = createAgentHost({
            docStore: store,
            pubSub,
            logger,
            resolveAgentConfig: async () => {
                throw new Error('not exercised — scan dispatches are best-effort');
            },
        });
        await rt.start();
        return rt;
    }
    it('Class A: inbox non-empty + activeRun null → surfaces in inbox count', async () => {
        store.seed(COL_SESSIONS, {
            _id: 'sess-A',
            pendingInputs: [{ messageId: 'm1', content: 'hello', timestamp: new Date() }],
            activeRun: null,
            messages: [],
        });
        const rt = await startRuntime();
        try {
            await waitForFirstScanResult();
            const r = lastScanResult();
            expect(r).toBeDefined();
            expect(r!.inbox).toBe(1);
            expect(r!.staleLock).toBe(0);
        }
        finally {
            await rt.stop();
        }
    });
    it('Class A: inbox non-empty + activeRun expired → still inbox count (also matches staleLock query, dedupe drops one)', async () => {
        store.seed(COL_SESSIONS, {
            _id: 'sess-AB',
            pendingInputs: [{ messageId: 'm1', content: 'hello', timestamp: new Date() }],
            activeRun: {
                holder: 'dead-pod',
                turnId: 'old-turn',
                expiresAt: new Date(Date.now() - 60000),
            },
            messages: [],
        });
        const rt = await startRuntime();
        try {
            await waitForFirstScanResult();
            const r = lastScanResult();
            expect(r).toBeDefined();
            expect(r!.inbox).toBe(1);
            expect(r!.staleLock).toBe(1);
        }
        finally {
            await rt.stop();
        }
    });
    it('Class B: empty inbox + stale lock → surfaces ONLY in staleLock count (the rolling-deploy bug fix)', async () => {
        store.seed(COL_SESSIONS, {
            _id: 'sess-stuck',
            pendingInputs: [],
            activeRun: {
                holder: 'dead-pod',
                turnId: 'orphan-turn',
                expiresAt: new Date(Date.now() - 60000),
            },
            messages: [
                { type: 'assistant', content: '', toolCalls: [{ id: 'tc1', name: 'shell', arguments: '{}' }] },
                { type: 'tool', toolCallId: 'tc1', content: 'result', isError: false },
            ],
        });
        const rt = await startRuntime();
        try {
            await waitForFirstScanResult();
            const r = lastScanResult();
            expect(r).toBeDefined();
            expect(r!.staleLock).toBe(1);
            expect(r!.inbox).toBe(0);
        }
        finally {
            await rt.stop();
        }
    });
    it('Class B: settled expired ownership without wake is retired without execution', async () => {
        store.seed(COL_SESSIONS, {
            _id: 'sess-settled-stale', pendingInputs: [],
            activeRun: { holder: 'old-owner', turnId: 'old-turn', expiresAt: new Date(Date.now() - 60000) },
            messages: [{ type: 'assistant', content: 'done', toolCalls: [] }],
        });
        let resolved = 0;
        const releases: unknown[] = [];
        const rt = createAgentHost({
            docStore: store, pubSub, logger,
            resolveAgentConfig: async () => { resolved += 1; throw new Error('must not execute'); },
            onTurnReleased: async (event) => { releases.push(event); },
        });
        await rt.start();
        try {
            await waitForFirstScanResult();
            await vi.waitFor(() => expect(releases).toHaveLength(1));
            expect(lastScanResult()!.staleLock).toBe(1);
            expect(store.inspect(COL_SESSIONS, 'sess-settled-stale')).not.toHaveProperty('activeRun');
            expect(resolved).toBe(0);
            expect(releases).toEqual([{ sessionId: 'sess-settled-stale', holder: 'old-owner', turnId: 'old-turn' }]);
        }
        finally {
            await rt.stop();
        }
    });
    it('Class C: durable wake marker + expired lock → surfaces in wakeRequested count', async () => {
        store.seed(COL_SESSIONS, {
            _id: 'sess-wake-recovery',
            pendingInputs: [],
            activeRun: {
                holder: 'dead-pod',
                turnId: 'orphan-turn',
                expiresAt: new Date(Date.now() - 60000),
            },
            runtimeWakeRequestedAt: new Date(),
            runtimeWakeRequestId: 'wake-123',
            messages: [
                { type: 'assistant', content: '', toolCalls: [{ id: 'tc1', name: 'shell', arguments: '{}' }] },
                { type: 'tool', toolCallId: 'tc1', content: 'result', isError: false },
            ],
        });
        const rt = await startRuntime();
        try {
            await waitForFirstScanResult();
            const r = lastScanResult();
            expect(r).toBeDefined();
            expect(r!.wakeRequested).toBe(1);
        }
        finally {
            await rt.stop();
        }
    });
    it('Class C: durable wake marker + live lock → stays queued but is not dispatched', async () => {
        store.seed(COL_SESSIONS, {
            _id: 'sess-wake-live',
            pendingInputs: [],
            activeRun: {
                holder: 'live-peer-pod',
                turnId: 'turn-X',
                expiresAt: new Date(Date.now() + 60000),
            },
            runtimeWakeRequestedAt: new Date(),
            runtimeWakeRequestId: 'wake-live',
            messages: [{ type: 'assistant', content: 'working' }],
        });
        const rt = await startRuntime();
        try {
            await waitForFirstScanResult();
            const r = lastScanResult();
            expect(r).toBeDefined();
            expect(r!.wakeRequested).toBe(0);
        }
        finally {
            await rt.stop();
        }
    });
    it('healthy session with live (unexpired) lock → invisible to both classes', async () => {
        store.seed(COL_SESSIONS, {
            _id: 'sess-live',
            pendingInputs: [],
            activeRun: {
                holder: 'live-peer-pod',
                turnId: 'turn-X',
                expiresAt: new Date(Date.now() + 60000),
            },
            messages: [{ type: 'assistant', content: 'ok' }],
        });
        const rt = await startRuntime();
        try {
            await waitForFirstScanResult();
            const r = lastScanResult();
            expect(r).toBeDefined();
            expect(r!.inbox).toBe(0);
            expect(r!.staleLock).toBe(0);
        }
        finally {
            await rt.stop();
        }
    });
    it('settled session with no lock → invisible to both classes (no work)', async () => {
        store.seed(COL_SESSIONS, {
            _id: 'sess-idle',
            pendingInputs: [],
            activeRun: null,
            messages: [{ type: 'assistant', content: 'all done' }],
        });
        const rt = await startRuntime();
        try {
            await waitForFirstScanResult();
            const r = lastScanResult();
            expect(r).toBeDefined();
            expect(r!.inbox).toBe(0);
            expect(r!.staleLock).toBe(0);
        }
        finally {
            await rt.stop();
        }
    });
});
