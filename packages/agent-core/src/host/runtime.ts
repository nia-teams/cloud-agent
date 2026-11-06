import { nanoid } from 'nanoid';
import { NOOP_LOGGER } from '../types.js';
import type { AgentHost, AgentHostConfig, InjectMessageOptions, InjectMessageResult, OpenSnapshotStreamOptions, } from './types.js';
import { INTERNAL_TIMINGS, type InternalTimings } from './types.js';
import { createConsumer, type Consumer } from './consumer.js';
import { enqueueInput } from './pending-inputs.js';
import { getCurrentSeq as libGetCurrentSeq, replayEvents } from './events.js';
import { COL_SESSIONS, broadcastChannel as libBroadcastChannel, subagentBroadcastChannel as libSubagentBroadcastChannel, subagentEventStreamId as libSubagentEventStreamId, triggerChannel, triggerPattern, } from './schema.js';
import { createDocStoreSubagentStore, SUBAGENT_CANCEL_CHANNEL_PREFIX, } from './subagent-store.js';
import { cancelSubagentInProcessByToolCallId } from '../tools/builtin/subagent.js';
import { openSnapshotStream } from './snapshot-stream.js';
import type { SnapshotReply } from '../protocol/snapshot-stream.js';
import { startCron as libStartCron, startScheduledTask as libStartScheduledTask } from './cron/index.js';
import type { CronConfig, CronHandle, ScheduledTaskConfig } from './cron/types.js';
export function createAgentHost(config: AgentHostConfig): AgentHost {
    const timings: InternalTimings = INTERNAL_TIMINGS;
    const { docStore, pubSub, logger = NOOP_LOGGER } = config;
    const resolvedConfig = { ...config, logger };
    const consumerId = `consumer-${nanoid()}`;
    const subagentStore = createDocStoreSubagentStore(docStore);
    let consumer: Consumer | null = null;
    let scanTimer: ReturnType<typeof setInterval> | null = null;
    let triggerUnsubscribe: (() => Promise<void>) | null = null;
    let subagentCancelUnsubscribe: (() => Promise<void>) | null = null;
    let started = false;
    let stopping = false;
    async function selfHealingScan(): Promise<void> {
        if (!consumer || stopping)
            return;
        if (consumer.isDraining)
            return;
        const scanStart = Date.now();
        logger.info({ consumerId }, 'host.scan · enter');
        try {
            const now = new Date();
            const candidatesWithInbox = await docStore.find<{
                _id: string;
            }>(COL_SESSIONS, {
                'pendingInputs.0': { $exists: true },
                $or: [
                    { activeRun: null },
                    { 'activeRun.expiresAt': { $lt: now } },
                ],
            }, {
                projection: { _id: 1 } as Record<string, 1>,
                limit: 200,
            });
            const candidatesWithStaleLock = await docStore.find<{
                _id: string;
            }>(COL_SESSIONS, { 'activeRun.expiresAt': { $lt: now } }, {
                projection: { _id: 1 } as Record<string, 1>,
                limit: 200,
            });
            const candidatesWithWakeRequest = await docStore.find<{
                _id: string;
                runtimeWakeSessionFilter?: Record<string, unknown> | null;
                runtimeWakeRequestId?: string;
            }>(COL_SESSIONS, {
                runtimeWakeRequestedAt: { $exists: true },
                $or: [
                    { activeRun: null },
                    { activeRun: { $exists: false } },
                    { 'activeRun.expiresAt': { $lt: now } },
                ],
            }, {
                projection: { _id: 1, runtimeWakeSessionFilter: 1, runtimeWakeRequestId: 1 } as Record<string, 1>,
                limit: 200,
            });
            const scanMs = Date.now() - scanStart;
            logger.info({
                consumerId,
                inbox: candidatesWithInbox.length,
                staleLock: candidatesWithStaleLock.length,
                wakeRequested: candidatesWithWakeRequest.length,
                scanMs,
            }, 'host.scan · result');
            const seen = new Set<string>();
            const dispatch = (sid: string) => {
                if (seen.has(sid))
                    return;
                seen.add(sid);
                if (consumer!.isDraining || stopping)
                    return;
                void consumer!.processSession(sid).catch((err) => {
                    logger.warn({ err, sessionId: sid }, 'host.scan · processSession failed');
                });
            };
            for (const doc of candidatesWithInbox)
                dispatch(String(doc._id));
            for (const doc of candidatesWithStaleLock)
                dispatch(String(doc._id));
            for (const doc of candidatesWithWakeRequest) {
                const sid = String(doc._id);
                if (seen.has(sid))
                    continue;
                seen.add(sid);
                if (consumer!.isDraining || stopping)
                    continue;
                if (!doc.runtimeWakeRequestId)
                    continue;
                const expectedFilter = doc.runtimeWakeSessionFilter ?? {};
                void consumer!.processSession(sid, {
                    sessionFilter: {
                        ...expectedFilter,
                        runtimeWakeRequestId: doc.runtimeWakeRequestId,
                    },
                    wakeRequestId: doc.runtimeWakeRequestId,
                }).catch((err) => {
                    logger.warn({ err, sessionId: sid }, 'host.scan · guarded wake processSession failed');
                });
            }
        }
        catch (err) {
            logger.warn({ err, scanMs: Date.now() - scanStart, consumerId }, 'host.scan · self-healing scan failed');
        }
    }
    async function start(): Promise<void> {
        if (started) {
            throw new Error('agent-runtime already started');
        }
        started = true;
        consumer = createConsumer({ config: resolvedConfig, timings, consumerId, subagentStore });
        const cancelPattern = `${SUBAGENT_CANCEL_CHANNEL_PREFIX}*`;
        subagentCancelUnsubscribe = await pubSub.psubscribe(cancelPattern, (channel) => {
            if (!channel.startsWith(SUBAGENT_CANCEL_CHANNEL_PREFIX))
                return;
            const toolCallId = channel.slice(SUBAGENT_CANCEL_CHANNEL_PREFIX.length);
            if (!toolCallId)
                return;
            const found = cancelSubagentInProcessByToolCallId(toolCallId);
            logger.info({ toolCallId, found }, 'host.subagent-cancel · dispatch');
        });
        const pattern = triggerPattern(timings.channelPrefix);
        const triggerPrefix = triggerChannel(timings.channelPrefix, '');
        logger.info({ consumerId, pattern, triggerPrefix }, 'host.start · subscribing trigger pattern');
        triggerUnsubscribe = await pubSub.psubscribe(pattern, (channel, payload) => {
            logger.info({ consumerId, channel }, 'host.trigger · psubscribe callback fired');
            if (!consumer || consumer.isDraining || stopping)
                return;
            if (!channel.startsWith(triggerPrefix))
                return;
            const sessionId = channel.slice(triggerPrefix.length);
            if (!sessionId)
                return;
            void (async () => {
                let wakePayload: {
                    sessionFilter?: Record<string, unknown>;
                    wakeRequestId?: string;
                } | undefined;
                if (payload) {
                    try {
                        wakePayload = JSON.parse(payload) as {
                            sessionFilter?: Record<string, unknown>;
                            wakeRequestId?: string;
                        };
                    }
                    catch (err) {
                        logger.warn({ err, sessionId }, 'host.trigger · invalid guarded wake payload');
                        return;
                    }
                }
                await consumer!.processSession(sessionId, wakePayload?.wakeRequestId
                    ? {
                        sessionFilter: {
                            ...(wakePayload.sessionFilter ?? {}),
                            runtimeWakeRequestId: wakePayload.wakeRequestId,
                        },
                        wakeRequestId: wakePayload.wakeRequestId,
                    }
                    : undefined);
            })().catch((err) => {
                logger.warn({ err, sessionId }, 'host.trigger · processSession failed');
            });
        });
        logger.info({ consumerId, pattern }, 'host.start · trigger psubscribe ready');
        void selfHealingScan();
        scanTimer = setInterval(selfHealingScan, timings.scanIntervalMs);
        logger.info({ consumerId, channelPrefix: timings.channelPrefix, scanIntervalMs: timings.scanIntervalMs }, 'agent-runtime started');
    }
    async function stop(): Promise<void> {
        if (!started || stopping)
            return;
        stopping = true;
        if (scanTimer) {
            clearInterval(scanTimer);
            scanTimer = null;
        }
        if (triggerUnsubscribe) {
            try {
                await triggerUnsubscribe();
            }
            catch (err) {
                logger.warn({ err }, 'host.stop · trigger unsubscribe failed');
            }
            triggerUnsubscribe = null;
        }
        if (subagentCancelUnsubscribe) {
            try {
                await subagentCancelUnsubscribe();
            }
            catch (err) {
                logger.warn({ err }, 'host.stop · subagent-cancel unsubscribe failed');
            }
            subagentCancelUnsubscribe = null;
        }
        if (consumer) {
            consumer.startDraining();
            let drainResult: Awaited<ReturnType<typeof consumer.awaitDrain>>;
            try {
                drainResult = await consumer.awaitDrain(timings.drainTimeoutMs);
            }
            catch (err) {
                logger.warn({ err }, 'host.stop · awaitDrain threw unexpectedly');
                drainResult = { timedOut: false, abortedSessionIds: [] };
            }
            if (drainResult.timedOut && drainResult.abortedSessionIds.length > 0) {
                logger.warn({
                    inFlightCount: drainResult.abortedSessionIds.length,
                    sessionIds: drainResult.abortedSessionIds,
                }, 'host.stop · awaitDrain timeout · publishing handoff triggers');
                await Promise.allSettled(drainResult.abortedSessionIds.map((sid) => pubSub
                    .publish(triggerChannel(timings.channelPrefix, sid), '')
                    .catch((pubErr) => logger.warn({ err: pubErr, sessionId: sid }, 'host.stop · handoff trigger publish failed'))));
            }
        }
        logger.info({ consumerId }, 'agent-runtime stopped');
    }
    async function injectMessage(opts: InjectMessageOptions): Promise<InjectMessageResult> {
        const result = await enqueueInput(docStore, opts);
        try {
            await pubSub.publish(triggerChannel(timings.channelPrefix, opts.sessionId), '');
        }
        catch (err) {
            logger.warn({ err, sessionId: opts.sessionId }, 'host.injectMessage · trigger publish failed · scan will recover');
        }
        return result;
    }
    async function wakeUp(sessionId: string, opts: {
        sessionFilter?: Record<string, unknown>;
    } = {}): Promise<boolean> {
        const wakeRequestId = nanoid();
        try {
            const marked = await docStore.updateOne(COL_SESSIONS, { _id: sessionId, ...(opts.sessionFilter ?? {}) }, {
                $set: {
                    runtimeWakeRequestedAt: new Date(),
                    runtimeWakeSessionFilter: opts.sessionFilter ?? null,
                    runtimeWakeRequestId: wakeRequestId,
                },
            });
            if (marked.matchedCount === 0)
                return false;
        }
        catch (err) {
            logger.warn({ err, sessionId }, 'host.wakeUp · durable wake request failed');
            return false;
        }
        if (consumer?.requestPostReleaseWakeUp(sessionId))
            return true;
        try {
            await pubSub.publish(triggerChannel(timings.channelPrefix, sessionId), JSON.stringify({ sessionFilter: opts.sessionFilter, wakeRequestId }));
        }
        catch (err) {
            logger.warn({ err, sessionId }, 'host.wakeUp · publish failed · durable marker will recover');
        }
        return true;
    }
    async function open(reply: SnapshotReply, opts: OpenSnapshotStreamOptions): Promise<void> {
        return openSnapshotStream({ docStore, pubSub, timings, logger }, reply, opts);
    }
    async function replay(sessionId: string, sinceEventId: number): Promise<string[]> {
        return replayEvents(docStore, sessionId, sinceEventId);
    }
    async function getCurrentSeq(sessionId: string): Promise<number> {
        return libGetCurrentSeq(docStore, sessionId);
    }
    function broadcastChannel(sessionId: string): string {
        return libBroadcastChannel(timings.channelPrefix, sessionId);
    }
    function subagentBroadcastChannel(sessionId: string, toolCallId: string): string {
        return libSubagentBroadcastChannel(timings.channelPrefix, sessionId, toolCallId);
    }
    function subagentEventStreamId(sessionId: string, toolCallId: string): string {
        return libSubagentEventStreamId(sessionId, toolCallId);
    }
    async function publish(sessionId: string, payload: string): Promise<void> {
        await pubSub.publish(broadcastChannel(sessionId), payload);
    }
    async function subscribeBroadcast(sessionId: string, handler: (payload: string) => void): Promise<() => Promise<void>> {
        return pubSub.subscribe(broadcastChannel(sessionId), handler);
    }
    function startCron<P>(cronConfig: CronConfig<P>): CronHandle {
        return libStartCron<P>({ logger, ...cronConfig });
    }
    function startScheduledTask(taskConfig: ScheduledTaskConfig): CronHandle {
        return libStartScheduledTask({ logger, ...taskConfig });
    }
    return {
        start,
        stop,
        injectMessage,
        wakeUp,
        openSnapshotStream: open,
        replayEvents: replay,
        getCurrentSeq,
        broadcastChannel,
        subagentBroadcastChannel,
        subagentEventStreamId,
        publish,
        subscribeBroadcast,
        startCron,
        startScheduledTask,
    };
}
