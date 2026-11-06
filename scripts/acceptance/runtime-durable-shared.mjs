import { createAgentHost } from '@nia-teams/agent-core/host';
import { createMongoDocStore } from '@nia-teams/agent-core/docstore-mongo';
import { createRedisPubSub } from '@nia-teams/agent-core/pubsub-redis';
import { MongoClient } from 'mongodb';
import Redis from 'ioredis';
export function localUrls(env = process.env) {
    const mongo = env.MONGODB_URI;
    const redis = env.REDIS_URL;
    for (const [value, protocols] of [[mongo, ['mongodb:']], [redis, ['redis:', 'rediss:']]]) {
        if (!value)
            throw new Error('MONGODB_URI and REDIS_URL are required');
        const url = new URL(value);
        if (!protocols.includes(url.protocol) || !['localhost', '127.0.0.1', '[::1]', '::1'].includes(url.hostname)) {
            throw new Error('Acceptance services must use a single loopback hostname');
        }
        if (url.search)
            throw new Error('Acceptance URLs must omit query options (including replica discovery)');
    }
    return { mongo, redis };
}
export async function infrastructure(database, keyPrefix) {
    if (!/^runtime_acceptance_[a-f0-9]{32}$/.test(database))
        throw new Error('Invalid generated database name');
    const urls = localUrls();
    const mongo = new MongoClient(urls.mongo, { directConnection: true, serverSelectionTimeoutMS: 5000, socketTimeoutMS: 10000 });
    const redis = new Redis(urls.redis, { connectTimeout: 5000, maxRetriesPerRequest: 1, retryStrategy: () => null });
    const warnings = [];
    redis.on('error', err => warnings.push({ level: 'error', source: 'redis', message: err.message }));
    try {
        await mongo.connect();
        await redis.ping();
    }
    catch (error) {
        redis.disconnect();
        await mongo.close();
        throw error;
    }
    const db = mongo.db(database);
    const docStore = createMongoDocStore({ db });
    const pubSub = createRedisPubSub({ redis, keyPrefix });
    const logger = Object.fromEntries(['debug', 'info', 'warn', 'error'].map(level => [level, (...args) => {
            if (level === 'warn' || level === 'error')
                warnings.push({ level, args: args.map(arg => arg instanceof Error ? { message: arg.message, stack: arg.stack } : arg) });
        }]));
    return { db, docStore, pubSub, logger, warnings, makeRuntime(extra = {}) {
            return createAgentHost({ docStore, pubSub, logger, contextPruning: false,
                resolveAgentConfig: async () => { throw new Error('Observer must never run a model'); }, ...extra });
        }, async close() { redis.disconnect(); await mongo.close(); } };
}
export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
export async function until(check, label, ms = 140000) {
    const deadline = Date.now() + ms;
    do {
        const result = await check();
        if (result)
            return result;
        await sleep(100);
    } while (Date.now() < deadline);
    throw new Error(`Timeout: ${label} (${ms}ms)`);
}
