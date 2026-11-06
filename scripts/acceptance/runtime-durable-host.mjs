import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { infrastructure, localUrls, sleep, until } from './runtime-durable-shared.mjs';
import { subagentScenario } from './runtime-durable-subagent.mjs';
localUrls();
const database = `runtime_acceptance_${randomBytes(16).toString('hex')}`;
const owned = new Set();
let infra;
let mayDrop = false;
let rejectFailure;
let failure;
const failed = new Promise((_, reject) => { rejectFailure = reject; });
failed.catch(() => { });
function fail(error) { failure ??= error; rejectFailure(failure); }
const guard = promise => Promise.race([promise, failed]);
const overallTimer = setTimeout(() => fail(new Error('Overall acceptance deadline: 8 minutes')), 480000);
for (const signal of ['SIGINT', 'SIGTERM'])
    process.on(signal, () => fail(new Error(`Interrupted: ${signal}`)));
function startWorker(scenario, keyPrefix, worker, mode = 'normal') {
    const child = fork(new URL('./runtime-durable-worker.mjs', import.meta.url), [], {
        stdio: ['ignore', 'inherit', 'inherit', 'ipc'], execArgv: [],
    });
    const state = { child, worker, messages: [], expectedExit: false, exited: false };
    owned.add(state);
    child.on('message', message => {
        state.messages.push(message);
        if (message.type === 'error')
            fail(new Error(`${scenario}/${worker}: ${message.error?.stack ?? message.error?.message}`));
    });
    child.on('error', fail);
    state.exit = new Promise(resolve => child.once('exit', (code, signal) => {
        state.exited = true;
        if (!state.expectedExit)
            fail(new Error(`${scenario}/${worker} exited unexpectedly: ${code}/${signal}`));
        resolve({ code, signal });
    }));
    state.send = message => new Promise((resolve, reject) => child.send(message, error => error ? reject(error) : resolve()));
    state.wait = (type, predicate = () => true, timeout = 15000) => guard(until(() => {
        if (failure)
            throw failure;
        return state.messages.find(message => message.type === type && predicate(message));
    }, `${scenario}/${worker} IPC ${type}`, timeout));
    state.ready = (async () => {
        await state.send({ type: 'init', database, keyPrefix, scenario, worker, mode });
        const ready = await state.wait('ready');
        assert.equal(ready.pid, child.pid);
        assert.equal(state.exited, false);
        return ready;
    })();
    state.ready.catch(() => { });
    return state;
}
async function killWorker(state) {
    state.expectedExit = true;
    assert.equal(state.exited, false, 'Fault target must be alive');
    assert(state.child.kill('SIGKILL'));
    const exit = await guard(Promise.race([state.exit, sleep(5000).then(() => { throw new Error('SIGKILL exit timeout'); })]));
    assert.equal(exit.signal, 'SIGKILL');
}
async function cleanupWorkers(states) {
    await Promise.all(states.map(state => {
        if (state.cleanup)
            return state.cleanup;
        state.cleanup = (async () => {
            if (state.exited)
                return;
            state.expectedExit = true;
            if (state.child.connected)
                await state.send({ type: 'stop' }).catch(() => { });
            state.child.kill('SIGTERM');
            await Promise.race([state.exit, sleep(5000)]);
            if (!state.exited) {
                state.child.kill('SIGKILL');
                await Promise.race([state.exit, sleep(5000).then(() => { throw new Error(`Cleanup timeout for owned PID ${state.child.pid}`); })]);
            }
        })();
        return state.cleanup;
    }));
}
function assertIndependent(a, b) {
    assert.notEqual(a.child.pid, b.child.pid);
    for (const state of [a, b]) {
        assert.equal(state.exited, false);
        assert(state.messages.some(message => message.type === 'ready'));
        process.kill(state.child.pid, 0);
    }
}
async function scenario(name) {
    const startedAt = Date.now();
    const sessionId = `acceptance/session/${name}/${randomUUID()}`;
    const keyPrefix = `runtime_acceptance:${randomUUID()}:`;
    const states = [];
    const observer = infra.makeRuntime();
    const start = (worker, mode) => {
        const state = startWorker(name, keyPrefix, worker, mode);
        states.push(state);
        return state;
    };
    const read = () => infra.db.collection('sessions').findOne({ _id: sessionId });
    const input = { sessionId, content: `input:${name}`, userId: 'local-user', userName: 'Acceptance' };
    let messageId;
    let beforeSeq;
    let replayIds;
    let suppressed = 0;
    try {
        if (name === 'missed-pubsub-wake') {
            const quietObserver = infra.makeRuntime({ pubSub: { ...infra.pubSub, async publish(channel, payload) {
                        if (channel.startsWith('trigger:session:')) {
                            suppressed++;
                            return;
                        }
                        return infra.pubSub.publish(channel, payload);
                    } } });
            ({ messageId } = await quietObserver.injectMessage(input));
            const queued = await read();
            assert.equal(queued.pendingInputs.filter(p => p.id === messageId).length, 1);
            assert.equal(suppressed, 1);
            const a = start('A');
            const b = start('B');
            await Promise.all([a.ready, b.ready]);
            assertIndependent(a, b);
        }
        else {
            const mode = name === 'kill-before-inbox-transfer' ? 'before-transfer' : name === 'kill-mid-stream' ? 'mid-stream' : 'normal';
            const a = start('A', mode);
            await a.ready;
            let b;
            if (name === 'contention') {
                b = start('B');
                await b.ready;
                assertIndependent(a, b);
            }
            const requestId = randomUUID();
            await a.send({ type: 'inject', requestId, input });
            ({ messageId } = await a.wait('injected', message => message.requestId === requestId));
            assert.equal(typeof messageId, 'string');
            if (name !== 'contention') {
                await a.wait('checkpoint', message => message.checkpoint === mode);
                const doc = await read();
                assert(doc.activeRun && new Date(doc.activeRun.expiresAt).getTime() > Date.now(), 'A must hold a live default lock');
                if (name === 'kill-mid-stream') {
                    assert.equal(doc.messages.filter(p => p.meta?.messageId === messageId).length, 1);
                    const replay = await guard(until(async () => {
                        if (failure)
                            throw failure;
                        const events = (await observer.replayEvents(sessionId, 0)).map(line => JSON.parse(line));
                        return events.some(event => event.type === 'text_delta' && JSON.stringify(event).includes('partial')) && events;
                    }, 'buffered partial text delta', 15000));
                    replayIds = replay.map(event => event._eventId);
                    for (let i = 0; i < replayIds.length; i++) {
                        assert(Number.isSafeInteger(replayIds[i]) && replayIds[i] > 0);
                        if (i)
                            assert(replayIds[i] > replayIds[i - 1], 'Replay event IDs strictly increase');
                    }
                    beforeSeq = await observer.getCurrentSeq(sessionId);
                    assert(beforeSeq >= replayIds.at(-1));
                }
                b = start('B');
                await b.ready;
                assertIndependent(a, b);
                assert(new Date((await read()).activeRun.expiresAt).getTime() > Date.now(), 'Start B while A lock is live');
                await killWorker(a);
                if (name === 'kill-before-inbox-transfer') {
                    const atKill = await read();
                    assert.equal(atKill.pendingInputs.filter(p => p.id === messageId).length, 1, 'Input lost at transfer checkpoint: inbox must survive process death (baseline must fail)');
                    assert.equal((atKill.messages ?? []).filter(p => p.meta?.messageId === messageId).length, 0);
                }
            }
        }
        const settled = await guard(until(async () => {
            if (failure)
                throw failure;
            const doc = await read();
            return doc && !doc.activeRun && doc.pendingInputs?.length === 0 &&
                doc.messages?.some(p => p.type === 'assistant' && p.content === `reply:${name}`) && doc;
        }, `${name}: default TTL/scan completion`));
        assert.equal(settled.messages.filter(p => p.meta?.messageId === messageId).length, 1);
        const assistants = settled.messages.filter(p => p.type === 'assistant');
        assert.equal(assistants.length, 1);
        assert.equal(assistants[0].content, `reply:${name}`);
        assert.deepEqual(settled.pendingInputs, []);
        assert(!settled.activeRun);
        const calls = await infra.db.collection('acceptance_model_calls').find({ sessionId }).toArray();
        assert.equal(calls.length, name === 'kill-mid-stream' ? 2 : 1);
        assert.equal(calls.filter(call => call.completed).length, 1);
        const winner = calls.find(call => call.completed).worker;
        if (name.startsWith('kill-'))
            assert.equal(winner, 'B');
        const afterSeq = await observer.getCurrentSeq(sessionId);
        if (beforeSeq !== undefined)
            assert(afterSeq > beforeSeq, 'Sequence must advance across recovery');
        await cleanupWorkers(states);
        assert.equal(await infra.db.collection('acceptance_model_calls').countDocuments({ sessionId }), calls.length);
        console.log(JSON.stringify({ type: 'scenario', status: 'passed', scenario: name, database, sessionId, messageId,
            elapsedMs: Date.now() - startedAt, workers: states.map(s => ({ worker: s.worker, pid: s.child.pid })),
            winner, attempts: calls.map(call => ({ worker: call.worker, pid: call.pid, completed: call.completed })),
            modelAttempts: calls.length, successfulMockReturns: 1, persistedInputs: 1, persistedAssistants: 1,
            beforeSeq, afterSeq, replayIds, suppressedTriggers: suppressed,
            warnings: states.flatMap(s => s.messages.filter(m => m.type === 'stopped').flatMap(m => m.warnings ?? [])),
            guarantee: 'durable input and recovery only; no external-effect or provider exactly-once claim' }));
    }
    catch (error) {
        console.error(JSON.stringify({ type: 'scenario', status: 'failed', scenario: name, database, sessionId, messageId, error: error.stack }));
        throw error;
    }
    finally {
        await cleanupWorkers(states);
    }
}
try {
    infra = await infrastructure(database, `runtime_acceptance:observer:${randomUUID()}:`);
    if (failure)
        throw failure;
    assert.equal((await infra.db.listCollections({}, { nameOnly: true }).toArray()).length, 0, 'Generated DB must be fresh');
    mayDrop = true;
    for (const name of ['contention', 'kill-before-inbox-transfer', 'kill-mid-stream', 'missed-pubsub-wake']) {
        await guard(scenario(name));
    }
    await guard(subagentScenario({ infra, database, startWorker, killWorker, cleanupWorkers, guard,
        failed() { if (failure)
            throw failure; } }));
    console.log(JSON.stringify({ type: 'acceptance', status: 'passed', database, scenarios: 5 }));
}
catch (error) {
    console.error(JSON.stringify({ type: 'acceptance', status: 'failed', database, error: error.stack }));
    process.exitCode = 1;
}
finally {
    clearTimeout(overallTimer);
    try {
        await cleanupWorkers([...owned]);
        if (mayDrop)
            await infra.db.dropDatabase();
    }
    catch (error) {
        console.error(JSON.stringify({ type: 'cleanup', status: 'failed', error: error.stack }));
        process.exitCode = 1;
    }
    finally {
        await infra?.close();
    }
}
