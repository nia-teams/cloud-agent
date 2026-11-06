import { ObjectId } from '../host/__tests__/object-id.js';
import { MalformedToolArgumentsError } from '../protocol/llm-protocol.js';
import { describe, it, expect, beforeEach } from 'vitest';
import { AgentRuntime } from '../runtime.js';
import { MockLLMClient, CapturingUsageRecorder, MemoryStore, makeFailingTool, } from './fixtures.js';
import { cancelSubagentInProcess, SUBAGENT_CANCELLED_RESULT } from '../tools/builtin/subagent.js';
import type { ActiveSubagentTurn, AgentMessage, AssistantMessage, SubagentProfile, SubagentResultForFormat, SubagentRunDoc, SubagentStore, } from '../types.js';
class MemorySubagentStore implements SubagentStore {
    public runs = new Map<string, SubagentRunDoc>();
    public activeAnchors = new Map<string, ActiveSubagentTurn>();
    public finalizeCalls: Array<{
        subagentId: string;
        sessionId: string;
        status: 'complete' | 'cancelled' | 'error';
        lastError?: {
            code: string;
            message: string;
            detail?: string;
        };
    }> = [];
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
        else if (!existing.runIds.some((oid) => oid.equals(subagentOid))) {
            existing.runIds.push(subagentOid);
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
        for (const doc of this.runs.values()) {
            if (doc.sessionId === sessionId && doc.toolCallId === toolCallId)
                return doc;
        }
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
        this.finalizeCalls.push(input);
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
function makeSubagentProfile(name: string, client: MockLLMClient, tools = [makeFailingTool('fail')]): SubagentProfile {
    return {
        name,
        description: `${name} mode`,
        rolePrompt: `You are the ${name} subagent.`,
        tools,
        client,
    };
}
describe('subagent error → throw (isError really lands on the wire)', () => {
    let sessionId: string;
    let parentStore: MemoryStore;
    let subagentStore: MemorySubagentStore;
    let parentClient: MockLLMClient;
    let subagentClient: MockLLMClient;
    beforeEach(() => {
        sessionId = 'sess-error-throws';
        parentStore = new MemoryStore([
            {
                type: 'event',
                eventType: 'message.received',
                content: 'Please do something',
                timestamp: new Date(),
            },
        ]);
        subagentStore = new MemorySubagentStore();
        parentClient = new MockLLMClient([]);
        subagentClient = new MockLLMClient([]);
    });
    it.each(['good', 'bad'] as const)('child malformed → %s retries locally without replaying parent tools or double billing', async (outcome) => {
        const malformed = () => new MalformedToolArgumentsError('child-bad', 'echo', '{');
        parentClient.reset([
            { toolCalls: [{ id: 'child-retry', name: 'subagent', arguments: JSON.stringify({ task: 'find X' }) }] },
            { content: 'Parent ack.' },
        ]);
        subagentClient.reset([
            { throws: malformed() },
            outcome === 'good'
                ? { content: 'Child recovered.', streamDeltas: [{ type: 'text', content: 'Child recovered.' }] }
                : { throws: malformed() },
            { content: 'must not run' },
        ]);
        const usage = new CapturingUsageRecorder();
        const events: Array<{
            type?: string;
            subagentToolCallId?: string;
        }> = [];
        await new AgentRuntime({ store: parentStore, sessionId, usage }).run({
            client: parentClient, systemPrompt: 'parent', tools: [], keyId: 'k1',
            onEvent: (event) => { events.push(event); },
            subagent: {
                profiles: [makeSubagentProfile('explore', subagentClient, [])],
                store: subagentStore,
            },
        });
        expect(parentClient.calls).toHaveLength(2);
        expect(subagentClient.calls).toHaveLength(2);
        expect(subagentClient.calls[1].signal).toBe(subagentClient.calls[0].signal);
        expect(subagentClient.calls[1].messages).toBe(subagentClient.calls[0].messages);
        expect(subagentStore.runs.size).toBe(1);
        expect(subagentStore.finalizeCalls).toHaveLength(1);
        expect(subagentStore.finalizeCalls[0].status).toBe(outcome === 'good' ? 'complete' : 'error');
        const childDoc = [...subagentStore.runs.values()][0];
        const childAssistants = childDoc.messages.filter((m) => m.type === 'assistant');
        expect(childAssistants).toHaveLength(outcome === 'good' ? 1 : 0);
        const results = parentStore.stored.filter((m) => m.type === 'tool');
        expect(results).toHaveLength(1);
        expect(results[0]).toMatchObject({ isError: outcome === 'bad' });
        expect(usage.entries).toHaveLength(1);
        expect(usage.entries[0]).toMatchObject({ numLLMCalls: 2, inputTokens: 200, outputTokens: 40 });
        expect(events.filter((e) => e.type === 'text_delta' && e.subagentToolCallId === 'child-retry'))
            .toHaveLength(outcome === 'good' ? 1 : 0);
    });
    it('1+2: error → tool message isError===true with failure text, AND the parent turn survives to make its next LLM call', async () => {
        parentClient.reset([
            {
                toolCalls: [
                    {
                        id: 'toolu_error_1',
                        name: 'subagent',
                        arguments: JSON.stringify({ task: 'do something that fails' }),
                    },
                ],
            },
            { content: 'Parent ack after seeing the failure.' },
        ]);
        subagentClient.reset([{ throws: new Error('boom: upstream LLM failure') }]);
        const runtime = new AgentRuntime({ store: parentStore, sessionId });
        await runtime.run({
            client: parentClient,
            systemPrompt: 'parent',
            tools: [],
            keyId: 'k1',
            subagent: {
                profiles: [makeSubagentProfile('explore', subagentClient)],
                store: subagentStore,
                resultOverride: async (result) => `Subagent failed: ${result.lastError?.message} (resume=${result.toolCallId})`,
            },
        });
        const toolResult = parentStore.stored.find((m) => m.type === 'tool') as {
            isError?: boolean;
            content: string;
        } | undefined;
        expect(toolResult).toBeDefined();
        expect(toolResult!.isError).toBe(true);
        expect(toolResult!.content).toContain('boom: upstream LLM failure');
        expect(parentClient.calls.length).toBe(2);
        const finalAssistant = parentStore.stored.find((m) => m.type === 'assistant' && (m as {
            content?: string;
        }).content?.includes('Parent ack'));
        expect(finalAssistant).toBeDefined();
    });
    it('3: cancelled still returns — isError is falsy, not thrown', async () => {
        parentClient.reset([
            {
                toolCalls: [
                    {
                        id: 'toolu_cancel_1',
                        name: 'subagent',
                        arguments: JSON.stringify({ task: 'run something long' }),
                    },
                ],
            },
            { content: 'Parent ack cancel.' },
        ]);
        let cancelFired = false;
        subagentClient.reset([{ content: 'never reached' }]);
        const originalChat = subagentClient.chat.bind(subagentClient);
        subagentClient.chat = async (req) => {
            if (!cancelFired) {
                cancelFired = true;
                cancelSubagentInProcess(sessionId, 'toolu_cancel_1');
            }
            return originalChat(req);
        };
        const runtime = new AgentRuntime({ store: parentStore, sessionId });
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
        const toolResult = parentStore.stored.find((m) => m.type === 'tool') as {
            isError?: boolean;
            content: string;
        } | undefined;
        expect(toolResult).toBeDefined();
        expect(toolResult!.isError).toBeFalsy();
        expect(toolResult!.content).toContain(SUBAGENT_CANCELLED_RESULT);
    });
    it('4: complete still returns — behavior byte-for-byte unchanged', async () => {
        parentClient.reset([
            {
                toolCalls: [
                    {
                        id: 'toolu_complete_1',
                        name: 'subagent',
                        arguments: JSON.stringify({ task: 'find X', mode: 'explore' }),
                    },
                ],
            },
            { content: 'Parent ack.' },
        ]);
        subagentClient.reset([{ content: 'X is on line 5.' }]);
        const runtime = new AgentRuntime({ store: parentStore, sessionId });
        await runtime.run({
            client: parentClient,
            systemPrompt: 'parent',
            tools: [],
            keyId: 'k1',
            subagent: {
                profiles: [makeSubagentProfile('explore', subagentClient, [])],
                store: subagentStore,
            },
        });
        const toolResult = parentStore.stored.find((m) => m.type === 'tool') as {
            isError?: boolean;
            content: string;
        } | undefined;
        expect(toolResult).toBeDefined();
        expect(toolResult!.isError).toBeFalsy();
        expect(toolResult!.content).toBe('X is on line 5.\n\n[tool_call_id: toolu_complete_1]');
    });
    it('5: store.finalize() still runs on the error path — status=error + lastError persisted, throw does not skip it', async () => {
        parentClient.reset([
            {
                toolCalls: [
                    {
                        id: 'toolu_error_2',
                        name: 'subagent',
                        arguments: JSON.stringify({ task: 'do something that fails' }),
                    },
                ],
            },
            { content: 'Parent ack error.' },
        ]);
        subagentClient.reset([{ throws: new Error('boom: upstream LLM failure') }]);
        const runtime = new AgentRuntime({ store: parentStore, sessionId });
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
        expect(subagentStore.finalizeCalls).toHaveLength(1);
        expect(subagentStore.finalizeCalls[0].status).toBe('error');
        expect(subagentStore.finalizeCalls[0].lastError).toBeTruthy();
        expect(subagentStore.finalizeCalls[0].lastError?.message).toContain('boom: upstream LLM failure');
        const runDoc = Array.from(subagentStore.runs.values())[0];
        expect(runDoc.status).toBe('error');
        expect((runDoc as {
            lastError?: {
                message: string;
            };
        }).lastError?.message).toContain('boom: upstream LLM failure');
    });
    it('6: resultOverride called exactly once on error, and its return value IS the thrown/wire message', async () => {
        parentClient.reset([
            {
                toolCalls: [
                    {
                        id: 'toolu_error_3',
                        name: 'subagent',
                        arguments: JSON.stringify({ task: 'do something that fails' }),
                    },
                ],
            },
            { content: 'Parent ack error.' },
        ]);
        subagentClient.reset([{ throws: new Error('boom: upstream LLM failure') }]);
        const receivedResults: SubagentResultForFormat[] = [];
        const runtime = new AgentRuntime({ store: parentStore, sessionId });
        await runtime.run({
            client: parentClient,
            systemPrompt: 'parent',
            tools: [],
            keyId: 'k1',
            subagent: {
                profiles: [makeSubagentProfile('explore', subagentClient)],
                store: subagentStore,
                resultOverride: async (result) => {
                    receivedResults.push(result);
                    return `HOST-ERROR-FORMAT[resume=${result.toolCallId}]: ${result.lastError?.message}`;
                },
            },
        });
        expect(receivedResults).toHaveLength(1);
        expect(receivedResults[0].status).toBe('error');
        const toolResult = parentStore.stored.find((m) => m.type === 'tool') as {
            isError?: boolean;
            content: string;
        } | undefined;
        expect(toolResult).toBeDefined();
        expect(toolResult!.isError).toBe(true);
        expect(toolResult!.content).toBe('HOST-ERROR-FORMAT[resume=toolu_error_3]: boom: upstream LLM failure');
    });
});
