import { ObjectId } from '../host/__tests__/object-id.js';
import { describe, it, expect, beforeEach } from 'vitest';
import { AgentRuntime } from '../runtime.js';
import { MockLLMClient, MemoryStore, makeEchoTool, makeFailingTool, } from './fixtures.js';
import { cancelSubagentInProcess, SUBAGENT_CANCELLED_RESULT, __testInternals, } from '../tools/builtin/subagent.js';
import type { ActiveSubagentTurn, AgentMessage, AssistantMessage, SubagentProfile, SubagentResultForFormat, SubagentRunDoc, SubagentStore, } from '../types.js';
const { defaultFormatSubagentResult } = __testInternals;
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
describe('defaultFormatSubagentResult (no resultOverride wired)', () => {
    it('complete + non-empty content', () => {
        const result: SubagentResultForFormat = {
            status: 'complete',
            content: 'X is on line 5.',
            toolCallId: 'toolu_1',
            mode: 'explore',
        };
        expect(defaultFormatSubagentResult(result)).toBe('X is on line 5.\n\n[tool_call_id: toolu_1]');
    });
    it('complete + empty content → "no text output" fallback', () => {
        const result: SubagentResultForFormat = {
            status: 'complete',
            content: '',
            toolCallId: 'toolu_2',
            mode: 'explore',
        };
        expect(defaultFormatSubagentResult(result)).toBe('(subagent completed with no text output)\n\n[tool_call_id: toolu_2]');
    });
    it('cancelled → SUBAGENT_CANCELLED_RESULT text + tool_call_id suffix', () => {
        const result: SubagentResultForFormat = {
            status: 'cancelled',
            content: SUBAGENT_CANCELLED_RESULT,
            toolCallId: 'toolu_3',
            mode: 'explore',
        };
        expect(defaultFormatSubagentResult(result)).toBe(`${SUBAGENT_CANCELLED_RESULT}\n\n[tool_call_id: toolu_3]`);
    });
});
describe('subagent resultOverride (host-defined presentation policy)', () => {
    let sessionId: string;
    let parentStore: MemoryStore;
    let subagentStore: MemorySubagentStore;
    let parentClient: MockLLMClient;
    let subagentClient: MockLLMClient;
    beforeEach(() => {
        sessionId = 'sess-result-override';
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
  it.each([true, false])('finalizes a capped subagent with wrap-up text=%s', async (hasText) => {
    const step = (id: string) => ({ content: null, toolCalls: [{ id, name: 'echo', arguments: '{"text":"ok"}' }] });
    subagentClient.reset([step('1'), step('2'), step('3'), {
      ...step('ignored'), content: hasText ? 'Step limit reached. Verified partial findings.' : null,
      streamDeltas: hasText ? [{ type: 'text', content: 'Step limit reached. Verified partial findings.' }] : [],
    }]);
    parentClient.reset([
      { toolCalls: [{ id: 'capped', name: 'subagent', arguments: JSON.stringify({ task: 'find X', mode: 'explore' }) }] },
      { content: 'Parent ack.' },
    ]);
    const results: SubagentResultForFormat[] = [];
    const events: any[] = [];
    const tool = makeEchoTool();
    const profile = { ...makeSubagentProfile('explore', subagentClient, [tool]), maxTurns: 3 };
    const runtime = new AgentRuntime({ store: parentStore, sessionId });
    await runtime.run({
      client: parentClient, systemPrompt: 'parent', tools: [], keyId: 'test',
      onEvent: e => { events.push(e); },
      subagent: { profiles: [profile], store: subagentStore, resultOverride: result => {
        results.push(result);
        return defaultFormatSubagentResult(result);
      } },
    });
    const doc = [...subagentStore.runs.values()][0];
    expect(doc.status).toBe(hasText ? 'complete' : 'error');
    expect(subagentClient.calls).toHaveLength(4);
    expect(subagentClient.calls[3].toolChoice).toBe('none');
    expect(subagentClient.calls[3].tools).toEqual(subagentClient.calls[2].tools);
    expect(subagentClient.calls[3].messages.at(-1)).toMatchObject({ eventType: 'runtime.max_iterations_wrap_up', content: expect.stringContaining('maximum step limit (3)') });
    expect(JSON.stringify(doc.messages)).not.toContain('Do NOT call tools');
    expect(results[0].maxTurnsReached).toBe(hasText ? 3 : undefined);
    expect(tool.calls).toHaveLength(3);
    const toolResult = parentStore.stored.find(m => m.type === 'tool');
    if (!hasText) {
      expect(toolResult).toMatchObject({ isError: true });
      expect(results[0].lastError?.message).toContain('Hit max loop iterations (3)');
      expect(doc.messages.at(-1)?.type).toBe('tool');
      return;
    }
    expect(toolResult?.content).toContain('[Subagent reached max turns (3) · partial result]');
    expect(doc.messages.at(-1)).toMatchObject({ type: 'assistant', content: 'Step limit reached. Verified partial findings.' });
    expect(events.some(e => e.type === 'text_delta' && e.subagentToolCallId === 'capped')).toBe(true);

    parentStore.enqueue({ type: 'event', eventType: 'user_message', content: 'Continue', timestamp: new Date() });
    parentClient.reset([
      { toolCalls: [{ id: 'resumed', name: 'subagent', arguments: JSON.stringify({ task: 'continue', resume: 'capped' }) }] },
      { content: 'Resumed ack.' },
    ]);
    subagentClient.reset([step('resumed-tool'), { content: 'Finished remaining work.' }]);
    await runtime.run({
      client: parentClient, systemPrompt: 'parent', tools: [], keyId: 'test',
      subagent: { profiles: [profile], store: subagentStore },
    });
    expect(subagentClient.calls).toHaveLength(2);
    expect(subagentClient.calls[0].toolChoice).toBeUndefined();
    expect(JSON.stringify(subagentClient.calls[0].messages)).not.toContain('Do NOT call tools');
    expect(subagentClient.calls[0].messages).toContainEqual(expect.objectContaining({ type: 'assistant', content: 'Step limit reached. Verified partial findings.' }));
    expect(tool.calls).toHaveLength(4);
    expect([...subagentStore.runs.values()].at(-1)?.status).toBe('complete');
  });

    it('no resultOverride wired → default formatting unchanged (regression guard)', async () => {
        parentClient.reset([
            {
                toolCalls: [
                    {
                        id: 'toolu_default',
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
                profiles: [makeSubagentProfile('explore', subagentClient)],
                store: subagentStore,
            },
        });
        const toolResult = parentStore.stored.find((m) => m.type === 'tool');
        expect((toolResult as {
            content: string;
        }).content).toBe('X is on line 5.\n\n[tool_call_id: toolu_default]');
    });
    it('resultOverride wired → its return value becomes the tool_result verbatim, with full+correct SubagentResultForFormat', async () => {
        parentClient.reset([
            {
                toolCalls: [
                    {
                        id: 'toolu_override',
                        name: 'subagent',
                        arguments: JSON.stringify({ task: 'find X', mode: 'explore' }),
                    },
                ],
            },
            { content: 'Parent ack.' },
        ]);
        subagentClient.reset([{ content: 'X is on line 5.' }]);
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
                    return `HOST-FORMATTED[${result.status}]: ${result.content}`;
                },
            },
        });
        expect(receivedResults).toHaveLength(1);
        expect(receivedResults[0]).toEqual({
            status: 'complete',
            content: 'X is on line 5.',
            toolCallId: 'toolu_override',
            mode: 'explore',
            lastError: undefined,
        });
        const toolResult = parentStore.stored.find((m) => m.type === 'tool');
        expect((toolResult as {
            content: string;
        }).content).toBe('HOST-FORMATTED[complete]: X is on line 5.');
    });
    it('cancelled status → resultOverride sees status="cancelled" + content=SUBAGENT_CANCELLED_RESULT', async () => {
        parentClient.reset([
            {
                toolCalls: [
                    {
                        id: 'toolu_cancel',
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
                cancelSubagentInProcess(sessionId, 'toolu_cancel');
            }
            return originalChat(req);
        };
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
                    return `CANCELLED-BY-HOST: ${result.toolCallId}`;
                },
            },
        });
        expect(receivedResults).toHaveLength(1);
        expect(receivedResults[0].status).toBe('cancelled');
        expect(receivedResults[0].content).toBe(SUBAGENT_CANCELLED_RESULT);
        expect(receivedResults[0].toolCallId).toBe('toolu_cancel');
        const toolResult = parentStore.stored.find((m) => m.type === 'tool');
        expect((toolResult as {
            content: string;
        }).content).toBe('CANCELLED-BY-HOST: toolu_cancel');
    });
    it('error status → resultOverride receives lastError with code/message/detail', async () => {
        parentClient.reset([
            {
                toolCalls: [
                    {
                        id: 'toolu_error',
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
                profiles: [makeSubagentProfile('explore', subagentClient, [makeFailingTool('fail')])],
                store: subagentStore,
                resultOverride: async (result) => {
                    receivedResults.push(result);
                    return `ERROR-BY-HOST: ${result.lastError?.code} — ${result.lastError?.message}`;
                },
            },
        });
        expect(receivedResults).toHaveLength(1);
        expect(receivedResults[0].status).toBe('error');
        expect(receivedResults[0].lastError).toBeTruthy();
        expect(receivedResults[0].lastError?.code).toBe('subagent_runtime_error');
        expect(receivedResults[0].lastError?.message).toContain('boom: upstream LLM failure');
        expect(typeof receivedResults[0].lastError?.detail).not.toBe('undefined');
        const runDoc = Array.from(subagentStore.runs.values())[0];
        expect(runDoc.status).toBe('error');
        const toolResult = parentStore.stored.find((m) => m.type === 'tool');
        expect((toolResult as {
            content: string;
        }).content).toContain('ERROR-BY-HOST: subagent_runtime_error');
    });
    it('resultOverride is NOT called on the SIGTERM handoff path (batch abandoned, no return string yet)', async () => {
        parentClient.reset([
            {
                toolCalls: [
                    {
                        id: 'toolu_handoff',
                        name: 'subagent',
                        arguments: JSON.stringify({ task: 'find X', mode: 'explore' }),
                    },
                ],
            },
        ]);
        subagentClient.reset([
            { toolCalls: [{ id: 'toolu_S1', name: 'echo', arguments: JSON.stringify({ text: 'hi' }) }] },
            { content: 'never reached' },
        ]);
        let draining = false;
        const originalChat = subagentClient.chat.bind(subagentClient);
        let call = 0;
        subagentClient.chat = async (req) => {
            call++;
            const res = await originalChat(req);
            if (call === 1)
                draining = true;
            return res;
        };
        let overrideCalled = false;
        const runtime = new AgentRuntime({
            store: parentStore,
            sessionId,
            isDraining: () => draining,
        });
        await runtime.run({
            client: parentClient,
            systemPrompt: 'parent',
            tools: [],
            keyId: 'k1',
            subagent: {
                profiles: [makeSubagentProfile('explore', subagentClient)],
                store: subagentStore,
                resultOverride: async (result) => {
                    overrideCalled = true;
                    return 'should not be reached';
                },
            },
        });
        expect(overrideCalled).toBe(false);
        expect(subagentStore.activeAnchors.has(sessionId)).toBe(true);
    });
});
