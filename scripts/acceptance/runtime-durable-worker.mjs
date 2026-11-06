import { infrastructure, sleep } from './runtime-durable-shared.mjs';
import { subagentConfig } from './runtime-durable-subagent.mjs';
let infra;
let runtime;
let stopping = false;
const send = message => new Promise((resolve, reject) => {
    if (!process.connected)
        return reject(new Error('Parent IPC disconnected'));
    process.send(message, error => error ? reject(error) : resolve());
});
async function fatal(error) {
    try {
        await send({ type: 'error', error: { message: error.message, stack: error.stack } });
    }
    catch { }
    process.exitCode = 1;
    try {
        await infra?.close();
    }
    finally {
        process.exit(1);
    }
}
async function stop() {
    if (stopping)
        return;
    stopping = true;
    await runtime?.stop();
    await infra?.close();
    await send({ type: 'stopped', warnings: infra?.warnings });
    process.exit(0);
}
async function initialize(config) {
    const { database, keyPrefix, scenario, worker, mode } = config;
    infra = await infrastructure(database, keyPrefix);
    let checkpointed = false;
    if (mode === 'before-transfer') {
        const realUpdate = infra.docStore.updateOne.bind(infra.docStore);
        infra.docStore.updateOne = async (collection, filter, update, options) => {
            if (!checkpointed && collection === 'sessions' && update.$push?.messages) {
                checkpointed = true;
                await send({ type: 'checkpoint', checkpoint: 'before-transfer', worker });
                await new Promise(() => { });
            }
            return realUpdate(collection, filter, update, options);
        };
    }
    runtime = infra.makeRuntime({ resolveAgentConfig: scenario === 'subagent-checkpoint-recovery'
            ? subagentConfig(infra, config, send)
            : async (sessionId) => ({
                client: {
                    getProviderName: () => 'openai',
                    getModelName: () => 'acceptance-mock',
                    async chat(request) {
                        const { insertedId } = await infra.db.collection('acceptance_model_calls').insertOne({ scenario, worker, sessionId, pid: process.pid, at: new Date(), completed: false });
                        if (mode === 'mid-stream') {
                            await request.onStreamDelta({ type: 'text', content: 'partial' });
                            await send({ type: 'checkpoint', checkpoint: 'mid-stream', worker });
                            await new Promise(() => { });
                        }
                        await sleep(400);
                        await infra.db.collection('acceptance_model_calls').updateOne({ _id: insertedId }, { $set: { completed: true } });
                        return { content: `reply:${scenario}`, stopReason: 'end_turn', usage: { promptTokens: 1, completionTokens: 1 } };
                    },
                }, tools: [], keyId: 'local-test', systemPrompt: 'test',
            }) });
    await runtime.start();
    await send({ type: 'ready', worker, pid: process.pid });
}
process.on('message', message => {
    void (async () => {
        if (message.type === 'init')
            await initialize(message);
        else if (message.type === 'inject') {
            if (!runtime)
                throw new Error('Worker is not initialized');
            const result = await runtime.injectMessage(message.input);
            await send({ type: 'injected', requestId: message.requestId, ...result });
        }
        else if (message.type === 'stop')
            await stop();
        else
            throw new Error(`Unknown IPC message: ${message.type}`);
    })().catch(fatal);
});
process.on('SIGTERM', () => { void stop().catch(fatal); });
process.on('disconnect', () => { void stop().catch(fatal); });
process.on('uncaughtException', fatal);
process.on('unhandledRejection', fatal);
