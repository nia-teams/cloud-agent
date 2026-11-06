import { nanoid } from 'nanoid';
import { createDefaultBuiltinPlugins } from '../builtins/index.js';
import { AgentRuntime as TurnRuntime, assertExplicitToolList } from '../runtime.js';
import { NOOP_LOGGER, type AgentEvent, type AgentHooks, type AgentMessage, type Logger, type RunOptions, } from '../types.js';
import type { AgentHostConfig, DocStore, InternalTimings, PubSub, } from './types.js';
import { acquireLock, holderFilter, releaseLock, renewLock } from './lock.js';
import { appendEvent, clearTurnEvents, getCurrentSeq, injectEventId, nextEventSeq, } from './events.js';
import { createConversationStore } from './conversation-store.js';
import { broadcastChannel, COL_EVENTS, COL_SESSIONS, subagentBroadcastChannel, subagentEventStreamId, triggerChannel, } from './schema.js';
import { findOrphanSlicePoint, sanitizeOrphanToolCalls, isSessionSettled, shouldRunTurn, } from './wakeup.js';
export interface ConsumerOpts {
    config: AgentHostConfig;
    timings: InternalTimings;
    consumerId: string;
    subagentStore?: import('../types.js').SubagentStore;
}
export interface Consumer {
    processSession(sessionId: string, opts?: {
        sessionFilter?: Record<string, unknown>;
        wakeRequestId?: string;
    }): Promise<void>;
    requestPostReleaseWakeUp(sessionId: string): boolean;
    startDraining(): void;
    get isDraining(): boolean;
    get activeSessionIds(): ReadonlyArray<string>;
    awaitDrain(timeoutMs: number): Promise<{
        timedOut: boolean;
        abortedSessionIds: ReadonlyArray<string>;
    }>;
}
export function createConsumer(opts: ConsumerOpts): Consumer {
    const { config, timings, consumerId, subagentStore } = opts;
    const { docStore, pubSub, logger = NOOP_LOGGER } = config;
    const active = new Map<string, AbortController>();
    const postReleaseWakeUps = new Set<string>();
    const sessionStallStates = new Map<string, {
        lockAcquiredAt: number;
        lastEventAt: number;
        firstEventSeen: boolean;
    }>();
    let draining = false;
    let drainResolve: (() => void) | null = null;
    function checkDrainComplete(): void {
        if (draining && active.size === 0 && drainResolve) {
            const r = drainResolve;
            drainResolve = null;
            r();
        }
    }
    async function releaseOwnedTurn(sessionId: string, turnId: string): Promise<boolean> {
        const released = await releaseLock(docStore, { sessionId, holder: consumerId });
        if (!released || !config.onTurnReleased)
            return released;
        try {
            await config.onTurnReleased({ sessionId, turnId, holder: consumerId });
        }
        catch (err) {
            logger.warn({ err, sessionId, turnId, consumerId }, 'host.consumer · onTurnReleased failed after activeRun release');
        }
        return released;
    }
    async function emitEvent(sessionId: string, turnId: string | null, rawPayload: string): Promise<void> {
        let seq: number;
        try {
            seq = await nextEventSeq(docStore, sessionId);
        }
        catch (err) {
            logger.warn({ err, sessionId }, 'host.emitEvent · seq alloc failed');
            return;
        }
        const stamped = injectEventId(rawPayload, seq);
        try {
            await appendEvent(docStore, { sessionId, turnId, seq, payload: stamped });
        }
        catch (err) {
            logger.warn({ err, sessionId, seq }, 'host.emitEvent · append failed');
        }
        try {
            await pubSub.publish(broadcastChannel(timings.channelPrefix, sessionId), stamped);
        }
        catch (err) {
            logger.warn({ err, sessionId, seq }, 'host.emitEvent · publish failed');
        }
    }
    async function runOneTurn(sessionId: string, turnId: string, abortCtrl: AbortController): Promise<{
        didWork: boolean;
    }> {
        if (!(await shouldRunTurn(docStore, sessionId))) {
            return { didWork: false };
        }
        try {
            const tailDoc = await docStore.findOne<{
                messages?: AgentMessage[];
            }>(COL_SESSIONS, { _id: sessionId }, { projection: { messages: 1 } as Record<string, 1> });
            const msgs = tailDoc?.messages ?? [];
            const slicePoint = findOrphanSlicePoint(msgs);
            if (slicePoint >= 0) {
                const repairedMessages = sanitizeOrphanToolCalls(msgs);
                logger.info({
                    sessionId,
                    slicePoint,
                    droppedCount: msgs.length - repairedMessages.length,
                    totalMessages: msgs.length,
                }, 'host.consumer · slicing forward orphan tool_use before turn');
                const repairResult = await docStore.updateOne(COL_SESSIONS, holderFilter(sessionId, consumerId), { $set: { messages: repairedMessages, updatedAt: new Date() } });
                if (repairResult.matchedCount === 0) {
                    logger.warn({ sessionId, consumerId }, 'host.consumer · lock lost during orphan repair · aborting turn');
                    abortCtrl.abort();
                    return { didWork: false };
                }
                if (!(await shouldRunTurn(docStore, sessionId))) {
                    return { didWork: false };
                }
            }
        }
        catch (err) {
            logger.warn({ err, sessionId }, 'host.consumer · orphan sanitize failed · proceeding with raw history');
        }
        let agentCfg: Awaited<ReturnType<typeof config.resolveAgentConfig>>;
        try {
            agentCfg = await config.resolveAgentConfig(sessionId);
            assertExplicitToolList(agentCfg);
        }
        catch (err) {
            logger.error({ err, sessionId }, 'host.consumer · resolveAgentConfig threw · releasing lock · no retry');
            return { didWork: false };
        }
        const actualTurnId = turnId;
        let lockLost = false;
        const baseStore = createConversationStore({
            store: docStore,
            sessionId,
            holder: consumerId,
            renewTtlMs: timings.lockTtlMs,
            getDraining: () => draining,
            onLockLost: () => {
                if (!lockLost) {
                    lockLost = true;
                    abortCtrl.abort();
                    logger.warn({ sessionId, turnId: actualTurnId }, 'host.consumer · lock lost mid-turn · aborting');
                }
            },
        });
        const store: typeof baseStore = {
            ...baseStore,
            async persist(messages) {
                await baseStore.persist(messages);
                if (lockLost)
                    return;
                try {
                    await clearTurnEvents(docStore, sessionId, actualTurnId);
                }
                catch (err) {
                    logger.warn({ err, sessionId, turnId: actualTurnId }, 'host.persist · clearTurnEvents failed · turn-end sweep will recover');
                }
            },
        };
        const turnRuntime = new TurnRuntime({
            store,
            sessionId,
            plugins: createDefaultBuiltinPlugins({
                contextPruning: config.contextPruning !== false,
                guardrailConfig: agentCfg.guardrailConfig,
                largeToolResult: agentCfg.largeToolResult,
            }),
            maxLoopIterations: timings.maxLoopIterations,
            llmCallTimeoutMs: timings.llmCallTimeoutMs,
            llmIdleTimeoutMs: timings.llmIdleTimeoutMs,
            logger,
            isDraining: () => draining,
            ...(agentCfg.formatMessagesForLLM
                ? { formatMessagesForLLM: agentCfg.formatMessagesForLLM }
                : {}),
            ...(agentCfg.usage ? { usage: agentCfg.usage } : {}),
            ...(agentCfg.prefetchHook
                ? { prefetchHook: agentCfg.prefetchHook }
                : {}),
        });
        const inflightEmits: Promise<void>[] = [];
        let emitChain: Promise<void> = Promise.resolve();
        const onEvent = (ev: AgentEvent) => {
            try {
                const stall = sessionStallStates.get(sessionId);
                if (stall) {
                    stall.lastEventAt = Date.now();
                    if (!stall.firstEventSeen)
                        stall.firstEventSeen = true;
                }
                const payload = JSON.stringify(ev);
                emitChain = emitChain
                    .then(async () => {
                    await emitEvent(sessionId, actualTurnId, payload);
                    void Promise.resolve().then(() => config.onEvent?.({ sessionId, turnId: actualTurnId, event: ev })).catch((err) => {
                        logger.warn({ err, sessionId, turnId: actualTurnId }, 'host.onEvent callback failed');
                    });
                })
                    .catch((err) => {
                    logger.warn({ err, sessionId, turnId: actualTurnId }, 'host event delivery failed');
                });
                inflightEmits.push(emitChain);
            }
            catch (err) {
                logger.warn({ err, sessionId, turnId: actualTurnId }, 'host.onEvent · serialize failed');
            }
        };
        const childEmitChains = new Map<string, Promise<void>>();
        const childInflightEmits: Promise<void>[] = [];
        const awaitChildEmitChain = async (toolCallId: string): Promise<void> => {
            await (childEmitChains.get(toolCallId) ?? Promise.resolve());
        };
        const checkpointChildEvents = async (toolCallId: string, _childTurnId: string): Promise<number | undefined> => {
            await awaitChildEmitChain(toolCallId);
            const streamId = subagentEventStreamId(sessionId, toolCallId);
            try {
                return await getCurrentSeq(docStore, streamId);
            }
            catch (err) {
                logger.warn({ err, sessionId, toolCallId, streamId }, 'host.consumer · read child checkpoint seq failed');
                return undefined;
            }
        };
        const publishChildEvent = (toolCallId: string, event: AgentEvent): void => {
            const streamId = subagentEventStreamId(sessionId, toolCallId);
            const channel = subagentBroadcastChannel(timings.channelPrefix, sessionId, toolCallId);
            const previous = childEmitChains.get(toolCallId) ?? Promise.resolve();
            const current = previous.then(async () => {
                let rawPayload: string;
                try {
                    rawPayload = JSON.stringify(event);
                }
                catch (err) {
                    logger.warn({ err, sessionId, toolCallId }, 'host.consumer · serialize child event failed');
                    return;
                }
                const eventTurnId = (event as {
                    turnId?: unknown;
                }).turnId;
                const turnId = typeof eventTurnId === 'string' && eventTurnId
                    ? eventTurnId
                    : null;
                let payload = rawPayload;
                let seq: number | undefined;
                try {
                    seq = await nextEventSeq(docStore, streamId);
                    payload = injectEventId(rawPayload, seq);
                    await appendEvent(docStore, {
                        sessionId: streamId,
                        turnId,
                        seq,
                        payload,
                    });
                }
                catch (err) {
                    logger.warn({ err, sessionId, toolCallId, streamId, seq }, 'host.consumer · persist child event failed · publishing live without replay guarantee');
                }
                try {
                    await pubSub.publish(channel, payload);
                }
                catch (err) {
                    logger.warn({ err, sessionId, toolCallId, streamId, seq }, 'host.consumer · publishChildEvent failed');
                }
                if (event.type === 'turn_end' && turnId) {
                    try {
                        await clearTurnEvents(docStore, streamId, turnId);
                    }
                    catch (err) {
                        logger.warn({ err, sessionId, toolCallId, streamId, turnId }, 'host.consumer · clear child turn events failed · TTL will recover');
                    }
                }
            });
            const guarded = current.catch((err) => {
                logger.warn({ err, sessionId, toolCallId, streamId }, 'host.consumer · child event chain failed');
            });
            childEmitChains.set(toolCallId, guarded);
            childInflightEmits.push(guarded);
        };
        let subagentRunOpt: RunOptions['subagent'] | undefined;
        if (agentCfg.subagentProfiles && agentCfg.subagentProfiles.length > 0) {
            if (subagentStore) {
                subagentRunOpt = {
                    profiles: agentCfg.subagentProfiles,
                    hostManagedTool: agentCfg.subagentHostManagedTool,
                    store: subagentStore,
                    publishChildEvent,
                    checkpointChildEvents,
                    ...(agentCfg.subagentInputOverride
                        ? { inputOverride: agentCfg.subagentInputOverride }
                        : {}),
                    ...(agentCfg.subagentResultOverride
                        ? { resultOverride: agentCfg.subagentResultOverride }
                        : {}),
                };
            }
            else {
                logger.warn({ sessionId, turnId: actualTurnId }, 'host.consumer · AgentConfig has subagentProfiles but SubagentStore is not wired · dropping subagent for this turn');
            }
        }
        const runOpts: RunOptions = {
            turnId,
            client: agentCfg.client,
            systemPrompt: agentCfg.systemPrompt,
            tools: agentCfg.tools,
            keyId: agentCfg.keyId,
            ...(agentCfg.resolveToolDefinitions
                ? { resolveToolDefinitions: agentCfg.resolveToolDefinitions }
                : {}),
            ...(agentCfg.contextWindow !== undefined
                ? { contextWindow: agentCfg.contextWindow }
                : {}),
            ...(agentCfg.hooks ? { hooks: agentCfg.hooks } : {}),
            ...(subagentRunOpt ? { subagent: subagentRunOpt } : {}),
            onEvent,
            abortSignal: abortCtrl.signal,
        };
        try {
            await turnRuntime.run(runOpts);
        }
        catch (err) {
            logger.error({ err, sessionId, turnId: actualTurnId }, 'host.consumer · turn-runtime.run threw outside the turn error boundary');
        }
        finally {
            if (inflightEmits.length > 0) {
                await Promise.allSettled(inflightEmits);
            }
            if (childInflightEmits.length > 0) {
                await Promise.allSettled(childInflightEmits);
            }
            try {
                await clearTurnEvents(docStore, sessionId, actualTurnId);
            }
            catch (err) {
                logger.warn({ err, sessionId, turnId: actualTurnId }, 'host.consumer · clearTurnEvents failed · TTL will sweep');
            }
        }
        if (draining) {
            await releaseOwnedTurn(sessionId, turnId);
            try {
                await pubSub.publish(triggerChannel(timings.channelPrefix, sessionId), '');
            }
            catch (err) {
                logger.warn({ err, sessionId }, 'host.consumer · handoff trigger publish failed · scan will recover');
            }
        }
        return { didWork: true };
    }
    async function retireSettledWakeRequest(sessionId: string, opts: {
        sessionFilter?: Record<string, unknown>;
        wakeRequestId?: string;
    }): Promise<void> {
        const doc = await docStore.findOne<{
            messages?: AgentMessage[];
            runtimeWakeRequestId?: string;
            inputGeneration?: number;
            activeRun?: {
                holder: string;
                turnId: string;
                expiresAt: Date;
            } | null;
        }>(COL_SESSIONS, { _id: sessionId }, {
            projection: { messages: 1, inputGeneration: 1, activeRun: 1, runtimeWakeRequestId: 1 },
        });
        if (!doc)
            return;
        const requestId = doc.runtimeWakeRequestId;
        if (opts.wakeRequestId !== undefined && opts.wakeRequestId !== requestId)
            return;
        const oldRun = doc.activeRun;
        const now = new Date();
        if (oldRun != null && (!(oldRun.expiresAt instanceof Date)
            || !Number.isFinite(oldRun.expiresAt.getTime()) || oldRun.expiresAt >= now
            || typeof oldRun.holder !== 'string' || !oldRun.holder
            || typeof oldRun.turnId !== 'string' || !oldRun.turnId))
            return;
        if (!oldRun && !requestId)
            return;
        const messages = doc.messages ?? [];
        if (!isSessionSettled(messages.at(-1), false))
            return;
        const tailPath = `messages.${messages.length - 1}`;
        const settledShape = messages.length > 0
            ? {
                messages: { $size: messages.length },
                [tailPath]: { $eq: messages.at(-1) },
            }
            : { $or: [{ messages: { $exists: false } }, { messages: { $size: 0 } }] };
        const retired = await docStore.updateOne(COL_SESSIONS, {
            _id: sessionId,
            runtimeWakeRequestId: requestId === undefined ? { $exists: false } : requestId,
            inputGeneration: doc.inputGeneration === undefined ? { $exists: false } : doc.inputGeneration,
            'pendingInputs.0': { $exists: false },
            $and: [
                opts.sessionFilter ?? {},
                oldRun ? {
                    'activeRun.holder': oldRun.holder,
                    'activeRun.turnId': oldRun.turnId,
                    'activeRun.expiresAt': { $eq: oldRun.expiresAt, $lt: now },
                } : { activeRun: null },
                settledShape,
            ],
        }, {
            $unset: {
                ...(oldRun ? { activeRun: '' } : {}),
                ...(requestId ? { runtimeWakeRequestedAt: '', runtimeWakeSessionFilter: '', runtimeWakeRequestId: '' } : {}),
            },
        });
        if (retired.modifiedCount !== 1)
            return;
        logger.info({ consumerId, sessionId, turnId: oldRun?.turnId }, 'host.process · settled ownership/wake retired');
        if (!oldRun)
            return;
        try {
            await clearTurnEvents(docStore, sessionId, oldRun.turnId);
        }
        catch (err) {
            logger.warn({ err, sessionId, turnId: oldRun.turnId }, 'host.process · retired turn event cleanup failed · TTL will sweep');
        }
        try {
            await config.onTurnReleased?.({ sessionId, turnId: oldRun.turnId, holder: oldRun.holder });
        }
        catch (err) {
            logger.warn({ err, sessionId, turnId: oldRun.turnId }, 'host.process · onTurnReleased failed after settled retirement');
        }
    }
    async function processSession(sessionId: string, opts: {
        sessionFilter?: Record<string, unknown>;
        wakeRequestId?: string;
    } = {}): Promise<void> {
        if (active.has(sessionId)) {
            logger.info({ consumerId, sessionId, reason: 'active-in-flight' }, 'host.process · silent return');
            return;
        }
        if (draining) {
            logger.info({ consumerId, sessionId, reason: 'draining' }, 'host.process · silent return');
            return;
        }
        if (!(await shouldRunTurn(docStore, sessionId))) {
            await retireSettledWakeRequest(sessionId, opts);
            logger.info({ consumerId, sessionId, reason: 'settled' }, 'host.process · silent return');
            return;
        }
        const turnId = nanoid();
        const acq = await acquireLock(docStore, {
            sessionId,
            holder: consumerId,
            turnId,
            ttlMs: timings.lockTtlMs,
            extraFilter: opts.sessionFilter,
        });
        if (!acq.acquired) {
            logger.info({
                consumerId,
                sessionId,
                reason: 'cas-lost',
                winningHolder: acq.currentHolder ?? null,
                winningExpiresAt: acq.currentExpiresAt ?? null,
            }, 'host.process · silent return');
            return;
        }
        try {
            await docStore.deleteMany(COL_EVENTS, { sessionId });
        }
        catch (err) {
            logger.error({ err, consumerId, sessionId }, 'host.process · inherited event cleanup failed · releasing lock');
            try {
                await releaseOwnedTurn(sessionId, turnId);
            }
            catch {
            }
            return;
        }
        logger.info({ consumerId, sessionId }, 'host.process · lock acquired · inherited events cleared · entering turn loop');
        if (opts.wakeRequestId) {
            await docStore.updateOne(COL_SESSIONS, {
                ...holderFilter(sessionId, consumerId),
                runtimeWakeRequestId: opts.wakeRequestId,
            }, {
                $unset: {
                    runtimeWakeRequestedAt: '',
                    runtimeWakeSessionFilter: '',
                    runtimeWakeRequestId: '',
                },
            });
        }
        const abortCtrl = new AbortController();
        active.set(sessionId, abortCtrl);
        const stallState = {
            lockAcquiredAt: Date.now(),
            lastEventAt: Date.now(),
            firstEventSeen: false,
        };
        sessionStallStates.set(sessionId, stallState);
        let renewAbort = false;
        const renewTimer = setInterval(() => {
            if (renewAbort)
                return;
            void (async () => {
                const nowMs = Date.now();
                const stallReason = !stallState.firstEventSeen
                    ? nowMs - stallState.lockAcquiredAt > timings.preTurnStallMs
                        ? 'pre-turn-stall'
                        : null
                    : nowMs - stallState.lastEventAt > timings.inTurnStallMs
                        ? 'in-turn-stall'
                        : null;
                if (stallReason) {
                    renewAbort = true;
                    abortCtrl.abort();
                    logger.error({
                        sessionId,
                        consumerId,
                        reason: stallReason,
                        lockAcquiredAt: stallState.lockAcquiredAt,
                        lastEventAt: stallState.lastEventAt,
                        firstEventSeen: stallState.firstEventSeen,
                        elapsedSinceAcquireMs: nowMs - stallState.lockAcquiredAt,
                        elapsedSinceLastEventMs: nowMs - stallState.lastEventAt,
                    }, 'host.consumer · stall detected · stopping renew · letting lock expire for self-heal');
                    return;
                }
                try {
                    const ok = await renewLock(docStore, {
                        sessionId,
                        holder: consumerId,
                        ttlMs: timings.lockTtlMs,
                    });
                    if (!ok) {
                        renewAbort = true;
                        abortCtrl.abort();
                        logger.warn({ sessionId }, 'host.consumer · renew failed · lock lost · aborting');
                    }
                }
                catch (err) {
                    logger.warn({ err, sessionId }, 'host.consumer · renew threw');
                }
            })();
        }, timings.lockRenewMs);
        try {
            const { didWork: _didWork } = await runOneTurn(sessionId, turnId, abortCtrl);
            if (!draining && !abortCtrl.signal.aborted) {
                await releaseOwnedTurn(sessionId, turnId);
            }
        }
        catch (err) {
            logger.error({ err, sessionId }, 'host.consumer · processSession crashed · releasing lock');
            try {
                await releaseOwnedTurn(sessionId, turnId);
            }
            catch {
            }
        }
        finally {
            clearInterval(renewTimer);
            active.delete(sessionId);
            sessionStallStates.delete(sessionId);
            checkDrainComplete();
            if (!draining && postReleaseWakeUps.delete(sessionId)) {
                queueMicrotask(() => {
                    void (async () => {
                        const requested = await docStore.findOne<{
                            runtimeWakeSessionFilter?: Record<string, unknown> | null;
                            runtimeWakeRequestId?: string;
                        }>(COL_SESSIONS, { _id: sessionId, runtimeWakeRequestedAt: { $exists: true } }, { projection: { runtimeWakeSessionFilter: 1, runtimeWakeRequestId: 1 } });
                        if (!requested?.runtimeWakeRequestId)
                            return;
                        const expectedFilter = requested.runtimeWakeSessionFilter ?? {};
                        await processSession(sessionId, {
                            sessionFilter: {
                                ...expectedFilter,
                                runtimeWakeRequestId: requested.runtimeWakeRequestId,
                            },
                            wakeRequestId: requested.runtimeWakeRequestId,
                        });
                    })().catch((err) => {
                        logger.warn({ err, sessionId }, 'host.consumer · post-release wakeUp failed');
                    });
                });
            }
        }
    }
    return {
        processSession,
        requestPostReleaseWakeUp(sessionId: string): boolean {
            if (draining || !active.has(sessionId))
                return false;
            postReleaseWakeUps.add(sessionId);
            return true;
        },
        startDraining(): void {
            draining = true;
            checkDrainComplete();
        },
        get isDraining(): boolean {
            return draining;
        },
        get activeSessionIds(): ReadonlyArray<string> {
            return Array.from(active.keys());
        },
        awaitDrain(timeoutMs: number): Promise<{
            timedOut: boolean;
            abortedSessionIds: ReadonlyArray<string>;
        }> {
            if (active.size === 0)
                return Promise.resolve({ timedOut: false, abortedSessionIds: [] });
            return new Promise((resolve) => {
                const timer = setTimeout(() => {
                    const stuck = Array.from(active.keys());
                    for (const ctrl of active.values()) {
                        try {
                            ctrl.abort();
                        }
                        catch {
                        }
                    }
                    drainResolve = null;
                    resolve({ timedOut: true, abortedSessionIds: stuck });
                }, timeoutMs);
                drainResolve = () => {
                    clearTimeout(timer);
                    resolve({ timedOut: false, abortedSessionIds: [] });
                };
            });
        },
    };
}
