import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createConsumer } from '../consumer.js';
import { acquireLock, renewLock } from '../lock.js';
import { createConversationStore } from '../conversation-store.js';
import { enqueueInput } from '../pending-inputs.js';
import { COL_SESSIONS, COL_EVENTS } from '../schema.js';
import { INTERNAL_TIMINGS } from '../types.js';
import { createMemoryDocStore, createMemoryPubSub, createMockLogger, type MockMemoryDocStore, type MockPubSub, type MockLogger, } from './fixtures.js';
import { MockLLMClient } from '../../__tests__/fixtures.js';
import type { AgentHostConfig } from '../types.js';
describe('host/consumer', () => {
    let store: MockMemoryDocStore;
    let pubSub: MockPubSub;
    let logger: MockLogger;
    const sid = 'sess-1';
    beforeEach(() => {
        store = createMemoryDocStore();
        pubSub = createMemoryPubSub();
        logger = createMockLogger();
    });
    function makeConsumer(resolveOverride?: AgentHostConfig['resolveAgentConfig'], onTurnReleased?: AgentHostConfig['onTurnReleased']) {
        const client = new MockLLMClient([{ content: 'hello', stopReason: 'end_turn' }], 'openai');
        const cfg: AgentHostConfig = {
            docStore: store,
            pubSub,
            logger,
            onTurnReleased,
            resolveAgentConfig: resolveOverride ??
                (async () => ({
                    client,
                    systemPrompt: 'you are a test',
                    tools: [],
                    keyId: 'test-key',
                })),
        };
        return createConsumer({
            config: cfg,
            timings: { ...INTERNAL_TIMINGS, lockRenewMs: 100000, scanIntervalMs: 100000 },
            consumerId: 'h-test',
        });
    }
    it('repairs an orphan batch without deleting later user or host input', async () => {
        const later = { type: 'event', eventType: 'user_message', content: 'Keep this new request', timestamp: new Date() };
        const injection = { type: 'system_injection', kind: 'reminder', content: 'Keep host context', timestamp: new Date() };
        store.seed(COL_SESSIONS, { _id: sid, pendingInputs: [], messages: [
                { type: 'event', eventType: 'user_message', content: 'Original request', timestamp: new Date() },
                { type: 'assistant', content: null, toolCalls: [{ id: 'orphan', name: 'missing', arguments: '{}' }], timestamp: new Date() },
                later, injection,
            ] });
        const client = new MockLLMClient([{ content: 'Recovered.' }]);
        await makeConsumer(async () => ({ client, systemPrompt: '', tools: [], keyId: '' })).processSession(sid);
        expect(client.calls).toHaveLength(1);
        expect(client.calls[0].messages).toContainEqual(later);
        expect(client.calls[0].messages).toContainEqual(injection);
        expect(store.inspect(COL_SESSIONS, sid)).toHaveProperty('messages', [
            expect.objectContaining({ content: 'Original request' }), later, injection,
            expect.objectContaining({ content: 'Recovered.' }),
        ]);
    });
    it('aborts before resolving config or calling the LLM if the orphan repair loses its holder fence', async () => {
        const messages = [
            { type: 'event', eventType: 'user_message', content: 'Original request', timestamp: new Date() },
            { type: 'assistant', content: null, toolCalls: [{ id: 'orphan', name: 'missing', arguments: '{}' }], timestamp: new Date() },
            { type: 'event', eventType: 'user_message', content: 'New request', timestamp: new Date() },
        ];
        store.seed(COL_SESSIONS, { _id: sid, pendingInputs: [], messages });
        const updateOne = store.updateOne.bind(store);
        let repairMisses = 0;
        const updateSpy = vi.spyOn(store, 'updateOne').mockImplementation(async (collection, filter, update, options) => {
            if (collection === COL_SESSIONS && update.$set?.messages) {
                expect(filter).toHaveProperty('activeRun.holder', 'h-test');
                repairMisses++;
                return { matchedCount: 0, modifiedCount: 0, upserted: false };
            }
            return updateOne(collection, filter, update, options);
        });
        const client = new MockLLMClient([{ content: 'Must not run.' }]);
        const resolveConfig = vi.fn(async () => ({ client, systemPrompt: '', tools: [], keyId: '' }));
        try {
            await makeConsumer(resolveConfig).processSession(sid);
            expect(repairMisses).toBe(1);
            expect(resolveConfig).not.toHaveBeenCalled();
            expect(client.calls).toHaveLength(0);
            expect(store.inspect(COL_SESSIONS, sid)).toHaveProperty('messages', messages);
        }
        finally {
            updateSpy.mockRestore();
        }
    });
    describe('settled expired ownership retirement', () => {
        let forbiddenCalls = 0;
        beforeEach(() => { forbiddenCalls = 0; });
        afterEach(() => { expect(forbiddenCalls).toBe(0); });
        const oldRun = () => ({ holder: 'old-owner', turnId: 'old-turn', expiresAt: new Date(Date.now() - 60000) });
        function seed(wake = false) {
            store.seed(COL_SESSIONS, {
                _id: sid, messages: [{ type: 'assistant', content: 'done', toolCalls: [] }],
                pendingInputs: [], activeRun: oldRun(), metadata: { keep: true },
                activeSubagentTurn: { runIds: ['preserve'] },
                ...(wake ? { runtimeWakeRequestId: 'wake-1', runtimeWakeRequestedAt: new Date(), runtimeWakeSessionFilter: null } : {}),
            });
        }
        function noExecution(onRelease?: AgentHostConfig['onTurnReleased']) {
            return makeConsumer(async () => { forbiddenCalls += 1; throw new Error('settled cleanup must not resolve config or run tools/model'); }, onRelease);
        }
        it.each([false, true])('retires exactly once, preserves unrelated fields, fences old writes (wake=%s)', async (wake) => {
            seed(wake);
            const releases: unknown[] = [];
            const consumer = noExecution(async (event) => { releases.push(event); });
            await Promise.all([consumer.processSession(sid), consumer.processSession(sid)]);
            await consumer.processSession(sid);
            const doc = store.inspect(COL_SESSIONS, sid);
            expect(doc).not.toHaveProperty('activeRun');
            expect(doc).not.toHaveProperty('runtimeWakeRequestId');
            expect(doc).toHaveProperty('metadata.keep', true);
            expect(doc).toHaveProperty('activeSubagentTurn.runIds', ['preserve']);
            expect(releases).toEqual([{ sessionId: sid, holder: 'old-owner', turnId: 'old-turn' }]);
            expect(await renewLock(store, { sessionId: sid, holder: 'old-owner', ttlMs: 60000 })).toBe(false);
            let lost = false;
            const conversation = createConversationStore({ store, sessionId: sid, holder: 'old-owner', renewTtlMs: 60000, onLockLost: () => { lost = true; } });
            await expect(conversation.persist([{ type: 'assistant', content: 'late' }])).rejects.toThrow('lock lost');
            expect(lost).toBe(true);
            expect(store.inspect(COL_SESSIONS, sid)).toHaveProperty('messages', [{ type: 'assistant', content: 'done', toolCalls: [] }]);
        });
        it.each([new Date(Date.now() + 600000), 'expired', null, new Date(NaN)])('leaves live or invalid expiry untouched (%s)', async (expiresAt) => {
            seed(true);
            await store.updateOne(COL_SESSIONS, { _id: sid }, { $set: { 'activeRun.expiresAt': expiresAt } });
            await noExecution().processSession(sid);
            expect(store.inspect(COL_SESSIONS, sid)).toHaveProperty('activeRun.holder', 'old-owner');
            expect(store.inspect(COL_SESSIONS, sid)).toHaveProperty('runtimeWakeRequestId', 'wake-1');
        });
        it.each(['renewal', 'takeover', 'same-holder-new-turn', 'generation', 'existing-generation', 'input', 'system', 'wake', 'tail-tools', 'tail-edit'])('loses retirement CAS to concurrent %s', async (kind) => {
            seed();
            if (kind === 'existing-generation')
                await store.updateOne(COL_SESSIONS, { _id: sid }, { $set: { inputGeneration: 7 } });
            const original = store.updateOne.bind(store);
            let raced = false;
            store.updateOne = async (collection, filter, update, options) => {
                if (!raced && collection === COL_SESSIONS && update.$unset && 'activeRun' in update.$unset) {
                    raced = true;
                    const changes: Record<string, unknown> = {
                        renewal: { 'activeRun.expiresAt': new Date(Date.now() + 60000) },
                        takeover: { activeRun: { ...oldRun(), holder: 'peer' } },
                        'same-holder-new-turn': { 'activeRun.turnId': 'new-turn' },
                        generation: { inputGeneration: 1 },
                        'existing-generation': { inputGeneration: 8 },
                        input: { pendingInputs: [{ messageId: 'new', content: 'work' }] },
                        system: { messages: [{ type: 'assistant', content: 'done' }, { type: 'system_injection', content: 'work' }] },
                        wake: { runtimeWakeRequestId: 'new-wake' },
                        'tail-tools': { messages: [{ type: 'assistant', toolCalls: [{ id: 'tool' }] }] },
                        'tail-edit': { messages: [{ type: 'assistant', content: 'changed', toolCalls: [] }] },
                    };
                    await original(COL_SESSIONS, { _id: sid }, { $set: changes[kind] });
                }
                return original(collection, filter, update, options);
            };
            let releases = 0;
            await noExecution(async () => { releases += 1; }).processSession(sid);
            expect(raced).toBe(true);
            expect(store.inspect(COL_SESSIONS, sid)).toHaveProperty('activeRun');
            expect(releases).toBe(0);
        });
        it('honors supplied wake and session guards', async () => {
            seed(true);
            await noExecution().processSession(sid, { wakeRequestId: 'different' });
            await noExecution().processSession(sid, { sessionFilter: { inputGeneration: 8 } });
            expect(store.inspect(COL_SESSIONS, sid)).toHaveProperty('activeRun');
        });
        it.each([false, true])('cleans only retired events and handles cleanup/hook failures (%s)', async (fail) => {
            seed();
            store.seed(COL_EVENTS, { _id: 'old-event', sessionId: sid, turnId: 'old-turn' });
            store.seed(COL_EVENTS, { _id: 'new-event', sessionId: sid, turnId: 'new-turn' });
            const original = store.deleteMany.bind(store);
            store.deleteMany = async (collection, filter) => {
                if (collection === COL_EVENTS) {
                    await store.updateOne(COL_SESSIONS, { _id: sid }, { $set: { activeRun: { ...oldRun(), turnId: 'new-turn' } } });
                    if (fail)
                        throw new Error('event cleanup unavailable');
                }
                return original(collection, filter);
            };
            let releases = 0;
            await noExecution(async () => { releases += 1; if (fail)
                throw new Error('hook unavailable'); }).processSession(sid);
            expect(releases).toBe(1);
            expect(await store.findOne(COL_EVENTS, { _id: 'new-event' })).not.toBeNull();
            expect(await store.findOne(COL_EVENTS, { _id: 'old-event' }) === null).toBe(!fail);
            expect(store.inspect(COL_SESSIONS, sid)).toHaveProperty('activeRun.turnId', 'new-turn');
        });
    });
    describe('settled durable wake retirement', () => {
        function seedSettled(messages: unknown[] = [{ type: 'assistant', content: 'done', toolCalls: null }]) {
            store.seed(COL_SESSIONS, {
                _id: sid, messages, pendingInputs: [],
                runtimeWakeRequestedAt: new Date(), runtimeWakeRequestId: 'wake-1',
                runtimeWakeSessionFilter: null,
            });
        }
        it.each([undefined, [], [{ type: 'assistant', content: 'done', toolCalls: [] }]])('retires already-handled wakes without creating an execution or model call (%j)', async (messages) => {
            seedSettled(messages);
            let calls = 0;
            const consumer = makeConsumer(async () => { calls += 1; throw new Error('must not run'); });
            await consumer.processSession(sid, { wakeRequestId: 'wake-1' });
            await consumer.processSession(sid, { wakeRequestId: 'wake-1' });
            const doc = store.inspect(COL_SESSIONS, sid);
            expect(doc).not.toHaveProperty('runtimeWakeRequestedAt');
            expect(doc).not.toHaveProperty('runtimeWakeRequestId');
            expect(doc).not.toHaveProperty('runtimeWakeSessionFilter');
            expect(doc).not.toHaveProperty('activeRun');
            expect(calls).toBe(0);
        });
        it('preserves a newer wake request and a failed request-generation guard', async () => {
            seedSettled();
            const consumer = makeConsumer();
            await consumer.processSession(sid, { wakeRequestId: 'older-wake' });
            expect(store.inspect(COL_SESSIONS, sid)).toHaveProperty('runtimeWakeRequestId', 'wake-1');
            await consumer.processSession(sid, { wakeRequestId: 'wake-1', sessionFilter: { inputGeneration: 99 } });
            expect(store.inspect(COL_SESSIONS, sid)).toHaveProperty('runtimeWakeRequestId', 'wake-1');
        });
        it('does not retire a wake owned by a live peer', async () => {
            seedSettled();
            await acquireLock(store, { sessionId: sid, holder: 'peer', turnId: 'peer-turn', ttlMs: 60000 });
            await makeConsumer().processSession(sid, { wakeRequestId: 'wake-1' });
            expect(store.inspect(COL_SESSIONS, sid)).toHaveProperty('runtimeWakeRequestId', 'wake-1');
            expect(store.inspect(COL_SESSIONS, sid)).toHaveProperty('activeRun.holder', 'peer');
        });
        it.each(['wake', 'input', 'system', 'owner', 'tail-tools'])('loses cleanup CAS to concurrent %s without erasing work', async (kind) => {
            seedSettled();
            const original = store.updateOne.bind(store);
            let raced = false;
            store.updateOne = async (collection, filter, update, options) => {
                if (!raced && filter.runtimeWakeRequestId === 'wake-1' && update.$unset) {
                    raced = true;
                    if (kind === 'wake')
                        await original(COL_SESSIONS, { _id: sid }, { $set: { runtimeWakeRequestId: 'wake-2' } });
                    if (kind === 'input')
                        await original(COL_SESSIONS, { _id: sid }, { $push: { pendingInputs: { id: 'new' } } });
                    if (kind === 'system')
                        await original(COL_SESSIONS, { _id: sid }, { $push: { messages: { type: 'system_injection', content: 'new work' } } });
                    if (kind === 'owner')
                        await acquireLock(store, { sessionId: sid, holder: 'peer', turnId: 'peer-turn', ttlMs: 60000 });
                    if (kind === 'tail-tools')
                        await original(COL_SESSIONS, { _id: sid }, { $set: { messages: [{ type: 'assistant', toolCalls: [{ id: 'new-tool' }] }] } });
                }
                return original(collection, filter, update, options);
            };
            await makeConsumer().processSession(sid, { wakeRequestId: 'wake-1' });
            expect(raced).toBe(true);
            expect(store.inspect(COL_SESSIONS, sid)).toHaveProperty('runtimeWakeRequestedAt');
            expect(store.inspect(COL_SESSIONS, sid)).toHaveProperty('runtimeWakeRequestId', kind === 'wake' ? 'wake-2' : 'wake-1');
        });
        it('still executes a genuine wake-only continuation', async () => {
            seedSettled([{ type: 'user', content: 'please retry' }]);
            await makeConsumer().processSession(sid, { wakeRequestId: 'wake-1' });
            const doc = store.inspect(COL_SESSIONS, sid) as {
                messages: Array<{
                    type: string;
                    content?: string;
                }>;
            };
            expect(doc.messages.at(-1)?.content).toBe('hello');
            expect(doc).not.toHaveProperty('runtimeWakeRequestId');
        });
    });
    describe('resolveAgentConfig throw', () => {
        it('rejects removed auto-mount config before draining input', async () => {
            await enqueueInput(store, { sessionId: sid, content: 'hi', userId: 'u', userName: 'A' });
            const client = new MockLLMClient([{ content: 'must not run' }], 'openai');
            const consumer = makeConsumer(async () => ({
                client, systemPrompt: '', tools: [], keyId: 'test-key', builtinTools: {},
            }));
            await consumer.processSession(sid);
            const doc = store.inspect(COL_SESSIONS, sid) as {
                pendingInputs: unknown[];
                messages?: unknown[];
                activeRun?: unknown;
            };
            expect(doc.pendingInputs).toHaveLength(1);
            expect(doc.messages ?? []).toEqual([]);
            expect(doc.activeRun).toBeUndefined();
            expect(client.calls).toEqual([]);
            expect(logger.records.some(r => r.level === 'error' && r.args.some(arg => arg && typeof arg === 'object' && 'err' in arg &&
                arg.err instanceof Error && arg.err.message.includes('builtinTools is no longer supported')))).toBe(true);
        });
        it('releases lock + LEAVES pendingInputs intact (no permanent loss)', async () => {
            await enqueueInput(store, {
                sessionId: sid,
                content: 'hi',
                userId: 'u',
                userName: 'A',
            });
            const consumer = makeConsumer(async () => {
                throw new Error('mongo down');
            });
            await consumer.processSession(sid);
            const doc = store.inspect(COL_SESSIONS, sid) as {
                pendingInputs: unknown[];
                messages: unknown[];
                activeRun?: unknown;
            };
            expect(doc.pendingInputs).toHaveLength(1);
            expect(doc.messages ?? []).toEqual([]);
            expect(doc.activeRun).toBeUndefined();
            expect(logger.records.some((r) => r.level === 'error' &&
                JSON.stringify(r.args).includes('resolveAgentConfig threw'))).toBe(true);
        });
    });
    describe('post-release lifecycle', () => {
        it('publishes the final turnId at acquire and invokes onTurnReleased only after activeRun is gone', async () => {
            await enqueueInput(store, {
                sessionId: sid,
                content: 'hi',
                userId: 'u',
                userName: 'A',
            });
            let turnIdFromHook: string | undefined;
            let releaseEvent: {
                sessionId: string;
                turnId: string;
                holder: string;
            } | undefined;
            const client = new MockLLMClient([{ content: 'hello', stopReason: 'end_turn' }], 'openai');
            const consumer = createConsumer({
                config: {
                    docStore: store,
                    pubSub,
                    logger,
                    resolveAgentConfig: async () => ({
                        client,
                        systemPrompt: 'you are a test',
                        tools: [],
                        keyId: 'test-key',
                        hooks: {
                            beforeTurn: (state) => {
                                turnIdFromHook = state.turnId;
                                const held = store.inspect(COL_SESSIONS, sid) as {
                                    activeRun?: {
                                        turnId: string;
                                    };
                                };
                                expect(held.activeRun?.turnId).toBe(state.turnId);
                            },
                            afterTurn: (state) => {
                                const held = store.inspect(COL_SESSIONS, sid) as {
                                    activeRun?: {
                                        turnId: string;
                                    };
                                };
                                expect(held.activeRun?.turnId).toBe(state.turnId);
                            },
                        },
                    }),
                    onTurnReleased: async (event) => {
                        releaseEvent = event;
                        const released = store.inspect(COL_SESSIONS, sid) as {
                            activeRun?: unknown;
                        };
                        expect(released.activeRun).toBeUndefined();
                    },
                },
                timings: { ...INTERNAL_TIMINGS, lockRenewMs: 100000, scanIntervalMs: 100000 },
                consumerId: 'h-test',
            });
            await consumer.processSession(sid);
            expect(turnIdFromHook).toBeTruthy();
            expect(releaseEvent).toEqual({
                sessionId: sid,
                turnId: turnIdFromHook,
                holder: 'h-test',
            });
        });
    });
    describe('post-release wakeUp', () => {
        it('coalesces a request made during afterTurn and re-enters after activeRun is released', async () => {
            await enqueueInput(store, {
                sessionId: sid,
                content: 'hi',
                userId: 'u',
                userName: 'A',
            });
            let resolveCalls = 0;
            let retryRequested = false;
            let consumer: ReturnType<typeof makeConsumer>;
            const client = new MockLLMClient([
                { content: '', stopReason: 'end_turn' },
                { content: 'recovered', stopReason: 'end_turn' },
            ], 'openai');
            const cfg: AgentHostConfig = {
                docStore: store,
                pubSub,
                logger,
                resolveAgentConfig: async () => {
                    resolveCalls += 1;
                    return {
                        client,
                        systemPrompt: 'you are a test',
                        tools: [],
                        keyId: 'test-key',
                        hooks: {
                            afterTurn: async () => {
                                if (!retryRequested) {
                                    retryRequested = true;
                                    await store.updateOne(COL_SESSIONS, { _id: sid }, {
                                        $set: {
                                            runtimeWakeRequestedAt: new Date(),
                                            runtimeWakeRequestId: 'wake-1',
                                            runtimeWakeSessionFilter: null,
                                        },
                                    });
                                    expect(consumer.requestPostReleaseWakeUp(sid)).toBe(true);
                                    const held = store.inspect(COL_SESSIONS, sid) as {
                                        activeRun?: unknown;
                                    };
                                    expect(held.activeRun).toBeDefined();
                                }
                            },
                        },
                    };
                },
            };
            consumer = createConsumer({
                config: cfg,
                timings: { ...INTERNAL_TIMINGS, lockRenewMs: 100000, scanIntervalMs: 100000 },
                consumerId: 'h-test',
            });
            await consumer.processSession(sid);
            await new Promise((resolve) => setTimeout(resolve, 0));
            expect(resolveCalls).toBe(2);
            const doc = store.inspect(COL_SESSIONS, sid) as {
                activeRun?: unknown;
            };
            expect(doc.activeRun).toBeUndefined();
            expect(consumer.requestPostReleaseWakeUp(sid)).toBe(false);
        });
    });
    describe('execution-owner event cleanup', () => {
        it('clears replay rows inherited from a dead owner before publishing the new turn', async () => {
            await enqueueInput(store, {
                sessionId: sid,
                content: 'hi',
                userId: 'u',
                userName: 'A',
            });
            store.seed(COL_EVENTS, {
                _id: 'stale-1',
                sessionId: sid,
                turnId: 'dead-turn',
                seq: 1,
                payload: JSON.stringify({
                    type: 'tool_call_start',
                    sessionId: sid,
                    turnId: 'dead-turn',
                    toolCallId: 'stale-tool',
                    name: 'shell',
                }),
                createdAt: new Date(),
            });
            const originalPublish = pubSub.publish.bind(pubSub);
            let staleRowsAtFirstPublish: Array<Record<string, unknown>> | undefined;
            pubSub.publish = async (channel, payload) => {
                if (channel.includes(`broadcast:session:${sid}`) && staleRowsAtFirstPublish === undefined) {
                    staleRowsAtFirstPublish = store
                        .dump(COL_EVENTS)
                        .filter((d) => d.sessionId === sid && d.turnId === 'dead-turn');
                }
                await originalPublish(channel, payload);
            };
            const consumer = makeConsumer();
            await consumer.processSession(sid);
            expect(staleRowsAtFirstPublish).toEqual([]);
            expect(store.dump(COL_EVENTS).filter((d) => d.sessionId === sid)).toEqual([]);
        });
        it('does not clear replay rows while another holder owns the session lock', async () => {
            await enqueueInput(store, {
                sessionId: sid,
                content: 'hi',
                userId: 'u',
                userName: 'A',
            });
            store.seed(COL_EVENTS, {
                _id: 'live-owner-event',
                sessionId: sid,
                turnId: 'live-turn',
                seq: 1,
                payload: JSON.stringify({ type: 'turn_start', turnId: 'live-turn' }),
                createdAt: new Date(),
            });
            await acquireLock(store, {
                sessionId: sid,
                holder: 'other-pod',
                turnId: 'live-turn',
                ttlMs: 60000,
            });
            const consumer = makeConsumer();
            await consumer.processSession(sid);
            expect(store.dump(COL_EVENTS).filter((d) => d._id === 'live-owner-event')).toHaveLength(1);
        });
        it('fails closed when inherited-event cleanup fails: no turn runs, input remains, lock releases', async () => {
            await enqueueInput(store, {
                sessionId: sid,
                content: 'hi',
                userId: 'u',
                userName: 'A',
            });
            store.seed(COL_EVENTS, {
                _id: 'stale-1',
                sessionId: sid,
                turnId: 'dead-turn',
                seq: 1,
                payload: JSON.stringify({ type: 'turn_start', turnId: 'dead-turn' }),
                createdAt: new Date(),
            });
            store.forceNextDeleteManyFailure();
            const consumer = makeConsumer();
            await consumer.processSession(sid);
            const doc = store.inspect(COL_SESSIONS, sid) as {
                pendingInputs: unknown[];
                messages?: unknown[];
                activeRun?: unknown;
            };
            expect(doc.pendingInputs).toHaveLength(1);
            expect(doc.messages ?? []).toEqual([]);
            expect(doc.activeRun).toBeUndefined();
            expect(pubSub.published).toEqual([]);
            expect(store.dump(COL_EVENTS).filter((d) => d._id === 'stale-1')).toHaveLength(1);
            expect(logger.records.some((r) => r.level === 'error' &&
                JSON.stringify(r.args).includes('inherited event cleanup failed'))).toBe(true);
        });
    });
    describe('happy path', () => {
        it('drains pendingInputs, runs 0.2 turn, persists assistant reply, clears events table, releases lock', async () => {
            await enqueueInput(store, {
                sessionId: sid,
                content: 'hi',
                userId: 'u',
                userName: 'A',
            });
            const consumer = makeConsumer();
            await consumer.processSession(sid);
            const doc = store.inspect(COL_SESSIONS, sid) as {
                pendingInputs: unknown[];
                messages: Array<{
                    type: string;
                }>;
                activeRun?: unknown;
            };
            expect(doc.pendingInputs).toEqual([]);
            expect(doc.activeRun).toBeUndefined();
            expect(doc.messages.length).toBeGreaterThanOrEqual(2);
            const types = doc.messages.map((m) => m.type);
            expect(types).toContain('event');
            expect(types).toContain('assistant');
            const evDocs = store.dump(COL_EVENTS).filter((d) => 'sessionId' in d);
            expect(evDocs.filter((d) => d.sessionId === sid)).toEqual([]);
        });
        describe('host contextPruning switch', () => {
            async function runWithHostContextPruning(contextPruning?: boolean) {
                const client = new MockLLMClient([{ content: 'hello', stopReason: 'end_turn' }], 'openai');
                const oldToolResult = 'X'.repeat(80000);
                const messages = Array.from({ length: 4 }, (_, index) => [
                    {
                        type: 'assistant' as const,
                        content: `calling tool ${index + 1}`,
                        toolCalls: [
                            { id: `tc${index + 1}`, name: 'echo', arguments: '{}' },
                        ],
                        timestamp: new Date(),
                    },
                    {
                        type: 'tool' as const,
                        toolCallId: `tc${index + 1}`,
                        content: oldToolResult,
                        isError: false,
                        timestamp: new Date(),
                    },
                ]).flat();
                store.seed(COL_SESSIONS, {
                    _id: sid,
                    messages,
                    pendingInputs: [],
                });
                await enqueueInput(store, {
                    sessionId: sid,
                    content: 'continue',
                    userId: 'u',
                    userName: 'A',
                });
                const cfg: AgentHostConfig = {
                    docStore: store,
                    pubSub,
                    logger,
                    ...(contextPruning === undefined ? {} : { contextPruning }),
                    resolveAgentConfig: async () => ({
                        client,
                        systemPrompt: 'you are a test',
                        tools: [],
                        keyId: 'test-key',
                        contextWindow: 200000,
                    }),
                };
                const consumer = createConsumer({
                    config: cfg,
                    timings: {
                        ...INTERNAL_TIMINGS,
                        lockRenewMs: 100000,
                        scanIntervalMs: 100000,
                    },
                    consumerId: 'h-test',
                });
                await consumer.processSession(sid);
                const seenMessages = client.calls[0].messages as unknown as Array<{
                    type: string;
                    toolCallId?: string;
                    content?: string;
                }>;
                return seenMessages.find((message) => message.type === 'tool' && message.toolCallId === 'tc1')?.content;
            }
            it('defaults omitted contextPruning to true', async () => {
                const content = await runWithHostContextPruning(undefined);
                expect(content?.length).toBeLessThan(80000);
            });
            it('forwards contextPruning=false so old oversized tool results reach the LLM unchanged', async () => {
                const content = await runWithHostContextPruning(false);
                expect(content).toBe('X'.repeat(80000));
            });
        });
        it('forwards AgentConfig.contextWindow through to the LLM call: a 1,000,000 window leaves a 150k-char tool result untouched', async () => {
            const client = new MockLLMClient([{ content: 'hello', stopReason: 'end_turn' }], 'openai');
            const bigToolResult = 'X'.repeat(150000);
            store.seed(COL_SESSIONS, {
                _id: sid,
                messages: [
                    {
                        type: 'assistant',
                        content: 'calling tool',
                        toolCalls: [{ id: 'tc1', name: 'echo', arguments: '{}' }],
                        timestamp: new Date(),
                    },
                    {
                        type: 'tool',
                        toolCallId: 'tc1',
                        content: bigToolResult,
                        isError: false,
                        timestamp: new Date(),
                    },
                ],
                pendingInputs: [],
            });
            await enqueueInput(store, {
                sessionId: sid,
                content: 'continue',
                userId: 'u',
                userName: 'A',
            });
            const cfg: AgentHostConfig = {
                docStore: store,
                pubSub,
                logger,
                resolveAgentConfig: async () => ({
                    client,
                    systemPrompt: 'you are a test',
                    tools: [],
                    keyId: 'test-key',
                    contextWindow: 1000000,
                }),
            };
            const consumer = createConsumer({
                config: cfg,
                timings: { ...INTERNAL_TIMINGS, lockRenewMs: 100000, scanIntervalMs: 100000 },
                consumerId: 'h-test',
            });
            await consumer.processSession(sid);
            const seenMessages = client.calls[0].messages as unknown as Array<{
                type: string;
                toolCallId?: string;
                content?: string;
            }>;
            const tool1 = seenMessages.find((m) => m.type === 'tool' && m.toolCallId === 'tc1');
            expect(tool1?.content?.length).toBe(150000);
        });
        it('publishes broadcast events to pubSub during the turn', async () => {
            await enqueueInput(store, {
                sessionId: sid,
                content: 'hi',
                userId: 'u',
                userName: 'A',
            });
            const consumer = makeConsumer();
            await consumer.processSession(sid);
            const broadcasts = pubSub.published.filter((p) => p.channel.includes(`broadcast:session:${sid}`));
            expect(broadcasts.length).toBeGreaterThan(0);
            for (const b of broadcasts) {
                const parsed = JSON.parse(b.payload);
                expect(typeof parsed._eventId).toBe('number');
            }
        });
        it('clears events buffer after every mid-turn persist (snapshot+replay dedup)', async () => {
            await enqueueInput(store, {
                sessionId: sid,
                content: 'Use the tool',
                userId: 'u',
                userName: 'A',
            });
            const echo = (await import('../../__tests__/fixtures.js')).makeEchoTool();
            const scriptedClient = new MockLLMClient([
                { content: 'Calling', toolCalls: [{ id: 'tc1', name: 'echo', arguments: '{"text":"hi"}' }] },
                { content: 'Done.' },
            ], 'openai');
            const cfg: AgentHostConfig = {
                docStore: store,
                pubSub,
                logger,
                resolveAgentConfig: async () => ({
                    client: scriptedClient,
                    systemPrompt: 'you are a test',
                    tools: [echo],
                    keyId: 'test-key',
                }),
            };
            const consumer = createConsumer({
                config: cfg,
                timings: { ...INTERNAL_TIMINGS, lockRenewMs: 100000, scanIntervalMs: 100000 },
                consumerId: 'h-test',
            });
            const llm1TextDeltaSeqs: number[] = [];
            const eventsAfterLlm1Persist: Array<Record<string, unknown>> = [];
            const origChat = scriptedClient.chat.bind(scriptedClient);
            scriptedClient.chat = async (req) => {
                if (scriptedClient.calls.length === 1) {
                    const snapshot = store.dump(COL_EVENTS).filter((d) => 'sessionId' in d && d.sessionId === sid);
                    eventsAfterLlm1Persist.push(...(snapshot as Array<Record<string, unknown>>));
                    for (const row of eventsAfterLlm1Persist) {
                        const payload = JSON.parse(row.payload as string);
                        if (payload.type === 'text_delta')
                            llm1TextDeltaSeqs.push(row.seq as number);
                    }
                }
                return origChat(req);
            };
            await consumer.processSession(sid);
            expect(llm1TextDeltaSeqs).toEqual([]);
            const evDocsAfter = store
                .dump(COL_EVENTS)
                .filter((d) => 'sessionId' in d && d.sessionId === sid);
            expect(evDocsAfter).toEqual([]);
        });
    });
    describe('per-turn guardrail configuration', () => {
        it('forwards AgentConfig.guardrailConfig into the low-level turn runtime', async () => {
            await enqueueInput(store, {
                sessionId: sid,
                content: 'send three updates',
                userId: 'u',
                userName: 'A',
            });
            const send = (await import('../../__tests__/fixtures.js')).makeEchoTool('send_message');
            const client = new MockLLMClient([
                { toolCalls: [{ id: 's1', name: 'send_message', arguments: '{"text":"one"}' }] },
                { toolCalls: [{ id: 's2', name: 'send_message', arguments: '{"text":"two"}' }] },
                { toolCalls: [{ id: 's3', name: 'send_message', arguments: '{"text":"three"}' }] },
                { content: 'done', stopReason: 'end_turn' },
            ], 'openai');
            const consumer = makeConsumer(async () => ({
                client,
                systemPrompt: 'you are a test',
                tools: [send],
                keyId: 'test-key',
                guardrailConfig: {
                    consecutiveSuccessTools: {
                        send_message: { warn: 3, message: 'Members already saw the prior messages.' },
                    },
                },
            }));
            await consumer.processSession(sid);
            const doc = store.inspect(COL_SESSIONS, sid) as {
                messages: Array<{
                    type: string;
                    toolCallId?: string;
                    content?: string;
                    guidance?: unknown[];
                }>;
            };
            const third = doc.messages.find((message) => message.toolCallId === 's3');
            expect(third?.content).toContain('Members already saw the prior messages.');
            expect(third?.guidance).toEqual([{
                    kind: 'tool_loop_warning',
                    warningType: 'consecutive_success',
                    toolName: 'send_message',
                    count: 3,
                    message: 'Members already saw the prior messages.',
                }]);
        });
    });
    describe('idempotency / draining', () => {
        it('does nothing when pendingInputs is empty', async () => {
            store.seed(COL_SESSIONS, { _id: sid, messages: [], pendingInputs: [] });
            const consumer = makeConsumer();
            await consumer.processSession(sid);
            const doc = store.inspect(COL_SESSIONS, sid) as {
                messages: unknown[];
                activeRun?: unknown;
            };
            expect(doc.messages).toEqual([]);
            expect(doc.activeRun).toBeUndefined();
        });
        it('refuses new work after startDraining', async () => {
            await enqueueInput(store, {
                sessionId: sid,
                content: 'hi',
                userId: 'u',
                userName: 'A',
            });
            const consumer = makeConsumer();
            consumer.startDraining();
            expect(consumer.isDraining).toBe(true);
            await consumer.processSession(sid);
            const doc = store.inspect(COL_SESSIONS, sid) as {
                pendingInputs: unknown[];
            };
            expect(doc.pendingInputs).toHaveLength(1);
        });
        it('skips when another holder owns the lock', async () => {
            await enqueueInput(store, {
                sessionId: sid,
                content: 'hi',
                userId: 'u',
                userName: 'A',
            });
            await acquireLock(store, {
                sessionId: sid,
                holder: 'other-pod',
                turnId: 't0',
                ttlMs: 60000,
            });
            const consumer = makeConsumer();
            await consumer.processSession(sid);
            const doc = store.inspect(COL_SESSIONS, sid) as {
                activeRun: {
                    holder: string;
                };
                pendingInputs: unknown[];
            };
            expect(doc.activeRun.holder).toBe('other-pod');
            expect(doc.pendingInputs).toHaveLength(1);
        });
        it('processSession on empty queue after a turn is a clean no-op', async () => {
            await enqueueInput(store, {
                sessionId: sid,
                content: 'hi',
                userId: 'u',
                userName: 'A',
            });
            const consumer = makeConsumer();
            await consumer.processSession(sid);
            await consumer.processSession(sid);
            const doc = store.inspect(COL_SESSIONS, sid) as {
                messages: Array<{
                    type: string;
                }>;
                activeRun?: unknown;
            };
            const assistantCount = doc.messages.filter((m) => m.type === 'assistant').length;
            expect(assistantCount).toBe(1);
            expect(doc.activeRun).toBeUndefined();
        });
        it('host hook sets exit="skip" → multi-turn loop breaks without starting a follow-up turn (Beta 6/25 @-human bug)', async () => {
            let llmCallCount = 0;
            const client = new MockLLMClient([{ content: 'hi back', stopReason: 'end_turn' }], 'openai');
            const countingClient = {
                getProviderName: () => client.getProviderName(),
                getModelName: () => client.getModelName(),
                chat: async (...args: Parameters<typeof client.chat>) => {
                    llmCallCount++;
                    return client.chat(...args);
                },
            };
            await enqueueInput(store, {
                sessionId: sid,
                content: '<mention userId="bob" />',
                userId: 'alice',
                userName: 'Alice',
            });
            const consumer = createConsumer({
                config: {
                    docStore: store,
                    pubSub,
                    logger,
                    resolveAgentConfig: async () => ({
                        client: countingClient as unknown as typeof client,
                        systemPrompt: 'test',
                        tools: [],
                        keyId: 'k',
                        hooks: {
                            afterFetch: (state) => {
                                state.exit = { kind: 'skip' };
                            },
                        },
                    }),
                },
                timings: INTERNAL_TIMINGS,
                consumerId: 'test-consumer',
            });
            await consumer.processSession(sid);
            expect(llmCallCount).toBe(0);
            const doc = store.inspect(COL_SESSIONS, sid) as {
                messages: Array<{
                    type: string;
                }>;
                pendingInputs: unknown[];
                activeRun?: unknown;
            };
            expect(doc.pendingInputs).toEqual([]);
            const assistantCount = doc.messages.filter((m) => m.type === 'assistant').length;
            expect(assistantCount).toBe(0);
            expect(doc.messages[doc.messages.length - 1]?.type).toBe('event');
            expect(doc.activeRun).toBeUndefined();
        });
    });
    describe('graceful shutdown handoff', () => {
        it('signals draining mid-turn → next LLM call short-circuits → lock released + trigger published', async () => {
            await enqueueInput(store, {
                sessionId: sid,
                content: 'hi',
                userId: 'u',
                userName: 'A',
            });
            let consumer!: ReturnType<typeof createConsumer>;
            const drainTriggeringTool = {
                name: 'shutdown_trigger',
                description: 'Pretends to do work, actually triggers SIGTERM mid-turn',
                inputSchema: { type: 'object' as const, properties: {} },
                execute: async () => {
                    consumer.startDraining();
                    return 'simulated SIGTERM fired';
                },
            };
            const client = new MockLLMClient([
                {
                    toolCalls: [{ id: 't1', name: 'shutdown_trigger', arguments: '{}' }],
                    stopReason: 'tool_use',
                },
                { content: 'should not be reached', stopReason: 'end_turn' },
            ], 'openai');
            consumer = createConsumer({
                config: {
                    docStore: store,
                    pubSub,
                    logger,
                    resolveAgentConfig: async () => ({
                        client,
                        systemPrompt: 'test',
                        tools: [drainTriggeringTool],
                        keyId: 'k',
                    }),
                },
                timings: { ...INTERNAL_TIMINGS, lockRenewMs: 100000, scanIntervalMs: 100000 },
                consumerId: 'h-test',
            });
            await consumer.processSession(sid);
            expect(client.calls).toHaveLength(1);
            const triggers = pubSub.published.filter((p) => p.channel === `trigger:session:${sid}`);
            expect(triggers.length).toBeGreaterThanOrEqual(1);
            const doc = store.inspect(COL_SESSIONS, sid) as {
                activeRun?: unknown;
            };
            expect(doc.activeRun).toBeUndefined();
        });
        it('startDraining before processSession → silent return (no work picked up)', async () => {
            await enqueueInput(store, {
                sessionId: sid,
                content: 'hi',
                userId: 'u',
                userName: 'A',
            });
            const consumer = makeConsumer();
            consumer.startDraining();
            await consumer.processSession(sid);
            const doc = store.inspect(COL_SESSIONS, sid) as {
                pendingInputs: unknown[];
                activeRun?: unknown;
            };
            expect(doc.pendingInputs).toHaveLength(1);
            expect(doc.activeRun).toBeUndefined();
        });
    });
    describe('stall detection (pre-turn / in-turn)', () => {
        it('stops renewing the lock when pre-turn hang exceeds preTurnStallMs', async () => {
            await enqueueInput(store, {
                sessionId: sid,
                content: 'hi',
                userId: 'u',
                userName: 'A',
            });
            let resolveStarted = false;
            const consumer = createConsumer({
                config: {
                    docStore: store,
                    pubSub,
                    logger,
                    resolveAgentConfig: async () => {
                        resolveStarted = true;
                        await new Promise(() => { });
                        throw new Error('unreachable');
                    },
                },
                timings: {
                    ...INTERNAL_TIMINGS,
                    lockRenewMs: 30,
                    preTurnStallMs: 100,
                    inTurnStallMs: 100000,
                    scanIntervalMs: 100000,
                },
                consumerId: 'h-stall',
            });
            void consumer.processSession(sid);
            const t0 = Date.now();
            while (!resolveStarted && Date.now() - t0 < 2000) {
                await new Promise((r) => setTimeout(r, 5));
            }
            expect(resolveStarted).toBe(true);
            await new Promise((r) => setTimeout(r, 250));
            const stallLog = logger.records.find((r) => r.level === 'error' &&
                JSON.stringify(r.args).includes('stall detected'));
            expect(stallLog).toBeDefined();
            const argsStr = JSON.stringify(stallLog!.args);
            expect(argsStr).toContain('pre-turn-stall');
            expect(argsStr).toContain('"firstEventSeen":false');
            await new Promise((r) => setTimeout(r, 200));
            const stallLogs = logger.records.filter((r) => r.level === 'error' &&
                JSON.stringify(r.args).includes('stall detected'));
            expect(stallLogs).toHaveLength(1);
            const doc = store.inspect(COL_SESSIONS, sid) as {
                activeRun?: {
                    turnId: string;
                    acquiredAt?: Date;
                    expiresAt: Date;
                };
            };
            expect(doc.activeRun).toBeDefined();
            expect(doc.activeRun!.turnId).toBeTruthy();
            expect(doc.activeRun!.turnId).not.toBe('pre-turn');
            expect(doc.activeRun!.acquiredAt).toBeInstanceOf(Date);
        });
        it('does NOT trip stall detection during a normal turn (firstEventSeen=true short-circuits pre-turn check)', async () => {
            await enqueueInput(store, {
                sessionId: sid,
                content: 'hi',
                userId: 'u',
                userName: 'A',
            });
            const consumer = createConsumer({
                config: {
                    docStore: store,
                    pubSub,
                    logger,
                    resolveAgentConfig: async () => ({
                        client: new MockLLMClient([{ content: 'reply', stopReason: 'end_turn' }], 'openai'),
                        systemPrompt: 'you are a test',
                        tools: [],
                        keyId: 'test-key',
                    }),
                },
                timings: {
                    ...INTERNAL_TIMINGS,
                    lockRenewMs: 50,
                    preTurnStallMs: 1,
                    inTurnStallMs: 60000,
                    scanIntervalMs: 100000,
                },
                consumerId: 'h-normal',
            });
            await consumer.processSession(sid);
            const doc = store.inspect(COL_SESSIONS, sid) as {
                pendingInputs: unknown[];
                activeRun?: unknown;
            };
            expect(doc.activeRun).toBeUndefined();
            expect(doc.pendingInputs).toEqual([]);
            const stallLog = logger.records.find((r) => r.level === 'error' &&
                JSON.stringify(r.args).includes('stall detected'));
            expect(stallLog).toBeUndefined();
        });
        it('stamps activeRun.acquiredAt on lock acquire (anchor for ops queries)', async () => {
            await enqueueInput(store, {
                sessionId: sid,
                content: 'hi',
                userId: 'u',
                userName: 'A',
            });
            const before = Date.now();
            let release: () => void = () => { };
            const blocker = new Promise<void>((r) => (release = r));
            const consumer = createConsumer({
                config: {
                    docStore: store,
                    pubSub,
                    logger,
                    resolveAgentConfig: async () => {
                        await blocker;
                        throw new Error('abort the turn after we inspect');
                    },
                },
                timings: { ...INTERNAL_TIMINGS, lockRenewMs: 100000, scanIntervalMs: 100000 },
                consumerId: 'h-acq',
            });
            const turnDone = consumer.processSession(sid);
            const t0 = Date.now();
            while (Date.now() - t0 < 500) {
                const d = store.inspect(COL_SESSIONS, sid) as {
                    activeRun?: unknown;
                };
                if (d.activeRun)
                    break;
                await new Promise((r) => setTimeout(r, 5));
            }
            const doc = store.inspect(COL_SESSIONS, sid) as {
                activeRun?: {
                    holder: string;
                    turnId: string;
                    acquiredAt?: Date;
                    expiresAt: Date;
                };
            };
            expect(doc.activeRun).toBeDefined();
            expect(doc.activeRun!.turnId).toBeTruthy();
            expect(doc.activeRun!.turnId).not.toBe('pre-turn');
            expect(doc.activeRun!.acquiredAt).toBeInstanceOf(Date);
            const aAt = doc.activeRun!.acquiredAt!.getTime();
            expect(aAt).toBeGreaterThanOrEqual(before);
            expect(aAt).toBeLessThanOrEqual(Date.now());
            release();
            await turnDone;
        });
    });
});
