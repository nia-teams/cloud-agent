import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ObjectId } from '../host/__tests__/object-id.js';
import { AgentRuntime } from '../runtime.js';
import { MockLLMClient, MemoryStore, makeEchoTool } from './fixtures.js';
import type { ActiveSubagentTurn, AgentMessage, AssistantMessage, SubagentProfile, SubagentRunDoc, SubagentStore, SubagentProfileVariantContext, } from '../types.js';
class MemorySubagentStore implements SubagentStore {
    public runs = new Map<string, SubagentRunDoc>();
    public activeAnchors = new Map<string, ActiveSubagentTurn>();
    private nextId = 1;
    async insertRun(input: {
        sessionId: string;
        parentTurnId: string;
        parentAssistantSnapshot: AssistantMessage;
        toolCallId: string;
        profileName: string;
        profileVariant?: string;
        task: string;
        resumedFrom?: string;
        initialMessages: AgentMessage[];
    }): Promise<{
        subagentId: string;
    }> {
        const subagentId = new ObjectId().toHexString();
        this.nextId++;
        this.runs.set(subagentId, {
            _id: subagentId,
            sessionId: input.sessionId,
            parentTurnId: input.parentTurnId,
            toolCallId: input.toolCallId,
            profileName: input.profileName,
            ...(input.profileVariant ? { profileVariant: input.profileVariant } : {}),
            task: input.task,
            messages: input.initialMessages.slice(),
            status: 'running',
            createdAt: new Date(),
            updatedAt: new Date(),
        } as SubagentRunDoc);
        const anchor = this.activeAnchors.get(input.sessionId);
        const oid = new ObjectId(subagentId);
        if (anchor)
            anchor.runIds.push(oid);
        else
            this.activeAnchors.set(input.sessionId, {
                turnId: input.parentTurnId,
                runIds: [oid],
                parentAssistantSnapshot: input.parentAssistantSnapshot,
            } as ActiveSubagentTurn);
        return { subagentId };
    }
    async appendMessages(input: {
        subagentId: string;
        messages: AgentMessage[];
    }): Promise<void> {
        const doc = this.runs.get(input.subagentId);
        if (doc)
            doc.messages.push(...input.messages);
    }
    async readRun(subagentId: string): Promise<SubagentRunDoc | null> {
        return this.runs.get(subagentId) ?? null;
    }
    async findByToolCallId(sessionId: string, toolCallId: string): Promise<SubagentRunDoc | null> {
        for (const doc of this.runs.values()) {
            if (doc.sessionId === sessionId && doc.toolCallId === toolCallId)
                return doc;
        }
        return null;
    }
    async findResumableRun(): Promise<SubagentRunDoc | null> {
        return null;
    }
    async finalize(input: {
        subagentId: string;
        sessionId: string;
        status: 'complete' | 'cancelled' | 'error';
        lastError?: {
            code: string;
            message: string;
            detail?: string;
        };
    }): Promise<void> {
        const doc = this.runs.get(input.subagentId);
        if (doc) {
            doc.status = input.status;
            if (input.lastError)
                (doc as {
                    lastError?: unknown;
                }).lastError = input.lastError;
        }
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
function makeProfile(client: MockLLMClient): SubagentProfile {
    return {
        name: 'full',
        description: 'full mode',
        rolePrompt: 'You are the full subagent.',
        tools: [makeEchoTool('echo')],
        client,
    };
}
function scriptParent(parent: MockLLMClient, toolCallId: string): void {
    parent.reset([
        {
            toolCalls: [
                { id: toolCallId, name: 'subagent', arguments: JSON.stringify({ task: 'do it' }) },
            ],
        },
        { content: 'Parent ack.' },
    ]);
}
function scriptChild(child: MockLLMClient): void {
    child.reset([
        { toolCalls: [{ id: 'toolu_child_1', name: 'echo', arguments: '{"text":"hi"}' }] },
        { content: 'Child report.' },
    ]);
}
describe('subagent canonical client boundary', () => {
    it.each([['openai', 'anthropic'], ['anthropic', 'openai'], ['unknown-parent', 'unknown-child']])('%s parent and %s child receive canonical messages without provider lookup', async (parentProvider, childProvider) => {
        const parent = new MockLLMClient([], parentProvider, 'parent-model');
        const child = new MockLLMClient([], childProvider, 'child-model');
        const parentProviderSpy = vi.spyOn(parent, 'getProviderName').mockImplementation(() => { throw new Error('provider lookup forbidden'); });
        const childProviderSpy = vi.spyOn(child, 'getProviderName').mockImplementation(() => { throw new Error('provider lookup forbidden'); });
        scriptParent(parent, 'tc-parent');
        scriptChild(child);
        const parentStore = new MemoryStore([{ type: 'event', eventType: 'message.received', content: 'go', timestamp: new Date() }]);
        const store = new MemorySubagentStore();
        await new AgentRuntime({ store: parentStore, sessionId: 'canonical-child' }).run({
            client: parent, systemPrompt: 'parent', tools: [], keyId: 'k',
            subagent: { profiles: [makeProfile(child)], store },
        });
        expect(child.calls).toHaveLength(2);
        const messages = child.calls[1].messages;
        expect(messages.every((message) => 'type' in message && !('role' in message))).toBe(true);
        expect(messages).toContainEqual(expect.objectContaining({ type: 'assistant', model: 'child-model', toolCalls: [{ id: 'toolu_child_1', name: 'echo', arguments: '{"text":"hi"}' }] }));
        expect(messages).toContainEqual(expect.objectContaining({ type: 'tool', toolCallId: 'toolu_child_1', content: 'echo:hi' }));
        expect([...store.runs.values()][0].status).toBe('complete');
        expect(parentStore.stored.find((message) => message.type === 'tool')).toMatchObject({ content: expect.stringContaining('Child report.') });
        expect(parentProviderSpy).not.toHaveBeenCalled();
        expect(childProviderSpy).not.toHaveBeenCalled();
    });
});
describe('subagent per-run effective profile variants', () => {
    it('resolves a fresh invocation after input resolution, uses its complete effective profile, and persists its opaque variant', async () => {
        const parent = new MockLLMClient([], 'mock');
        const baseClient = new MockLLMClient([], 'mock');
        const variantClient = new MockLLMClient([], 'mock');
        const store = new MemorySubagentStore();
        const resolver = vi.fn(async (context: SubagentProfileVariantContext) => {
            expect(context).toMatchObject({
                sessionId: 'sess-variant', toolCallId: 'tc-variant', task: 'resolved task', resumeSource: 'fresh',
            });
            return {
                ...makeProfile(variantClient),
                rolePrompt: 'variant prompt',
                profileVariant: 'opaque-b',
            };
        });
        parent.reset([
            { toolCalls: [{ id: 'tc-variant', name: 'subagent', arguments: JSON.stringify({ task: 'raw task' }) }] },
            { content: 'done' },
        ]);
        variantClient.reset([{ content: 'variant child result' }]);
        await new AgentRuntime({
            store: new MemoryStore([{ type: 'event', eventType: 'message.received', content: 'go', timestamp: new Date() }]),
            sessionId: 'sess-variant',
        }).run({
            client: parent, systemPrompt: 'parent', tools: [], keyId: 'k',
            subagent: {
                profiles: [{ ...makeProfile(baseClient), resolveVariant: resolver }], store,
                inputOverride: { resolveInput: async () => ({ task: 'resolved task' }) },
            },
        });
        expect(resolver).toHaveBeenCalledOnce();
        expect(baseClient.calls).toHaveLength(0);
        expect(variantClient.calls).toHaveLength(1);
        expect([...store.runs.values()][0]).toMatchObject({ profileName: 'full', profileVariant: 'opaque-b' });
    });
    it('rejects an effective profile that changes the public mode before inserting or starting a child', async () => {
        const parent = new MockLLMClient([], 'mock');
        const child = new MockLLMClient([], 'mock');
        const store = new MemorySubagentStore();
        parent.reset([
            { toolCalls: [{ id: 'tc-wrong-name', name: 'subagent', arguments: JSON.stringify({ task: 'do it' }) }] },
            { content: 'parent saw error' },
        ]);
        await new AgentRuntime({ store: new MemoryStore([{ type: 'event', eventType: 'message.received', content: 'go', timestamp: new Date() }]), sessionId: 'sess-wrong-name' }).run({
            client: parent, systemPrompt: 'parent', tools: [], keyId: 'k',
            subagent: { profiles: [{ ...makeProfile(child), resolveVariant: async () => ({ ...makeProfile(child), name: 'other' }) }], store },
        });
        expect(store.runs).toHaveLength(0);
        expect(store.activeAnchors).toHaveLength(0);
        expect(child.calls).toHaveLength(0);
        const toolResult = (parent.calls[1]!.messages as unknown as Array<{
            type?: string;
            isError?: boolean;
            content?: string;
        }>).find((m) => m.type === 'tool');
        expect(toolResult).toMatchObject({ isError: true });
        expect(toolResult?.content).toContain('must preserve profile name: expected "full", got "other"');
    });
    it('propagates resolver throws as the existing errored tool-result path without inserting a run', async () => {
        const parent = new MockLLMClient([], 'mock');
        const child = new MockLLMClient([], 'mock');
        const store = new MemorySubagentStore();
        parent.reset([
            { toolCalls: [{ id: 'tc-resolver-throws', name: 'subagent', arguments: JSON.stringify({ task: 'do it' }) }] },
            { content: 'parent saw error' },
        ]);
        await new AgentRuntime({ store: new MemoryStore([{ type: 'event', eventType: 'message.received', content: 'go', timestamp: new Date() }]), sessionId: 'sess-resolver-throws' }).run({
            client: parent, systemPrompt: 'parent', tools: [], keyId: 'k',
            subagent: { profiles: [{ ...makeProfile(child), resolveVariant: async () => { throw new Error('variant service unavailable'); } }], store },
        });
        expect(store.runs).toHaveLength(0);
        expect(store.activeAnchors).toHaveLength(0);
        expect(child.calls).toHaveLength(0);
        const toolResult = (parent.calls[1]!.messages as unknown as Array<{
            type?: string;
            isError?: boolean;
            content?: string;
        }>).find((m) => m.type === 'tool');
        expect(toolResult).toMatchObject({ isError: true });
        expect(toolResult?.content).toContain('variant service unavailable');
    });
    it('passes the previous document to resolver on explicit resume, retaining its persisted variant', async () => {
        const parent = new MockLLMClient([], 'mock');
        const child = new MockLLMClient([], 'mock');
        const store = new MemorySubagentStore();
        const resolver = vi.fn(async (context: SubagentProfileVariantContext) => ({
            ...makeProfile(child),
            profileVariant: context.existingRunDoc?.profileVariant ?? 'first',
        }));
        const profile = { ...makeProfile(child), resolveVariant: resolver };
        const run = async (toolCallId: string, args: Record<string, unknown>) => {
            parent.reset([{ toolCalls: [{ id: toolCallId, name: 'subagent', arguments: JSON.stringify(args) }] }, { content: 'done' }]);
            child.reset([{ content: 'child done' }]);
            await new AgentRuntime({ store: new MemoryStore([{ type: 'event', eventType: 'message.received', content: 'go', timestamp: new Date() }]), sessionId: 'sess-resume-variant' }).run({
                client: parent, systemPrompt: 'parent', tools: [], keyId: 'k',
                subagent: { profiles: [profile], store },
            });
        };
        await run('tc-original', { task: 'first' });
        await run('tc-resume', { task: 'continue', resume: 'tc-original' });
        expect(resolver.mock.calls[1]![0]).toMatchObject({
            toolCallId: 'tc-resume', resumeSource: 'explicit-resume',
            existingRunDoc: { toolCallId: 'tc-original', profileVariant: 'first' },
        });
        expect([...store.runs.values()].find((d) => d.toolCallId === 'tc-resume')).toMatchObject({ profileVariant: 'first' });
    });
});
