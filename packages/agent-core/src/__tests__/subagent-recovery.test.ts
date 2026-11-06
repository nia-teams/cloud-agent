import { ObjectId } from '../host/__tests__/object-id.js';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { AgentRuntime } from '../runtime.js';
import { MockLLMClient, MemoryStore, makeEchoTool, } from './fixtures.js';
import type { ActiveSubagentTurn, AgentMessage, AssistantMessage, SubagentProfile, SubagentRunDoc, SubagentStore, } from '../types.js';
class MemorySubagentStore implements SubagentStore {
    public runs = new Map<string, SubagentRunDoc>();
    public activeAnchors = new Map<string, ActiveSubagentTurn>();
    public findByToolCallIdOverride?: (sessionId: string, toolCallId: string) => Promise<SubagentRunDoc | null>;
    public onFinalize: Array<(input: {
        subagentId: string;
        sessionId: string;
        status: string;
    }) => void> = [];
    private nextId = 1;
    async insertRun(input: {
        sessionId: string;
        parentTurnId: string;
        parentAssistantSnapshot: AssistantMessage;
        toolCallId: string;
        profileName: string;
        task: string;
        resumedFrom?: string;
        initialMessages: AgentMessage[];
    }): Promise<{
        subagentId: string;
    }> {
        const subagentOid = new ObjectId();
        const subagentId = subagentOid.toHexString();
        this.runs.set(subagentId, {
            subagentId,
            sessionId: input.sessionId,
            parentTurnId: input.parentTurnId,
            toolCallId: input.toolCallId,
            profileName: input.profileName,
            task: input.task,
            messages: [...input.initialMessages],
            status: 'running',
            resumedFrom: input.resumedFrom,
        });
        const existing = this.activeAnchors.get(input.sessionId);
        if (!existing) {
            this.activeAnchors.set(input.sessionId, {
                parentTurnId: input.parentTurnId,
                parentAssistantSnapshot: input.parentAssistantSnapshot,
                runIds: [subagentOid],
            });
        }
        else {
            if (!existing.runIds.some((oid) => oid.equals(subagentOid))) {
                existing.runIds.push(subagentOid);
            }
        }
        return { subagentId };
    }
    async appendMessages(subagentId: string, msgs: AgentMessage[]): Promise<void> {
        const doc = this.runs.get(subagentId);
        if (!doc)
            return;
        doc.messages.push(...msgs);
    }
    async findByToolCallId(sessionId: string, toolCallId: string): Promise<SubagentRunDoc | null> {
        if (this.findByToolCallIdOverride) {
            return this.findByToolCallIdOverride(sessionId, toolCallId);
        }
        for (const doc of this.runs.values()) {
            if (doc.sessionId === sessionId && doc.toolCallId === toolCallId) {
                return doc;
            }
        }
        return null;
    }
    async finalize(input: {
        subagentId: string;
        sessionId: string;
        status: 'complete' | 'cancelled' | 'error';
    }): Promise<void> {
        for (const fn of this.onFinalize)
            fn(input);
        const doc = this.runs.get(input.subagentId);
        if (doc)
            doc.status = input.status;
        const anchor = this.activeAnchors.get(input.sessionId);
        if (anchor) {
            const targetOid = new ObjectId(input.subagentId);
            anchor.runIds = anchor.runIds.filter((oid) => !oid.equals(targetOid));
            if (anchor.runIds.length === 0)
                this.activeAnchors.delete(input.sessionId);
        }
    }
    async readActiveSubagentTurn(sessionId: string): Promise<ActiveSubagentTurn | null> {
        return this.activeAnchors.get(sessionId) ?? null;
    }
    async updateLastBlock(): Promise<void> {
    }
}
function makeSubagentProfile(name: string, client: MockLLMClient, tools = [makeEchoTool('echo')]): SubagentProfile {
    return {
        name,
        description: `${name} mode`,
        rolePrompt: `You are the ${name} subagent.`,
        tools,
        client,
    };
}
function assistantSnapshot(toolCallId: string, args: Record<string, unknown>, turnId = 'parent-turn-1'): AssistantMessage {
    return {
        type: 'assistant',
        content: '',
        turnId,
        timestamp: new Date(),
        toolCalls: [
            {
                id: toolCallId,
                type: 'tool_use',
                name: 'subagent',
                arguments: JSON.stringify(args),
            },
        ],
    };
}
describe('subagent recovery + handoff', () => {
    let sessionId: string;
    let parentStore: MemoryStore;
    let subagentStore: MemorySubagentStore;
    let parentClient: MockLLMClient;
    let subagentClient: MockLLMClient;
    beforeEach(() => {
        sessionId = 'sess-1';
        parentStore = new MemoryStore([
            {
                type: 'event',
                eventType: 'message.received',
                content: 'Please find X',
                timestamp: new Date(),
            },
        ]);
        subagentStore = new MemorySubagentStore();
        parentClient = new MockLLMClient([]);
        subagentClient = new MockLLMClient([]);
    });
    it('A · normal happy-path: subagent completes, tool_result persisted, anchor cleared', async () => {
        parentClient.reset([
            {
                toolCalls: [
                    {
                        id: 'toolu_A',
                        name: 'subagent',
                        arguments: JSON.stringify({ task: 'find X', mode: 'explore' }),
                    },
                ],
            },
            { content: 'Done, X is here.' },
        ]);
        subagentClient.reset([
            {
                toolCalls: [
                    { id: 'toolu_S1', name: 'echo', arguments: JSON.stringify({ text: 'hi' }) },
                ],
            },
            { content: 'X is on line 5.' },
        ]);
        const runtime = new AgentRuntime({
            store: parentStore,
            sessionId,
        });
        await runtime.run({
            client: parentClient,
            systemPrompt: 'parent',
            tools: [],
            keyId: 'k1',
            subagent: {
                profiles: [makeSubagentProfile('explore', subagentClient)],
                store: subagentStore,
            },
        });
        expect(subagentStore.activeAnchors.has(sessionId)).toBe(false);
        const runDoc = Array.from(subagentStore.runs.values())[0];
        expect(runDoc.status).toBe('complete');
        expect(runDoc.toolCallId).toBe('toolu_A');
        expect(runDoc.profileName).toBe('explore');
        const persistedAfter = parentStore.stored.filter((m) => m.type !== 'event');
        expect(persistedAfter[0].type).toBe('assistant');
        expect((persistedAfter[0] as AssistantMessage).toolCalls?.[0].id).toBe('toolu_A');
        expect(persistedAfter[1].type).toBe('tool');
        expect(persistedAfter[2].type).toBe('assistant');
        expect((persistedAfter[2] as AssistantMessage).content).toBe('Done, X is here.');
    });
    it('A2 · publishChildEvent (Tap 2): fires for every child event, unfiltered, alongside the Tap 1 whitelist forward', async () => {
        parentClient.reset([
            {
                toolCalls: [
                    {
                        id: 'toolu_A2',
                        name: 'subagent',
                        arguments: JSON.stringify({ task: 'find X', mode: 'explore' }),
                    },
                ],
            },
            { content: 'Done, X is here.' },
        ]);
        subagentClient.reset([
            {
                toolCalls: [
                    { id: 'toolu_S1', name: 'echo', arguments: JSON.stringify({ text: 'hi' }) },
                ],
            },
            { content: 'X is on line 5.' },
        ]);
        const published: Array<{
            toolCallId: string;
            type: unknown;
        }> = [];
        const forwarded: Array<{
            type: unknown;
        }> = [];
        const runtime = new AgentRuntime({
            store: parentStore,
            sessionId,
        });
        await runtime.run({
            client: parentClient,
            systemPrompt: 'parent',
            tools: [],
            keyId: 'k1',
            onEvent: (event) => {
                const e = event as {
                    type?: unknown;
                    subagentToolCallId?: unknown;
                };
                if (e.subagentToolCallId)
                    forwarded.push({ type: e.type });
            },
            subagent: {
                profiles: [makeSubagentProfile('explore', subagentClient)],
                store: subagentStore,
                publishChildEvent: (toolCallId, event) => {
                    published.push({ toolCallId, type: (event as {
                            type?: unknown;
                        }).type });
                },
            },
        });
        expect(published.length).toBeGreaterThan(0);
        for (const p of published)
            expect(p.toolCallId).toBe('toolu_A2');
        const publishedTypes = new Set(published.map((p) => p.type));
        for (const f of forwarded)
            expect(publishedTypes.has(f.type)).toBe(true);
        expect(published.length).toBeGreaterThan(forwarded.length);
    });
    it('B · SIGTERM handoff: draining mid-subagent → batch discarded, anchor stays intact', async () => {
        parentClient.reset([
            {
                toolCalls: [
                    {
                        id: 'toolu_B',
                        name: 'subagent',
                        arguments: JSON.stringify({ task: 'find X', mode: 'explore' }),
                    },
                ],
            },
        ]);
        subagentClient.reset([
            {
                toolCalls: [
                    { id: 'toolu_S1', name: 'echo', arguments: JSON.stringify({ text: 'hi' }) },
                ],
            },
            { content: 'X is on line 5.' },
        ]);
        let draining = false;
        const runtime = new AgentRuntime({
            store: parentStore,
            sessionId,
            isDraining: () => draining,
        });
        const originalChat = subagentClient.chat.bind(subagentClient);
        let call = 0;
        subagentClient.chat = async (req) => {
            call++;
            const res = await originalChat(req);
            if (call === 1)
                draining = true;
            return res;
        };
        const parentEvents: Array<{
            type?: string;
            toolCallId?: string;
        }> = [];
        await runtime.run({
            client: parentClient,
            systemPrompt: 'parent',
            tools: [],
            keyId: 'k1',
            onEvent: (event) => parentEvents.push(event as {
                type?: string;
                toolCallId?: string;
            }),
            subagent: {
                profiles: [makeSubagentProfile('explore', subagentClient)],
                store: subagentStore,
            },
        });
        expect(parentEvents.filter((e) => e.type === 'tool_call_end' && e.toolCallId === 'toolu_B')).toHaveLength(0);
        const anchor = subagentStore.activeAnchors.get(sessionId);
        expect(anchor).toBeTruthy();
        expect(anchor!.runIds.length).toBe(1);
        const nonEventPersisted = parentStore.stored.filter((m) => m.type !== 'event');
        expect(nonEventPersisted).toHaveLength(0);
        const runDoc = Array.from(subagentStore.runs.values())[0];
        expect(runDoc.status).toBe('running');
    });
    it('B2 · handoff discards a completed sibling without publishing a false terminal event', async () => {
        parentClient.reset([
            {
                toolCalls: [
                    { id: 'toolu_fast', name: 'fast', arguments: '{}' },
                    {
                        id: 'toolu_handoff',
                        name: 'subagent',
                        arguments: JSON.stringify({ task: 'find X', mode: 'explore' }),
                    },
                ],
            },
        ]);
        subagentClient.reset([
            { content: 'still working' },
        ]);
        let draining = false;
        const fastTool = {
            name: 'fast',
            description: 'complete before the subagent hands off',
            inputSchema: { type: 'object', properties: {} },
            execute: async () => 'fast-result',
        };
        const runtime = new AgentRuntime({
            store: parentStore,
            sessionId,
            isDraining: () => draining,
        });
        const parentEvents: Array<{
            type?: string;
            toolCallId?: string;
        }> = [];
        queueMicrotask(() => { draining = true; });
        await runtime.run({
            client: parentClient,
            systemPrompt: 'parent',
            tools: [fastTool as never],
            keyId: 'k1',
            onEvent: (event) => parentEvents.push(event as {
                type?: string;
                toolCallId?: string;
            }),
            subagent: {
                profiles: [makeSubagentProfile('explore', subagentClient)],
                store: subagentStore,
            },
        });
        expect(parentEvents.filter((e) => e.type === 'tool_call_end'
            && (e.toolCallId === 'toolu_fast' || e.toolCallId === 'toolu_handoff'))).toHaveLength(0);
        expect(parentStore.stored.filter((m) => m.type !== 'event')).toHaveLength(0);
        expect(subagentStore.activeAnchors.get(sessionId)).toBeTruthy();
    });
    it('C · recovery: new turn reads anchor → replays snapshot → resumes subagent', async () => {
        const parentSnapshot = assistantSnapshot('toolu_C', {
            task: 'find Y',
            mode: 'explore',
        });
        const preexistingOid = new ObjectId();
        const preexistingId = preexistingOid.toHexString();
        subagentStore.runs.set(preexistingId, {
            subagentId: preexistingId,
            sessionId,
            parentTurnId: 'parent-turn-1',
            toolCallId: 'toolu_C',
            profileName: 'explore',
            profileVariant: 'persisted-b',
            task: 'find Y',
            messages: [
                {
                    type: 'event',
                    eventType: 'message.received',
                    content: 'find Y',
                    timestamp: new Date(),
                },
                {
                    type: 'assistant',
                    content: '',
                    turnId: 'sub-turn-1',
                    timestamp: new Date(),
                    toolCalls: [
                        { id: 'toolu_S1', type: 'tool_use', name: 'echo', arguments: JSON.stringify({ text: 'seed' }) },
                    ],
                },
                {
                    type: 'tool',
                    toolCallId: 'toolu_S1',
                    content: 'echo:seed',
                    isError: false,
                    turnId: 'sub-turn-1',
                    timestamp: new Date(),
                },
            ],
            status: 'running',
        });
        subagentStore.activeAnchors.set(sessionId, {
            parentTurnId: 'parent-turn-1',
            parentAssistantSnapshot: parentSnapshot,
            runIds: [preexistingOid],
        });
        parentClient.reset([
            { content: 'Recovered result.' },
        ]);
        subagentClient.reset([
            { content: 'Y is on line 42.' },
        ]);
        const resolver = vi.fn(async (context: import('../types.js').SubagentProfileVariantContext) => ({
            ...makeSubagentProfile('explore', subagentClient),
            profileVariant: context.existingRunDoc?.profileVariant,
        }));
        const runtime = new AgentRuntime({
            store: parentStore,
            sessionId,
        });
        const parentEvents: Array<{
            type?: string;
            toolCallId?: string;
        }> = [];
        await runtime.run({
            client: parentClient,
            systemPrompt: 'parent',
            tools: [],
            keyId: 'k1',
            onEvent: (event) => parentEvents.push(event as {
                type?: string;
                toolCallId?: string;
            }),
            subagent: {
                profiles: [{ ...makeSubagentProfile('explore', subagentClient), resolveVariant: resolver }],
                store: subagentStore,
            },
        });
        expect(parentEvents.filter((e) => e.type === 'tool_call_end' && e.toolCallId === 'toolu_C')).toHaveLength(1);
        expect(resolver).toHaveBeenCalledWith(expect.objectContaining({
            toolCallId: 'toolu_C', resumeSource: 'recovery',
            existingRunDoc: expect.objectContaining({ profileVariant: 'persisted-b' }),
        }));
        expect(parentClient.calls).toHaveLength(1);
        expect(subagentStore.activeAnchors.has(sessionId)).toBe(false);
        const runDoc = subagentStore.runs.get(preexistingId)!;
        expect(runDoc.status).toBe('complete');
        const nonEvent = parentStore.stored.filter((m) => m.type !== 'event');
        expect(nonEvent[0].type).toBe('assistant');
        expect((nonEvent[0] as AssistantMessage).toolCalls?.[0].id).toBe('toolu_C');
        expect(nonEvent[1].type).toBe('tool');
        expect(nonEvent[2].type).toBe('assistant');
    });
    it('D · dirty-data fallback: anchor + snapshot present but findByToolCallId returns null → error result + stale anchor drained', async () => {
        const parentSnapshot = assistantSnapshot('toolu_D', {
            task: 'find Z',
            mode: 'explore',
        });
        const missingOid = new ObjectId();
        const missingId = missingOid.toHexString();
        subagentStore.activeAnchors.set(sessionId, {
            parentTurnId: 'parent-turn-1',
            parentAssistantSnapshot: parentSnapshot,
            runIds: [missingOid],
        });
        subagentStore.findByToolCallIdOverride = async () => null;
        const finalizeCalls: Array<{
            subagentId: string;
            status: string;
        }> = [];
        subagentStore.onFinalize.push((input) => {
            finalizeCalls.push({ subagentId: input.subagentId, status: input.status });
        });
        parentClient.reset([
            { content: 'Sorry, that failed.' },
        ]);
        const runtime = new AgentRuntime({
            store: parentStore,
            sessionId,
        });
        await runtime.run({
            client: parentClient,
            systemPrompt: 'parent',
            tools: [],
            keyId: 'k1',
            subagent: {
                profiles: [makeSubagentProfile('explore', subagentClient)],
                store: subagentStore,
            },
        });
        expect(subagentStore.runs.size).toBe(0);
        expect(finalizeCalls).toEqual([
            { subagentId: missingId, status: 'error' },
        ]);
        expect(subagentStore.activeAnchors.has(sessionId)).toBe(false);
        const nonEvent = parentStore.stored.filter((m) => m.type !== 'event');
        expect(nonEvent[0].type).toBe('assistant');
        expect(nonEvent[1].type).toBe('tool');
        expect((nonEvent[1] as {
            isError?: boolean;
        }).isError).toBe(true);
        expect((nonEvent[1] as {
            content: string;
        }).content).toMatch(/subagent recovery failed/);
        expect(nonEvent[2].type).toBe('assistant');
    });
    it('F · recovery skips first FETCH: parent snapshot lands BEFORE mid-tool pendingInputs in messages array', async () => {
        const T1 = new Date('2026-07-16T08:07:44Z');
        const T2 = new Date('2026-07-16T08:08:47Z');
        const parentSnapshot = assistantSnapshot('toolu_F', {
            task: 'find F',
            mode: 'explore',
        });
        parentSnapshot.timestamp = T1;
        const preexistingOid = new ObjectId();
        const preexistingId = preexistingOid.toHexString();
        subagentStore.runs.set(preexistingId, {
            subagentId: preexistingId,
            sessionId,
            parentTurnId: 'parent-turn-1',
            toolCallId: 'toolu_F',
            profileName: 'explore',
            task: 'find F',
            messages: [
                {
                    type: 'event',
                    eventType: 'message.received',
                    content: 'find F',
                    timestamp: T1,
                },
            ],
            status: 'running',
        });
        subagentStore.activeAnchors.set(sessionId, {
            parentTurnId: 'parent-turn-1',
            parentAssistantSnapshot: parentSnapshot,
            runIds: [preexistingOid],
        });
        parentStore.enqueue({
            type: 'event',
            eventType: 'message.received',
            content: 'mid-tool user msg',
            timestamp: T2,
        });
        parentClient.reset([{ content: 'Recovered after mid-tool msg.' }]);
        subagentClient.reset([{ content: 'F is at line 99.' }]);
        const runtime = new AgentRuntime({
            store: parentStore,
            sessionId,
        });
        await runtime.run({
            client: parentClient,
            systemPrompt: 'parent',
            tools: [],
            keyId: 'k1',
            subagent: {
                profiles: [makeSubagentProfile('explore', subagentClient)],
                store: subagentStore,
            },
        });
        const stored = parentStore.stored;
        const snapshotIdx = stored.findIndex((m) => m.type === 'assistant' &&
            m.toolCalls?.some((tc) => tc.id === 'toolu_F'));
        const midToolMsgIdx = stored.findIndex((m) => m.type === 'event' && m.content === 'mid-tool user msg');
        expect(snapshotIdx).toBeGreaterThanOrEqual(0);
        expect(midToolMsgIdx).toBeGreaterThanOrEqual(0);
        expect(snapshotIdx).toBeLessThan(midToolMsgIdx);
        expect(subagentStore.activeAnchors.has(sessionId)).toBe(false);
    });
    it('G · host-triggered abort (non-draining) mid-subagent: treated as handoff, NOT finalized, anchor stays intact', async () => {
        parentClient.reset([
            {
                toolCalls: [
                    {
                        id: 'toolu_G',
                        name: 'subagent',
                        arguments: JSON.stringify({ task: 'train something long', mode: 'explore' }),
                    },
                ],
            },
        ]);
        subagentClient.reset([
            {
                toolCalls: [
                    { id: 'toolu_S1', name: 'echo', arguments: JSON.stringify({ text: 'hi' }) },
                ],
            },
            { content: 'Should not be reached — parent already aborted.' },
        ]);
        const parentAbort = new AbortController();
        const runtime = new AgentRuntime({
            store: parentStore,
            sessionId,
        });
        const originalChat = subagentClient.chat.bind(subagentClient);
        let call = 0;
        subagentClient.chat = async (req) => {
            call++;
            const res = await originalChat(req);
            if (call === 1)
                parentAbort.abort();
            return res;
        };
        await runtime.run({
            client: parentClient,
            systemPrompt: 'parent',
            tools: [],
            keyId: 'k1',
            abortSignal: parentAbort.signal,
            subagent: {
                profiles: [makeSubagentProfile('explore', subagentClient)],
                store: subagentStore,
            },
        });
        const anchor = subagentStore.activeAnchors.get(sessionId);
        expect(anchor).toBeTruthy();
        expect(anchor!.runIds.length).toBe(1);
        const nonEventPersisted = parentStore.stored.filter((m) => m.type !== 'event');
        expect(nonEventPersisted).toHaveLength(0);
        const runDoc = Array.from(subagentStore.runs.values())[0];
        expect(runDoc.status).toBe('running');
    });
    it('E · in-process cancel: aborting cancelController surfaces as cancelled result', async () => {
        const { cancelSubagentInProcess, SUBAGENT_CANCELLED_RESULT } = await import('../tools/builtin/subagent.js');
        parentClient.reset([
            {
                toolCalls: [
                    {
                        id: 'toolu_E',
                        name: 'subagent',
                        arguments: JSON.stringify({ task: 'run something long' }),
                    },
                ],
            },
            { content: 'Understood, cancelled.' },
        ]);
        let cancelFired = false;
        subagentClient.reset([
            { content: 'never reached' },
        ]);
        const originalChat = subagentClient.chat.bind(subagentClient);
        subagentClient.chat = async (req) => {
            if (!cancelFired) {
                cancelFired = true;
                cancelSubagentInProcess(sessionId, 'toolu_E');
            }
            return originalChat(req);
        };
        const runtime = new AgentRuntime({
            store: parentStore,
            sessionId,
        });
        await runtime.run({
            client: parentClient,
            systemPrompt: 'parent',
            tools: [],
            keyId: 'k1',
            subagent: {
                profiles: [makeSubagentProfile('explore', subagentClient)],
                store: subagentStore,
            },
        });
        expect(subagentStore.activeAnchors.has(sessionId)).toBe(false);
        const runDoc = Array.from(subagentStore.runs.values())[0];
        expect(runDoc.status).toBe('cancelled');
        const toolResult = parentStore.stored.find((m) => m.type === 'tool');
        expect(toolResult).toBeTruthy();
        expect((toolResult as {
            content: string;
        }).content).toContain(SUBAGENT_CANCELLED_RESULT);
    });
});
describe('subagent inputOverride (host-defined task/context protocol)', () => {
    let sessionId: string;
    let parentStore: MemoryStore;
    let subagentStore: MemorySubagentStore;
    let parentClient: MockLLMClient;
    let subagentClient: MockLLMClient;
    beforeEach(() => {
        sessionId = 'sess-override';
        parentStore = new MemoryStore([
            {
                type: 'event',
                eventType: 'message.received',
                content: 'Please find X',
                timestamp: new Date(),
            },
        ]);
        subagentStore = new MemorySubagentStore();
        parentClient = new MockLLMClient([]);
        subagentClient = new MockLLMClient([]);
    });
    it('resolveInput runs on a brand-new call and its output is what gets seeded + persisted', async () => {
        parentClient.reset([
            {
                toolCalls: [
                    {
                        id: 'toolu_OV1',
                        name: 'subagent',
                        arguments: JSON.stringify({ task: '/workspace/task.md' }),
                    },
                ],
            },
            { content: 'Done.' },
        ]);
        subagentClient.reset([{ content: 'resolved task done.' }]);
        const resolveInputCalls: Array<{
            task: string;
            context?: string;
        }> = [];
        const runtime = new AgentRuntime({ store: parentStore, sessionId });
        await runtime.run({
            client: parentClient,
            systemPrompt: 'parent',
            tools: [],
            keyId: 'k1',
            subagent: {
                profiles: [makeSubagentProfile('explore', subagentClient)],
                store: subagentStore,
                inputOverride: {
                    resolveInput: async (raw) => {
                        resolveInputCalls.push(raw);
                        return { task: `RESOLVED(${raw.task})`, context: raw.context };
                    },
                    taskDescription: 'must be a sandbox absolute file path',
                },
            },
        });
        expect(resolveInputCalls).toEqual([{ task: '/workspace/task.md', context: undefined }]);
        const runDoc = Array.from(subagentStore.runs.values())[0];
        expect(runDoc.task).toBe('RESOLVED(/workspace/task.md)');
        const seededEvent = runDoc.messages.find((m) => m.type === 'event');
        expect((seededEvent as {
            content?: string;
        })?.content).toBe('RESOLVED(/workspace/task.md)');
    });
    it('recovery replay (existingDoc found) does NOT call resolveInput again', async () => {
        const preexistingOid = new ObjectId();
        const preexistingId = preexistingOid.toHexString();
        subagentStore.runs.set(preexistingId, {
            subagentId: preexistingId,
            sessionId,
            parentTurnId: 'parent-turn-1',
            toolCallId: 'toolu_OV2',
            profileName: 'explore',
            task: 'RESOLVED(/workspace/task.md)',
            messages: [
                {
                    type: 'event',
                    eventType: 'message.received',
                    content: 'RESOLVED(/workspace/task.md)',
                    timestamp: new Date(),
                },
            ],
            status: 'running',
        });
        let resolveInputCallCount = 0;
        const parentSnapshot = assistantSnapshot('toolu_OV2', {
            task: '/workspace/task.md',
        });
        subagentStore.activeAnchors.set(sessionId, {
            parentTurnId: 'parent-turn-1',
            parentAssistantSnapshot: parentSnapshot,
            runIds: [preexistingOid],
        });
        parentClient.reset([{ content: 'Recovered.' }]);
        subagentClient.reset([{ content: 'final after recovery.' }]);
        const runtime = new AgentRuntime({ store: parentStore, sessionId });
        await runtime.run({
            client: parentClient,
            systemPrompt: 'parent',
            tools: [],
            keyId: 'k1',
            subagent: {
                profiles: [makeSubagentProfile('explore', subagentClient)],
                store: subagentStore,
                inputOverride: {
                    resolveInput: async (raw) => {
                        resolveInputCallCount++;
                        return { task: `RESOLVED(${raw.task})`, context: raw.context };
                    },
                },
            },
        });
        expect(resolveInputCallCount).toBe(0);
        expect(subagentStore.activeAnchors.has(sessionId)).toBe(false);
    });
    it('taskDescription / contextDescription override the tool schema shown to the parent LLM', async () => {
        parentClient.reset([{ content: 'noop' }]);
        const runtime = new AgentRuntime({ store: parentStore, sessionId });
        let capturedSchema: Record<string, unknown> | undefined;
        await runtime.run({
            client: parentClient,
            systemPrompt: 'parent',
            tools: [],
            keyId: 'k1',
            subagent: {
                profiles: [makeSubagentProfile('explore', subagentClient)],
                store: subagentStore,
                inputOverride: {
                    resolveInput: async (raw) => raw,
                    taskDescription: 'must be a sandbox absolute file path',
                    contextDescription: 'must also be a sandbox absolute file path, if provided',
                },
            },
            hooks: {
                beforeTurn: (state) => {
                    const tool = state.tools.find((t) => t.name === 'subagent');
                    capturedSchema = tool?.inputSchema as Record<string, unknown> | undefined;
                },
            },
        });
        const props = capturedSchema?.properties as Record<string, {
            description?: string;
        }> | undefined;
        expect(props?.task?.description).toBe('must be a sandbox absolute file path');
        expect(props?.context?.description).toBe('must also be a sandbox absolute file path, if provided');
    });
});
describe('subagent tool guards', () => {
    it('throws when a host-supplied tool named `subagent` conflicts with auto-mount', async () => {
        const parentStore = new MemoryStore([]);
        const parentClient = new MockLLMClient([{ content: 'noop' }]);
        const runtime = new AgentRuntime({
            store: parentStore,
            sessionId: 'sess-1',
        });
        const subagentClient = new MockLLMClient([]);
        const subagentStore = new MemorySubagentStore();
        await expect(runtime.run({
            client: parentClient,
            systemPrompt: 'parent',
            tools: [
                {
                    name: 'subagent',
                    description: 'shadow',
                    inputSchema: { type: 'object' },
                    execute: async () => 'nope',
                },
            ],
            keyId: 'k1',
            subagent: {
                profiles: [makeSubagentProfile('explore', subagentClient)],
                store: subagentStore,
            },
        })).rejects.toThrow(/cannot mount `subagent` tool/);
    });
    it('throws when profiles list is empty', async () => {
        const parentStore = new MemoryStore([]);
        const parentClient = new MockLLMClient([{ content: 'noop' }]);
        const runtime = new AgentRuntime({
            store: parentStore,
            sessionId: 'sess-1',
        });
        const subagentStore = new MemorySubagentStore();
        await expect(runtime.run({
            client: parentClient,
            systemPrompt: 'parent',
            tools: [],
            keyId: 'k1',
            subagent: {
                profiles: [],
                store: subagentStore,
            },
        })).rejects.toThrow(/non-empty array/);
    });
});
