import { describe, it, expect, beforeEach } from 'vitest';
import { createConsumer } from '../consumer.js';
import { enqueueInput } from '../pending-inputs.js';
import { COL_EVENTS, COL_SESSIONS, COL_SUBAGENT_RUNS, subagentBroadcastChannel, subagentEventStreamId, } from '../schema.js';
import { INTERNAL_TIMINGS } from '../types.js';
import { createDocStoreSubagentStore, SUBAGENT_CANCEL_CHANNEL_PREFIX } from '../subagent-store.js';
import { cancelSubagentInProcessByToolCallId } from '../../tools/builtin/subagent.js';
import { createMemoryDocStore, createMemoryPubSub, createMockLogger, type MockMemoryDocStore, type MockPubSub, type MockLogger, } from './fixtures.js';
import { MockLLMClient, makeEchoTool } from '../../__tests__/fixtures.js';
import type { AgentHostConfig } from '../types.js';
import type { SubagentProfile, Tool } from '../../types.js';
describe('host/subagent integration', () => {
    let store: MockMemoryDocStore;
    let pubSub: MockPubSub;
    let logger: MockLogger;
    const sid = '6a578ed9dfbbd4db915d6987';
    beforeEach(() => {
        store = createMemoryDocStore();
        pubSub = createMemoryPubSub();
        logger = createMockLogger();
    });
    it('happy-path: subagentProfiles in AgentConfig runs subagent + clears anchor', async () => {
        const parentClient = new MockLLMClient([
            {
                toolCalls: [
                    {
                        id: 'toolu_happy',
                        name: 'subagent',
                        arguments: JSON.stringify({
                            task: 'find something',
                            mode: 'explore',
                        }),
                    },
                ],
            },
            { content: 'Parent got: X.' },
        ], 'openai');
        const subClient = new MockLLMClient([
            {
                toolCalls: [
                    {
                        id: 'toolu_sub',
                        name: 'echo',
                        arguments: JSON.stringify({ text: 'inside subagent' }),
                    },
                ],
            },
            { content: 'Subagent found X on line 42.' },
        ], 'openai');
        const echo: Tool = makeEchoTool('echo');
        const childUsageEntries: Array<{
            sessionId: string;
            numLLMCalls: number;
            inputTokens: number;
            outputTokens: number;
        }> = [];
        const profile: SubagentProfile = {
            name: 'explore',
            description: 'read-only research',
            rolePrompt: 'You are the explore subagent.',
            tools: [echo],
            client: subClient,
            createUsageRecorder: (context) => {
                expect(context.sessionId).toBe(sid);
                expect(context.toolCallId).toBe('toolu_happy');
                expect(context.parentTurnId).toBeTruthy();
                expect(context.subagentId).toMatch(/^[0-9a-f]{24}$/);
                return {
                    record: async (entry) => childUsageEntries.push({
                        sessionId: entry.sessionId,
                        numLLMCalls: entry.numLLMCalls,
                        inputTokens: entry.inputTokens,
                        outputTokens: entry.outputTokens,
                    }),
                };
            },
            profileVariant: 'base',
            resolveVariant: async ({ toolCallId }) => ({
                name: 'explore',
                description: 'read-only research',
                rolePrompt: 'You are the experiment variant.',
                tools: [echo],
                client: subClient,
                profileVariant: `bucket:${toolCallId}`,
            }),
        };
        const subagentStore = createDocStoreSubagentStore(store);
        const cfg: AgentHostConfig = {
            docStore: store,
            pubSub,
            logger,
            resolveAgentConfig: async () => ({
                client: parentClient,
                systemPrompt: 'you are the parent',
                tools: [],
                keyId: 'test-key',
                subagentProfiles: [profile],
            }),
        };
        const consumer = createConsumer({
            config: cfg,
            timings: { ...INTERNAL_TIMINGS, lockRenewMs: 100000, scanIntervalMs: 100000 },
            consumerId: 'h-test',
            subagentStore,
        });
        await enqueueInput(store, { sessionId: sid, content: 'go', userId: 'u' });
        await consumer.processSession(sid);
        const session = store.inspect(COL_SESSIONS, sid) as {
            activeSubagentTurn?: unknown;
        } | undefined;
        expect(session?.activeSubagentTurn).toBeUndefined();
        const runs = store.dump(COL_SUBAGENT_RUNS);
        expect(runs).toHaveLength(1);
        expect((runs[0] as {
            status: string;
        }).status).toBe('complete');
        expect((runs[0] as {
            profileName: string;
        }).profileName).toBe('explore');
        expect((runs[0] as {
            toolCallId: string;
        }).toolCallId).toBe('toolu_happy');
        expect((runs[0] as {
            profileVariant?: string;
        }).profileVariant).toBe('bucket:toolu_happy');
        expect(childUsageEntries).toHaveLength(1);
        expect(childUsageEntries[0]).toMatchObject({ sessionId: sid, numLLMCalls: 2, inputTokens: 200, outputTokens: 40 });
        const childChannel = subagentBroadcastChannel('', sid, 'toolu_happy');
        const childFrames = pubSub.published
            .filter((p) => p.channel === childChannel)
            .map((p) => JSON.parse(p.payload) as {
            type: string;
            _eventId?: number;
        });
        expect(childFrames.length).toBeGreaterThan(3);
        expect(childFrames[0]?.type).toBe('turn_start');
        expect(childFrames.at(-1)?.type).toBe('turn_end');
        const ids = childFrames.map((event) => event._eventId);
        expect(ids.every((id) => typeof id === 'number')).toBe(true);
        expect(ids).toEqual([...ids].sort((a, b) => (a ?? 0) - (b ?? 0)));
        expect(new Set(ids).size).toBe(ids.length);
        const replayThroughSeq = (runs[0] as {
            replayThroughSeq?: number;
        }).replayThroughSeq;
        expect(replayThroughSeq).toBeTypeOf('number');
        expect(replayThroughSeq).toBeGreaterThan(0);
        expect(replayThroughSeq).toBeLessThan(childFrames.at(-1)!._eventId!);
        const childStreamId = subagentEventStreamId(sid, 'toolu_happy');
        const childEventRows = store
            .dump(COL_EVENTS)
            .filter((row) => row.sessionId === childStreamId);
        expect(childEventRows).toEqual([]);
    });
    it('host-managed tool delegates execution and preserves persistence + clears anchor', async () => {
        const parentClient = new MockLLMClient([
            {
                toolCalls: [
                    {
                        id: 'toolu_happy',
                        name: 'subagent',
                        arguments: JSON.stringify({
                            task: 'find something',
                            mode: 'explore',
                        }),
                    },
                ],
            },
            { content: 'Parent got: X.' },
        ], 'openai');
        const subClient = new MockLLMClient([
            {
                toolCalls: [
                    {
                        id: 'toolu_sub',
                        name: 'echo',
                        arguments: JSON.stringify({ text: 'inside subagent' }),
                    },
                ],
            },
            { content: 'Subagent found X on line 42.' },
        ], 'openai');
        const echo: Tool = makeEchoTool('echo');
        const profile: SubagentProfile = {
            name: 'explore',
            description: 'read-only research',
            rolePrompt: 'You are the explore subagent.',
            tools: [echo],
            client: subClient,
            profileVariant: 'base',
            resolveVariant: async ({ toolCallId }) => ({
                name: 'explore',
                description: 'read-only research',
                rolePrompt: 'You are the experiment variant.',
                tools: [echo],
                client: subClient,
                profileVariant: `bucket:${toolCallId}`,
            }),
        };
        const subagentStore = createDocStoreSubagentStore(store);
        const cfg: AgentHostConfig = {
            docStore: store,
            pubSub,
            logger,
            resolveAgentConfig: async () => ({
                client: parentClient,
                systemPrompt: 'you are the parent',
                tools: [{
                        name: 'subagent', description: 'host-owned schema', inputSchema: { type: 'object' },
                        execute: (input, ctx) => ctx.executeSubagent!(input),
                    }],
                keyId: 'test-key',
                subagentProfiles: [profile],
                subagentHostManagedTool: true,
            }),
        };
        const consumer = createConsumer({
            config: cfg,
            timings: { ...INTERNAL_TIMINGS, lockRenewMs: 100000, scanIntervalMs: 100000 },
            consumerId: 'h-test',
            subagentStore,
        });
        await enqueueInput(store, { sessionId: sid, content: 'go', userId: 'u' });
        await consumer.processSession(sid);
        const session = store.inspect(COL_SESSIONS, sid) as {
            activeSubagentTurn?: unknown;
        } | undefined;
        expect(session?.activeSubagentTurn).toBeUndefined();
        const runs = store.dump(COL_SUBAGENT_RUNS);
        expect(runs).toHaveLength(1);
        expect((runs[0] as {
            status: string;
        }).status).toBe('complete');
        expect((runs[0] as {
            profileName: string;
        }).profileName).toBe('explore');
        expect((runs[0] as {
            toolCallId: string;
        }).toolCallId).toBe('toolu_happy');
        expect((runs[0] as {
            profileVariant?: string;
        }).profileVariant).toBe('bucket:toolu_happy');
        const childChannel = subagentBroadcastChannel('', sid, 'toolu_happy');
        const childFrames = pubSub.published
            .filter((p) => p.channel === childChannel)
            .map((p) => JSON.parse(p.payload) as {
            type: string;
            _eventId?: number;
        });
        expect(childFrames.length).toBeGreaterThan(3);
        expect(childFrames[0]?.type).toBe('turn_start');
        expect(childFrames.at(-1)?.type).toBe('turn_end');
        const ids = childFrames.map((event) => event._eventId);
        expect(ids.every((id) => typeof id === 'number')).toBe(true);
        expect(ids).toEqual([...ids].sort((a, b) => (a ?? 0) - (b ?? 0)));
        expect(new Set(ids).size).toBe(ids.length);
        const replayThroughSeq = (runs[0] as {
            replayThroughSeq?: number;
        }).replayThroughSeq;
        expect(replayThroughSeq).toBeTypeOf('number');
        expect(replayThroughSeq).toBeGreaterThan(0);
        expect(replayThroughSeq).toBeLessThan(childFrames.at(-1)!._eventId!);
        const childStreamId = subagentEventStreamId(sid, 'toolu_happy');
        const childEventRows = store
            .dump(COL_EVENTS)
            .filter((row) => row.sessionId === childStreamId);
        expect(childEventRows).toEqual([]);
    });
    it('missing profiles => host runs normally, subagent tool absent', async () => {
        const parentClient = new MockLLMClient([{ content: 'no subagent needed' }], 'openai');
        const subagentStore = createDocStoreSubagentStore(store);
        const cfg: AgentHostConfig = {
            docStore: store,
            pubSub,
            logger,
            resolveAgentConfig: async () => ({
                client: parentClient,
                systemPrompt: 'you are the parent',
                tools: [],
                keyId: 'test-key',
            }),
        };
        const consumer = createConsumer({
            config: cfg,
            timings: { ...INTERNAL_TIMINGS, lockRenewMs: 100000, scanIntervalMs: 100000 },
            consumerId: 'h-test',
            subagentStore,
        });
        await enqueueInput(store, { sessionId: sid, content: 'go', userId: 'u' });
        await consumer.processSession(sid);
        expect(store.dump(COL_SUBAGENT_RUNS)).toHaveLength(0);
        const session = store.inspect(COL_SESSIONS, sid) as {
            activeSubagentTurn?: unknown;
        } | undefined;
        expect(session?.activeSubagentTurn).toBeUndefined();
        const doc = store.inspect(COL_SESSIONS, sid) as {
            messages?: Array<{
                type: string;
                content?: string;
            }>;
        } | undefined;
        const lastAssistant = doc?.messages
            ?.slice()
            .reverse()
            .find((m) => m.type === 'assistant');
        expect(lastAssistant?.content).toBe('no subagent needed');
    });
    it('cross-pod cancel: pubSub.publish subagent-cancel:<toolCallId> aborts local controller', async () => {
        const { activeSubagents, cancelKey } = (await import('../../tools/builtin/subagent.js')).__testInternals;
        const ctrl = new AbortController();
        activeSubagents.set(cancelKey('some-session', 'toolu_cancel_me'), ctrl);
        const channel = `${SUBAGENT_CANCEL_CHANNEL_PREFIX}toolu_cancel_me`;
        const toolCallId = channel.slice(SUBAGENT_CANCEL_CHANNEL_PREFIX.length);
        const found = cancelSubagentInProcessByToolCallId(toolCallId);
        expect(found).toBe(true);
        expect(ctrl.signal.aborted).toBe(true);
        activeSubagents.clear();
    });
    it('cross-pod cancel: broadcast on wrong pod is safe no-op', async () => {
        const found = cancelSubagentInProcessByToolCallId('does-not-exist');
        expect(found).toBe(false);
    });
    it('AgentConfig.subagentInputOverride reaches the tool through consumer.ts wiring', async () => {
        const parentClient = new MockLLMClient([
            {
                toolCalls: [
                    {
                        id: 'toolu_override',
                        name: 'subagent',
                        arguments: JSON.stringify({ task: '/workspace/task.md' }),
                    },
                ],
            },
            { content: 'Parent done.' },
        ], 'openai');
        const subClient = new MockLLMClient([{ content: 'resolved task done.' }], 'openai');
        const profile: SubagentProfile = {
            name: 'explore',
            description: 'read-only research',
            rolePrompt: 'You are the explore subagent.',
            tools: [],
            client: subClient,
        };
        const subagentStore = createDocStoreSubagentStore(store);
        const resolveInputCalls: Array<{
            task: string;
            context?: string;
        }> = [];
        const cfg: AgentHostConfig = {
            docStore: store,
            pubSub,
            logger,
            resolveAgentConfig: async () => ({
                client: parentClient,
                systemPrompt: 'you are the parent',
                tools: [],
                keyId: 'test-key',
                subagentProfiles: [profile],
                subagentInputOverride: {
                    resolveInput: async (raw) => {
                        resolveInputCalls.push(raw);
                        return { task: `RESOLVED(${raw.task})`, context: raw.context };
                    },
                    taskDescription: 'must be a sandbox absolute file path',
                },
            }),
        };
        const consumer = createConsumer({
            config: cfg,
            timings: { ...INTERNAL_TIMINGS, lockRenewMs: 100000, scanIntervalMs: 100000 },
            consumerId: 'h-test',
            subagentStore,
        });
        await enqueueInput(store, { sessionId: sid, content: 'go', userId: 'u' });
        await consumer.processSession(sid);
        expect(resolveInputCalls).toEqual([
            { task: '/workspace/task.md', context: undefined },
        ]);
        const runs = store.dump(COL_SUBAGENT_RUNS);
        expect(runs).toHaveLength(1);
        expect((runs[0] as {
            task: string;
        }).task).toBe('RESOLVED(/workspace/task.md)');
    });
    it('AgentConfig.largeToolResult forwards into the child runtime (2026-07-23 fix)', async () => {
        const parentClient = new MockLLMClient([
            {
                toolCalls: [
                    {
                        id: 'toolu_big',
                        name: 'subagent',
                        arguments: JSON.stringify({ task: 'read the big file' }),
                    },
                ],
            },
            { content: 'Parent got the summary.' },
        ], 'openai');
        const BIG_CONTENT = 'x'.repeat(500);
        const bigTool: Tool = {
            name: 'read_big_file',
            description: 'Returns a huge blob',
            inputSchema: { type: 'object', properties: {} },
            execute: async () => BIG_CONTENT,
        };
        const subClient = new MockLLMClient([
            {
                toolCalls: [{ id: 'toolu_read', name: 'read_big_file', arguments: '{}' }],
            },
            { content: 'Read the file, summarized.' },
        ], 'openai');
        const profile: SubagentProfile = {
            name: 'explore',
            description: 'read-only research',
            rolePrompt: 'You are the explore subagent.',
            tools: [bigTool],
            client: subClient,
        };
        const subagentStore = createDocStoreSubagentStore(store);
        const writes: Array<{
            name: string;
            size: number;
        }> = [];
        const cfg: AgentHostConfig = {
            docStore: store,
            pubSub,
            logger,
            resolveAgentConfig: async () => ({
                client: parentClient,
                systemPrompt: 'you are the parent',
                tools: [],
                keyId: 'test-key',
                subagentProfiles: [profile],
                largeToolResult: {
                    thresholdChars: 100,
                    previewChars: 20,
                    store: {
                        write: async (name: string, content: string) => {
                            writes.push({ name, size: content.length });
                            return { uri: `mock://${name}/${writes.length}` };
                        },
                    },
                },
            }),
        };
        const consumer = createConsumer({
            config: cfg,
            timings: { ...INTERNAL_TIMINGS, lockRenewMs: 100000, scanIntervalMs: 100000 },
            consumerId: 'h-test',
            subagentStore,
        });
        await enqueueInput(store, { sessionId: sid, content: 'go', userId: 'u' });
        await consumer.processSession(sid);
        expect(writes).toHaveLength(1);
        expect(writes[0]).toMatchObject({ name: 'read_big_file', size: BIG_CONTENT.length });
        const runs = store.dump(COL_SUBAGENT_RUNS);
        expect(runs).toHaveLength(1);
        const subMessages = (runs[0] as {
            messages: Array<{
                type: string;
                content?: string;
            }>;
        }).messages;
        const toolResultMsg = subMessages.find((m) => m.type === 'tool');
        expect(toolResultMsg?.content).toContain('stored externally');
        expect(toolResultMsg?.content).not.toBe(BIG_CONTENT);
    });
});
