import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { ObjectId } from 'mongodb';
import { until } from './runtime-durable-shared.mjs';
export const parentToolCallId = 'acceptance_subagent_call';
const sentinelToolCallId = 'acceptance_sentinel_call';
const sentinelResult = 'checkpointed-sentinel-result';
const profileName = 'acceptance-child';
const terminalAnswer = 'reply:subagent-checkpoint-recovery';
const hasSentinel = messages => messages?.some(m => m.type === 'tool' && m.toolCallId === sentinelToolCallId && m.content === sentinelResult);
export function subagentConfig(infra, { scenario, worker }, send) {
    return async (sessionId) => {
        const record = async (role, request, action) => {
            assert(Array.isArray(request.messages));
            for (const message of request.messages) {
                assert(['event', 'assistant', 'tool', 'system_injection'].includes(message.type), 'Model must receive canonical AgentMessage history');
                assert(!('role' in message) && !('tool_call_id' in message), 'Provider wire messages must stay inside provider adapters');
            }
            const runs = await infra.db.collection('subagent_runs').find({ sessionId: new ObjectId(sessionId) }).toArray();
            const { insertedId } = await infra.db.collection('acceptance_model_calls').insertOne({
                scenario, sessionId, worker, pid: process.pid, role, action, at: new Date(), completed: false,
                childRunIds: runs.map(r => r._id.toHexString()), parentToolCallId,
                sawSentinel: hasSentinel(request.messages),
            });
            return async (response) => {
                await infra.db.collection('acceptance_model_calls').updateOne({ _id: insertedId }, { $set: { completed: true } });
                return { content: null, usage: { promptTokens: 1, completionTokens: 1 }, ...response };
            };
        };
        const client = chat => ({ getProviderName: () => 'openai', getModelName: () => 'acceptance-mock', chat });
        const childClient = client(async (request) => {
            const seen = hasSentinel(request.messages);
            const finish = await record('child', request, seen ? 'after-sentinel' : 'request-sentinel');
            if (!seen) {
                assert.equal(worker, 'A', 'Recovery must supply the checkpointed sentinel result to B');
                return finish({ toolCalls: [{ id: sentinelToolCallId, name: 'acceptance_sentinel', arguments: '{}' }], stopReason: 'tool_use' });
            }
            if (worker === 'A') {
                await send({ type: 'checkpoint', checkpoint: 'child-result-persisted', worker, pid: process.pid, sessionId, parentToolCallId });
                await new Promise(() => { });
            }
            assert.equal(worker, 'B');
            return finish({ content: 'child-recovered', stopReason: 'end_turn' });
        });
        return {
            keyId: 'local-test', systemPrompt: 'test', tools: [],
            client: client(async (request) => {
                const result = request.messages.filter(m => m.type === 'tool' && m.toolCallId === parentToolCallId);
                const finish = await record('parent', request, result.length ? 'terminal' : 'request-child');
                if (!result.length) {
                    assert.equal(worker, 'A', 'B must replay the persisted parent tool call without asking the parent model again');
                    return finish({ toolCalls: [{ id: parentToolCallId, name: 'subagent', arguments: JSON.stringify({ task: 'Run sentinel, then finish', mode: profileName }) }], stopReason: 'tool_use' });
                }
                assert.equal(result.length, 1);
                assert(result[0].content.includes('child-recovered'));
                assert.equal(worker, 'B');
                return finish({ content: terminalAnswer, stopReason: 'end_turn' });
            }),
            subagentProfiles: [{ name: profileName, description: 'Local checkpoint acceptance', rolePrompt: 'Execute sentinel then finish', client: childClient,
                    tools: [{ name: 'acceptance_sentinel', description: 'Persist a local invocation receipt', inputSchema: { type: 'object', properties: {} },
                            async execute() {
                                await infra.db.collection('acceptance_sentinel_calls').insertOne({ sessionId, worker, pid: process.pid, parentToolCallId, at: new Date() });
                                return sentinelResult;
                            } }],
                }],
        };
    };
}
export async function subagentScenario({ infra, database, startWorker, killWorker, cleanupWorkers, guard, failed }) {
    const scenario = 'subagent-checkpoint-recovery';
    const sessionId = randomBytes(12).toString('hex');
    const sessionOid = new ObjectId(sessionId);
    const keyPrefix = `runtime_acceptance:${randomUUID()}:`;
    const states = [];
    const startedAt = Date.now();
    const read = () => infra.db.collection('sessions').findOne({ _id: sessionOid });
    const runs = () => infra.db.collection('subagent_runs').find({ sessionId: sessionOid }).toArray();
    const start = worker => {
        const state = startWorker(scenario, keyPrefix, worker);
        states.push(state);
        return state;
    };
    let childRunId;
    let messageId;
    try {
        const a = start('A');
        await a.ready;
        const requestId = randomUUID();
        await a.send({ type: 'inject', requestId, input: { sessionId, content: 'checkpoint child', userId: 'local-user', userName: 'Acceptance' } });
        ({ messageId } = await a.wait('injected', m => m.requestId === requestId));
        const checkpoint = await a.wait('checkpoint', m => m.checkpoint === 'child-result-persisted');
        assert.equal(checkpoint.pid, a.child.pid);
        assert.equal(checkpoint.parentToolCallId, parentToolCallId);
        const before = await guard(until(async () => {
            failed();
            const children = await runs();
            const doc = await read();
            return children.length === 1 && hasSentinel(children[0].messages) && doc?.activeSubagentTurn && { child: children[0], doc };
        }, 'Mongo child sentinel checkpoint and parent recovery anchor', 15000));
        childRunId = before.child._id.toHexString();
        assert.equal(before.child.status, 'running');
        assert.equal(before.child.toolCallId, parentToolCallId);
        assert.equal(before.child.profileName, profileName);
        assert.deepEqual(before.doc.activeSubagentTurn.runIds.map(id => id.toHexString()), [childRunId]);
        assert.equal(before.doc.activeSubagentTurn.parentTurnId, before.child.parentTurnId);
        assert.equal(before.doc.activeSubagentTurn.parentAssistantSnapshot.toolCalls.filter(t => t.id === parentToolCallId && t.name === 'subagent').length, 1);
        assert(before.doc.activeRun && new Date(before.doc.activeRun.expiresAt).getTime() > Date.now());
        assert.equal(await infra.db.collection('acceptance_sentinel_calls').countDocuments({ sessionId }), 1);
        await killWorker(a);
        const b = start('B');
        await b.ready;
        assert.notEqual(a.child.pid, b.child.pid);
        const settled = await guard(until(async () => {
            failed();
            const doc = await read();
            const children = await runs();
            return doc && !doc.activeRun && !doc.activeSubagentTurn && doc.pendingInputs?.length === 0 &&
                doc.messages?.some(m => m.type === 'assistant' && m.content === terminalAnswer) &&
                children.length === 1 && children[0].status === 'complete' && { doc, child: children[0] };
        }, 'checkpointed child recovery via default TTL and self-healing scan'));
        assert.equal(settled.child._id.toHexString(), childRunId);
        assert.equal(settled.child.toolCallId, parentToolCallId);
        assert(hasSentinel(settled.child.messages));
        assert.equal(settled.child.messages.filter(m => m.type === 'tool' && m.toolCallId === sentinelToolCallId).length, 1);
        assert.equal(settled.child.messages.filter(m => m.type === 'assistant' && m.content === 'child-recovered').length, 1);
        assert.equal(settled.doc.messages.filter(m => m.type === 'tool').length, 1);
        assert.equal(settled.doc.messages.filter(m => m.type === 'tool' && m.toolCallId === parentToolCallId).length, 1);
        assert.equal(settled.doc.messages.filter(m => m.type === 'assistant' && !m.toolCalls?.length).length, 1);
        assert.equal(settled.doc.messages.filter(m => m.meta?.messageId === messageId).length, 1);
        assert.deepEqual(settled.doc.pendingInputs, []);
        assert(!settled.doc.activeSubagentTurn);
        assert(!settled.doc.activeRun);
        await cleanupWorkers(states);
        const attempts = await infra.db.collection('acceptance_model_calls').find({ sessionId }).toArray();
        assert.deepEqual(attempts.map(c => [c.worker, c.role, c.action, c.completed]), [
            ['A', 'parent', 'request-child', true], ['A', 'child', 'request-sentinel', true],
            ['A', 'child', 'after-sentinel', false], ['B', 'child', 'after-sentinel', true], ['B', 'parent', 'terminal', true],
        ]);
        for (const attempt of attempts) {
            assert.equal(attempt.pid, states.find(s => s.worker === attempt.worker).child.pid);
            assert.equal(attempt.parentToolCallId, parentToolCallId);
            if (attempt.role === 'child' || attempt.worker === 'B')
                assert.deepEqual(attempt.childRunIds, [childRunId]);
            if (attempt.role === 'child' && attempt.action === 'after-sentinel')
                assert.equal(attempt.sawSentinel, true);
        }
        assert.equal(await infra.db.collection('acceptance_sentinel_calls').countDocuments({ sessionId }), 1);
        assert.equal((await runs()).length, 1);
        console.log(JSON.stringify({ type: 'scenario', status: 'passed', scenario, database, keyPrefix, sessionId, messageId, childRunId, parentToolCallId,
            elapsedMs: Date.now() - startedAt, workers: states.map(s => ({ worker: s.worker, pid: s.child.pid })), attempts,
            recovery: { worker: 'B', sameChildRun: true, persistedSentinelObserved: true, sentinelInvocations: 1, parentToolResults: 1, parentTerminalAnswers: 1 },
            guarantee: 'checkpointed child recovery only; no exactly-once external effects or completion transaction-window guarantee' }));
    }
    catch (error) {
        const attempts = await infra.db.collection('acceptance_model_calls').find({ sessionId }).toArray().catch(() => []);
        console.error(JSON.stringify({ type: 'scenario', status: 'failed', scenario, database, keyPrefix, sessionId, messageId, childRunId, parentToolCallId,
            workers: states.map(s => ({ worker: s.worker, pid: s.child.pid })), attempts, error: error.stack }));
        throw error;
    }
    finally {
        await cleanupWorkers(states);
    }
}
