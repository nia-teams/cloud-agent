import { nanoid } from 'nanoid';
import { isRateLimitError, rateLimitDelayMs, waitForRateLimit } from './rate-limit-retry.js';
import { buildTurnStart, buildTurnEnd, buildTurnError, buildThinkingStart, buildThinkingEnd, buildTextDelta, buildToolInputStart, buildToolInputDelta, buildToolCallStart, buildToolCallEnd, buildUsageUpdate, buildInterleaveStart, } from './protocol/event-builders.js';
import { MalformedToolArgumentsError } from '@nia-teams/ai/protocol';
import type { AgentMessage, AssistantMessage, ToolMessage, AiPostContext, ToolExecutionResult, EventMessage, LLMChatResponse, ToolDefinition, } from '@nia-teams/ai/protocol';
import { type AgentEvent, type AgentHooks, type AgentRuntimeConfig, type ExitKind, type ExitState, type HookSlot, type Logger, type RunOptions, type RuntimeState, type RuntimePluginHooks, type RuntimeToolResult, type Tool, type ToolContext, type UsageEntry, NOOP_LOGGER, } from './types.js';
import { createSubagentTool, isSubagentHandoffSignal, } from './tools/builtin/subagent.js';
const DEFAULT_MAX_LOOP_ITERATIONS = 200;
const DEFAULT_LLM_CALL_TIMEOUT_MS = 20 * 60 * 1000;
const DEFAULT_LLM_IDLE_TIMEOUT_MS = 5 * 60 * 1000;
function toToolDef(t: Tool): ToolDefinition {
    return {
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
        ...(t.deferLoading ? { deferLoading: true } : {}),
    };
}
function validateLLMTimeout(timeoutMs: number): void {
    if (!Number.isInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 0xFFFFFFFF) {
        throw new RangeError('LLM timeout must be an integer between 0 and 4294967295 ms');
    }
}
function createLLMDeadline(maxDurationMs: number, idleTimeoutMs: number) {
    validateLLMTimeout(maxDurationMs);
    validateLLMTimeout(idleTimeoutMs);
    const controller = new AbortController();
    let timeoutKind: 'idle' | 'max_duration' | undefined;
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    let disposed = false;
    const dispose = () => {
        disposed = true;
        clearTimeout(maxTimer);
        clearTimeout(idleTimer);
    };
    const abort = (kind: 'idle' | 'max_duration') => {
        timeoutKind = kind;
        dispose();
        controller.abort(new DOMException(kind === 'idle'
            ? 'The operation was aborted due to stream idle timeout'
            : 'The operation was aborted due to timeout', 'TimeoutError'));
    };
    const maxTimer = setTimeout(() => abort('max_duration'), maxDurationMs);
    maxTimer.unref?.();
    const touch = () => {
        if (disposed || idleTimeoutMs >= maxDurationMs)
            return;
        clearTimeout(idleTimer);
        idleTimer = setTimeout(() => abort('idle'), idleTimeoutMs);
        idleTimer.unref?.();
    };
    touch();
    return { signal: controller.signal, touch, dispose, get timeoutKind() { return timeoutKind; } };
}
function waitForLLMCompletion<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const cleanup = () => signal.removeEventListener('abort', onAbort);
        const onAbort = () => {
            cleanup();
            reject(signal.reason);
        };
        pending.then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
        if (signal.aborted)
            onAbort();
        else
            signal.addEventListener('abort', onAbort, { once: true });
    });
}
export function assertExplicitToolList(config: object): void {
    if (Object.hasOwn(config, 'builtinTools')) {
        throw new Error('builtinTools is no longer supported; assemble business tools in the host and pass tools explicitly');
    }
}
export class AgentRuntime {
    private readonly cfg: AgentRuntimeConfig;
    private readonly logger: Logger;
    constructor(cfg: AgentRuntimeConfig) {
        for (const field of ['contextPruning', 'contextPruner', 'guardrail', 'guardrailConfig', 'largeToolResult', 'builtinSteps']) {
            if (Object.hasOwn(cfg, field)) {
                throw new Error(`${field} is no longer a core option; pass plugins: createDefaultBuiltinPlugins({...}) instead`);
            }
        }
        this.cfg = cfg;
        this.logger = cfg.logger ?? NOOP_LOGGER;
    }
    async run(opts: RunOptions): Promise<void> {
        assertExplicitToolList(opts);
        const cfg = this.cfg;
        const logger = this.logger;
        const { client } = opts;
        for (const field of ['adapter', 'adapterCapabilities']) {
            if (Object.hasOwn(opts, field)) {
                throw new Error(`${field} is no longer a runtime option; configure provider conversion on the LLM client`);
            }
        }
        const turnId = opts.turnId ?? nanoid();
        const sessionId = cfg.sessionId;
        const maxLoopIterations = cfg.maxLoopIterations ?? DEFAULT_MAX_LOOP_ITERATIONS;
        const llmCallTimeoutMs = cfg.llmCallTimeoutMs ?? DEFAULT_LLM_CALL_TIMEOUT_MS;
        const llmIdleTimeoutMs = cfg.llmIdleTimeoutMs ?? DEFAULT_LLM_IDLE_TIMEOUT_MS;
        validateLLMTimeout(llmCallTimeoutMs);
        validateLLMTimeout(llmIdleTimeoutMs);
        const hookBags: AgentHooks[] = Array.isArray(opts.hooks)
            ? opts.hooks
            : opts.hooks
                ? [opts.hooks]
                : [];
        const onEvent = opts.onEvent ?? (() => undefined);
        const emit = (e: AgentEvent) => onEvent(e);
        const internalAbort = new AbortController();
        const userSignal = opts.abortSignal;
        const onUserAbort = () => internalAbort.abort();
        if (userSignal) {
            if (userSignal.aborted)
                internalAbort.abort();
            else
                userSignal.addEventListener('abort', onUserAbort, { once: true });
        }
        const signal = internalAbort.signal;
        const mergedToolsMap = new Map<string, Tool>();
        for (const t of opts.tools)
            mergedToolsMap.set(t.name, t);
        let subagentStoreForMount: import('./types.js').SubagentStore | undefined;
        let subagentProfilesForMount: import('./types.js').SubagentProfile[] | undefined;
        let publishChildEventForMount: ((toolCallId: string, event: AgentEvent) => void) | undefined;
        let checkpointChildEventsForMount: NonNullable<RunOptions['subagent']>['checkpointChildEvents'];
        let subagentInputOverrideForMount: NonNullable<RunOptions['subagent']>['inputOverride'];
        let subagentResultOverrideForMount: NonNullable<RunOptions['subagent']>['resultOverride'];
        let subagentExecutor: Tool | undefined;
        if (opts.subagent) {
            const { profiles, store: subagentStore, publishChildEvent, checkpointChildEvents, inputOverride, resultOverride, } = opts.subagent;
            if (!profiles || profiles.length === 0) {
                throw new Error('AgentRuntime.run: opts.subagent.profiles must be a non-empty array');
            }
            if (!subagentStore) {
                throw new Error('AgentRuntime.run: opts.subagent.store is required when profiles are supplied');
            }
            if (!opts.subagent.hostManagedTool && (mergedToolsMap.has('subagent') || opts.tools.some((t) => t.name === 'subagent'))) {
                throw new Error('AgentRuntime.run: cannot mount `subagent` tool — a tool with that name is already present. This is intentional to preserve subagent recursion guards.');
            }
            subagentStoreForMount = subagentStore;
            subagentProfilesForMount = profiles;
            publishChildEventForMount = publishChildEvent;
            checkpointChildEventsForMount = checkpointChildEvents;
            subagentInputOverrideForMount = inputOverride;
            subagentResultOverrideForMount = resultOverride;
        }
        const messages: AgentMessage[] = [];
        const state: RuntimeState = {
            messages,
            pending: [],
            systemPrompt: opts.systemPrompt,
            tools: [...mergedToolsMap.values()],
            metadata: { ...(opts.metadata ?? {}) },
            sessionId,
            turnId,
            loopIteration: 0,
            numLLMCalls: 0,
            newMessages: [],
        };
        const plugins: RuntimePluginHooks[] = [];
        try {
            for (const plugin of cfg.plugins ?? []) {
                plugins.push(plugin.create({ sessionId, turnId, logger }));
            }
        }
        catch (err) {
            state.exit = { kind: 'error', error: err instanceof Error ? err : new Error(String(err)) };
        }
        const pluginError = (err: unknown) => {
            state.exit = { kind: 'error', error: err instanceof Error ? err : new Error(String(err)) };
        };
        const incIteration = () => {
            (state as {
                loopIteration: number;
            }).loopIteration += 1;
        };
        const incNumLLMCalls = () => {
            (state as {
                numLLMCalls: number;
            }).numLLMCalls += 1;
        };
        const pendingActivationNames = new Set<string>();
        let warnedNoResolver = false;
        const makeToolCtx = (toolCallId: string, parentAssistantSnapshot?: AssistantMessage): ToolContext => ({
            metadata: state.metadata,
            sessionId,
            turnId,
            toolCallId,
            aiPostContext: [],
            signal,
            onEvent: (partial) => {
                emit({
                    ...partial,
                    sessionId,
                    turnId,
                    timestamp: Date.now(),
                });
            },
            isDraining: cfg.isDraining,
            parentAssistantSnapshot,
            ...(subagentExecutor ? {
                executeSubagent: (input: Record<string, unknown>) => subagentExecutor!.execute(input, makeToolCtx(toolCallId, parentAssistantSnapshot)),
            } : {}),
            activateTools: (names) => {
                if (!opts.resolveToolDefinitions) {
                    if (!warnedNoResolver) {
                        warnedNoResolver = true;
                        logger.warn({ sessionId, turnId, toolCallId, names }, 'ToolContext.activateTools called but RunOptions.resolveToolDefinitions is not wired · dropping (no-op)');
                    }
                    return;
                }
                for (const n of names) {
                    const existing = mergedToolsMap.get(n);
                    if (!existing || existing.deferLoading)
                        pendingActivationNames.add(n);
                }
            },
        });
        const runHooks = async (slot: HookSlot): Promise<void> => {
            for (const bag of hookBags) {
                const fn = bag[slot];
                if (!fn)
                    continue;
                try {
                    if (slot === 'afterAssistantPersist')
                        continue;
                    await (fn as (s: RuntimeState) => void | Promise<void>)(state);
                }
                catch (err) {
                    if (slot === 'afterTurn') {
                        logger.error({ sessionId, turnId, slot, err }, 'afterTurn hook threw; ignoring');
                        continue;
                    }
                    if (!state.exit) {
                        state.exit = {
                            kind: 'error',
                            error: err instanceof Error ? err : new Error(String(err)),
                        };
                    }
                    return;
                }
            }
        };
        const runAfterAssistantPersist = async (msg: AssistantMessage): Promise<void> => {
            for (const bag of hookBags) {
                const fn = bag.afterAssistantPersist;
                if (!fn)
                    continue;
                try {
                    await fn(state, msg);
                }
                catch (err) {
                    if (!state.exit) {
                        state.exit = {
                            kind: 'error',
                            error: err instanceof Error ? err : new Error(String(err)),
                        };
                    }
                    return;
                }
            }
        };
        const turnStartMs = Date.now();
        let lastInputTokens = 0;
        let totalInputTokens = 0;
        let totalOutputTokens = 0;
        let totalCachedTokens = 0;
        let totalCacheCreationTokens = 0;
        let totalReasoningTokens = 0;
        let totalUsdCost = 0;
        let malformedRecoveryCount = 0;
        logger.info({ sessionId, turnId, model: client.getModelName(), maxLoopIterations }, 'turn started');
        if (cfg.prefetchHook) {
            try {
                await cfg.prefetchHook(sessionId);
            }
            catch (err) {
                logger.warn({ sessionId, turnId, err }, 'prefetchHook threw · proceeding without prefetch');
            }
        }
        try {
            const initial = await cfg.store.loadAll();
            messages.push(...initial);
        }
        catch (err) {
            state.exit = {
                kind: 'error',
                error: err instanceof Error ? err : new Error(String(err)),
            };
        }
        emit(buildTurnStart({ sessionId, turnId }));
        let recoveryAnchor: {
            replayedToolCallIds: Set<string>;
            runIds: Array<string | {
                toHexString(): string;
            }>;
        } | undefined;
        if (!state.exit && opts.subagent) {
            try {
                const anchor = await opts.subagent.store.readActiveSubagentTurn(sessionId);
                if (anchor && anchor.parentAssistantSnapshot) {
                    state.pending.push(anchor.parentAssistantSnapshot);
                    const replayedToolCallIds = new Set<string>((anchor.parentAssistantSnapshot.toolCalls ?? []).map((tc) => tc.id));
                    recoveryAnchor = {
                        replayedToolCallIds,
                        runIds: anchor.runIds,
                    };
                    logger.info({
                        sessionId,
                        turnId,
                        parentTurnId: anchor.parentTurnId,
                        runIds: anchor.runIds,
                        replayedToolCallIds: Array.from(replayedToolCallIds),
                    }, 'subagent recovery · replaying parent assistant snapshot');
                }
            }
            catch (err) {
                logger.warn({ sessionId, turnId, err }, 'readActiveSubagentTurn threw · proceeding without recovery');
            }
        }
        if (subagentStoreForMount && subagentProfilesForMount) {
            const subagentTool = createSubagentTool({
                profiles: subagentProfilesForMount,
                store: subagentStoreForMount,
                parentPlugins: cfg.plugins,
                parentFormatMessagesForLLM: cfg.formatMessagesForLLM,
                parentMaxLoopIterations: cfg.maxLoopIterations,
                parentLlmCallTimeoutMs: cfg.llmCallTimeoutMs,
                parentLlmIdleTimeoutMs: cfg.llmIdleTimeoutMs,
                parentIsDraining: cfg.isDraining,
                logger,
                recoveryAnchor,
                publishChildEvent: publishChildEventForMount as ((toolCallId: string, event: Record<string, unknown>) => void) | undefined,
                checkpointChildEvents: checkpointChildEventsForMount,
                inputOverride: subagentInputOverrideForMount,
                resultOverride: subagentResultOverrideForMount,
            });
            subagentExecutor = subagentTool;
            if (!opts.subagent?.hostManagedTool) {
                mergedToolsMap.set('subagent', subagentTool);
                state.tools = [...mergedToolsMap.values()];
            }
        }
        if (!state.exit)
            await runHooks('beforeTurn');
        const sanitizeMessageForPersistence = (msg: AgentMessage): AgentMessage => {
            if (msg.type === 'assistant' && msg.toolCalls?.length) {
                return {
                    ...msg,
                    toolCalls: msg.toolCalls.map((tc) => ({
                        id: tc.id,
                        name: tc.name,
                        arguments: tc.malformedError ? '{}' : tc.arguments,
                    })),
                };
            }
            return msg;
        };
        const persistPending = async (): Promise<AgentMessage[]> => {
            if (state.pending.length === 0)
                return [];
            const batch = state.pending.map(sanitizeMessageForPersistence);
            state.pending = [];
            try {
                await cfg.store.persist(batch);
                messages.push(...batch);
            }
            catch (err) {
                state.pending = batch;
                state.exit = {
                    kind: 'error',
                    error: err instanceof Error ? err : new Error(String(err)),
                };
                return [];
            }
            for (const m of batch) {
                if (m.type === 'assistant') {
                    await runAfterAssistantPersist(m);
                    if (state.exit)
                        return batch;
                }
            }
            return batch;
        };
        const persistPendingBeforeSkip = async (): Promise<AgentMessage[]> => {
            if (state.exit?.kind !== 'skip' || state.pending.length === 0)
                return [];
            const requestedExit = state.exit;
            state.exit = undefined;
            const persisted = await persistPending();
            if (!state.exit)
                state.exit = requestedExit;
            return persisted;
        };
        const interleavePersist = async (): Promise<ToolMessage[]> => {
            const pendingAssistants: AgentMessage[] = [];
            const pendingTools: ToolMessage[] = [];
            const pendingTrailing: AgentMessage[] = [];
            for (const m of state.pending) {
                if (m.type === 'tool')
                    pendingTools.push(m);
                else if (m.type === 'assistant')
                    pendingAssistants.push(sanitizeMessageForPersistence(m));
                else
                    pendingTrailing.push(sanitizeMessageForPersistence(m));
            }
            state.pending = [];
            if (pendingAssistants.length > 0) {
                try {
                    await cfg.store.persist(pendingAssistants);
                    messages.push(...pendingAssistants);
                }
                catch (err) {
                    state.pending = [...pendingAssistants, ...pendingTools, ...pendingTrailing, ...state.pending];
                    state.exit = {
                        kind: 'error',
                        error: err instanceof Error ? err : new Error(String(err)),
                    };
                    return [];
                }
                for (const m of pendingAssistants) {
                    if (m.type === 'assistant') {
                        await runAfterAssistantPersist(m);
                        if (state.exit) {
                            state.pending = [...pendingTools, ...pendingTrailing, ...state.pending];
                            return [];
                        }
                    }
                }
            }
            const placeholderBatch: ToolMessage[] = pendingTools.map((m) => ({
                type: 'tool',
                toolCallId: m.toolCallId,
                content: this.cfg.interleavePlaceholder ?? '[Tool running...]',
                isError: false,
                turnId: m.turnId,
                timestamp: new Date(),
            }));
            if (placeholderBatch.length > 0) {
                try {
                    await cfg.store.persist(placeholderBatch);
                    messages.push(...placeholderBatch);
                }
                catch (err) {
                    state.pending = [...pendingTools, ...pendingTrailing, ...state.pending];
                    state.exit = {
                        kind: 'error',
                        error: err instanceof Error ? err : new Error(String(err)),
                    };
                    return [];
                }
            }
            let newMsgs: AgentMessage[] = [];
            try {
                newMsgs = await cfg.store.fetchNew();
            }
            catch (err) {
                state.pending = [...pendingTools, ...pendingTrailing, ...state.pending];
                state.exit = {
                    kind: 'error',
                    error: err instanceof Error ? err : new Error(String(err)),
                };
                return [];
            }
            if (newMsgs.length > 0) {
                (state as {
                    newMessages: readonly AgentMessage[];
                }).newMessages = newMsgs;
                const ids = newMsgs
                    .map((m) => 'meta' in m
                    ? ((m.meta as Record<string, unknown> | undefined)?.messageId as string | undefined)
                    : undefined)
                    .filter((id): id is string => !!id);
                emit(buildInterleaveStart({
                    sessionId,
                    turnId,
                    messageIds: ids.length > 0 ? ids : undefined,
                }));
                messages.push(...newMsgs);
                await runHooks('afterFetch');
            }
            const eventBatch: EventMessage[] = pendingTools.map((m) => ({
                type: 'event',
                eventType: 'tool.result',
                content: `[Tool Result] toolCallId=${m.toolCallId} isError=${!!m.isError}\n${m.content}`,
                timestamp: new Date(),
            }));
            if (eventBatch.length > 0) {
                try {
                    await cfg.store.persist(eventBatch);
                    messages.push(...eventBatch);
                }
                catch (err) {
                    state.pending = [...pendingTools, ...pendingTrailing, ...state.pending];
                    state.exit = {
                        kind: 'error',
                        error: err instanceof Error ? err : new Error(String(err)),
                    };
                    return [];
                }
            }
            const trailingBatch = [...pendingTrailing, ...state.pending].map(sanitizeMessageForPersistence);
            state.pending = [];
            if (trailingBatch.length > 0) {
                try {
                    await cfg.store.persist(trailingBatch);
                    messages.push(...trailingBatch);
                }
                catch (err) {
                    state.pending = [...trailingBatch, ...state.pending];
                    state.exit = {
                        kind: 'error',
                        error: err instanceof Error ? err : new Error(String(err)),
                    };
                    return pendingTools;
                }
            }
            return pendingTools;
        };
        while (!state.exit) {
            if (signal.aborted) {
                state.exit = { kind: 'aborted' };
                break;
            }
            if (state.loopIteration >= maxLoopIterations) {
                logger.error({ sessionId, turnId, loopIteration: state.loopIteration }, 'Hit max loop iterations');
                state.exit = {
                    kind: 'error',
                    error: new Error(`Hit max loop iterations (${maxLoopIterations})`),
                };
                break;
            }
            incIteration();
            const isRecoveryIteration = state.loopIteration === 1 && recoveryAnchor !== undefined;
            let assistantMsg: AssistantMessage;
            if (isRecoveryIteration) {
                const pendingTail = state.pending[state.pending.length - 1];
                if (!pendingTail ||
                    pendingTail.type !== 'assistant' ||
                    !pendingTail.toolCalls ||
                    pendingTail.toolCalls.length === 0) {
                    logger.warn({ sessionId, turnId }, 'recovery iteration · pending tail is not an unfulfilled assistant · falling back to normal flow');
                    continue;
                }
                assistantMsg = pendingTail;
                logger.info({
                    sessionId,
                    turnId,
                    loopIteration: state.loopIteration,
                    toolCallIds: pendingTail.toolCalls.map((tc) => tc.id),
                }, 'runtime · recovery iteration · goto EXEC_TOOLS with snapshot as assistantMsg');
            }
            else {
                let newMsgs: AgentMessage[] = [];
                try {
                    newMsgs = await cfg.store.fetchNew();
                }
                catch (err) {
                    state.exit = {
                        kind: 'error',
                        error: err instanceof Error ? err : new Error(String(err)),
                    };
                    break;
                }
                if (newMsgs.length > 0) {
                    if (state.numLLMCalls > 0) {
                        const ids = newMsgs
                            .map((m) => 'meta' in m
                            ? ((m.meta as Record<string, unknown> | undefined)?.messageId as string | undefined)
                            : undefined)
                            .filter((id): id is string => !!id);
                        emit(buildInterleaveStart({
                            sessionId,
                            turnId,
                            messageIds: ids.length > 0 ? ids : undefined,
                        }));
                    }
                    messages.push(...newMsgs);
                }
                (state as {
                    newMessages: readonly AgentMessage[];
                }).newMessages = newMsgs;
                await runHooks('afterFetch');
                await persistPendingBeforeSkip();
                if (state.exit)
                    break;
                await persistPending();
                if (state.exit)
                    break;
                const tail = messages[messages.length - 1];
                if (newMsgs.length === 0 &&
                    (messages.length === 0 ||
                        (tail?.type === 'assistant' &&
                            (!tail.toolCalls || tail.toolCalls.length === 0)))) {
                    state.exit = { kind: 'done' };
                    break;
                }
                let viewMessages: readonly AgentMessage[] = messages;
                try {
                    for (const plugin of plugins) {
                        if (plugin.transformContext) {
                            viewMessages = await plugin.transformContext({
                                messages: viewMessages, state,
                                model: client.getModelName(), contextWindow: opts.contextWindow,
                            });
                        }
                    }
                }
                catch (err) {
                    pluginError(err);
                    break;
                }
                if (state.exit)
                    break;
                let llmReadyMessages: readonly AgentMessage[] = viewMessages;
                if (cfg.formatMessagesForLLM) {
                    const chain = Array.isArray(cfg.formatMessagesForLLM)
                        ? cfg.formatMessagesForLLM
                        : [cfg.formatMessagesForLLM];
                    try {
                        let acc: AgentMessage[] = viewMessages as AgentMessage[];
                        for (const fn of chain) {
                            acc = await fn(acc);
                        }
                        llmReadyMessages = acc;
                    }
                    catch (err) {
                        logger.warn({ sessionId, turnId, err }, 'formatMessagesForLLM threw; falling back to raw messages');
                        llmReadyMessages = viewMessages;
                    }
                }
                if (pendingActivationNames.size > 0) {
                    const namesToResolve = [...pendingActivationNames];
                    pendingActivationNames.clear();
                    try {
                        const resolved = await opts.resolveToolDefinitions!(namesToResolve);
                        const resolvedNames = new Set(resolved.map((t) => t.name));
                        for (const t of resolved)
                            mergedToolsMap.set(t.name, t);
                        const missing = namesToResolve.filter((n) => !resolvedNames.has(n));
                        if (missing.length > 0) {
                            logger.warn({ sessionId, turnId, missing }, 'resolveToolDefinitions did not resolve some activated tool names · dropping those, continuing with the rest');
                        }
                        if (resolved.length > 0) {
                            state.tools = [...mergedToolsMap.values()];
                            logger.info({
                                sessionId,
                                turnId,
                                loopIteration: state.loopIteration,
                                activated: resolved.map((t) => t.name),
                            }, 'runtime · dynamic tool activation · resolved for next CALL_LLM');
                        }
                    }
                    catch (err) {
                        logger.warn({ sessionId, turnId, names: namesToResolve, err }, 'resolveToolDefinitions threw · activation dropped for this iteration · turn continues');
                    }
                }
                const toolDefs: ToolDefinition[] = state.tools.map(toToolDef);
                const llmMessages = llmReadyMessages as AgentMessage[];
                let thinkingStarted = false;
                let hasEmittedDelta = false;
                let callDeadline = createLLMDeadline(llmCallTimeoutMs, llmIdleTimeoutMs);
                let chatSignal = AbortSignal.any([signal, callDeadline.signal]);
                let rateLimitRetries = 0;
                let malformedRetries = 0;
                const rateLimitDeadline = Date.now() + 5 * 60000;
                const llmCallStartMs = Date.now();
                logger.info({
                    sessionId,
                    turnId,
                    iteration: state.loopIteration,
                    model: client.getModelName(),
                    msgCount: llmMessages.length,
                    toolCount: toolDefs.length,
                    timeoutMs: llmCallTimeoutMs,
                    idleTimeoutMs: Math.min(llmIdleTimeoutMs, llmCallTimeoutMs),
                }, 'LLM call start');
                let response: LLMChatResponse;
                try {
                    for (let attempt = 0;; attempt++) {
                        try {
                            chatSignal.throwIfAborted();
                            response = await waitForLLMCompletion(client.chat({
                                messages: llmMessages,
                                tools: toolDefs.length > 0 ? toolDefs : undefined,
                                systemPrompt: state.systemPrompt,
                                signal: chatSignal,
                                onStreamDelta: (delta) => {
                                    if (chatSignal.aborted)
                                        return;
                                    if (delta.type === 'tool_input_start') {
                                        callDeadline.touch();
                                        hasEmittedDelta = true;
                                        if (thinkingStarted) {
                                            emit(buildThinkingEnd({ sessionId, turnId }));
                                            thinkingStarted = false;
                                        }
                                        emit(buildToolInputStart({
                                            sessionId,
                                            turnId,
                                            toolCallId: delta.toolCallId as string,
                                            name: delta.toolName as string,
                                        }));
                                        return;
                                    }
                                    if (delta.type === 'tool_input_delta') {
                                        if (delta.toolCallId && (delta.partialJson ?? delta.content)) {
                                            callDeadline.touch();
                                            hasEmittedDelta = true;
                                            emit(buildToolInputDelta({
                                                sessionId,
                                                turnId,
                                                toolCallId: delta.toolCallId,
                                                partial_json: delta.partialJson ?? delta.content,
                                            }));
                                        }
                                        return;
                                    }
                                    if (!delta.content)
                                        return;
                                    if (delta.type === 'thinking') {
                                        callDeadline.touch();
                                        hasEmittedDelta = true;
                                        if (!thinkingStarted) {
                                            emit(buildThinkingStart({ sessionId, turnId }));
                                            thinkingStarted = true;
                                        }
                                    }
                                    else if (delta.type === 'text') {
                                        callDeadline.touch();
                                        hasEmittedDelta = true;
                                        if (thinkingStarted) {
                                            emit(buildThinkingEnd({ sessionId, turnId }));
                                            thinkingStarted = false;
                                        }
                                        emit(buildTextDelta({ sessionId, turnId, delta: delta.content }));
                                    }
                                },
                            }), chatSignal);
                            chatSignal.throwIfAborted();
                            break;
                        }
                        catch (err) {
                            if (thinkingStarted) {
                                emit(buildThinkingEnd({ sessionId, turnId }));
                                thinkingStarted = false;
                            }
                            signal.throwIfAborted();
                            if (isRateLimitError(err) && !hasEmittedDelta && rateLimitRetries < 2) {
                                const delayMs = rateLimitDelayMs(err);
                                if (delayMs !== null && Date.now() + delayMs < rateLimitDeadline) {
                                    rateLimitRetries++;
                                    logger.warn({ sessionId, turnId, retryAttempt: rateLimitRetries, delayMs }, 'LLM rate limit · waiting before retrying current model step');
                                    await waitForRateLimit(delayMs, signal);
                                    if (Date.now() >= rateLimitDeadline)
                                        throw err;
                                    callDeadline.dispose();
                                    callDeadline = createLLMDeadline(Math.min(llmCallTimeoutMs, Math.max(1, rateLimitDeadline - Date.now())), llmIdleTimeoutMs);
                                    chatSignal = AbortSignal.any([signal, callDeadline.signal]);
                                    continue;
                                }
                            }
                            chatSignal.throwIfAborted();
                            if (err instanceof MalformedToolArgumentsError) {
                                if (!hasEmittedDelta && malformedRetries === 0) {
                                    malformedRetries++;
                                    logger.warn({
                                        sessionId,
                                        turnId,
                                        errorType: err.name,
                                        upstreamRequestId: err.upstreamRequestId,
                                        toolName: err.toolName,
                                        retryAttempt: 1,
                                    }, 'LLM malformed tool arguments · retrying current model step once');
                                    continue;
                                }
                                if (malformedRecoveryCount < 1 &&
                                    err.partialResponse?.toolCalls?.length) {
                                    malformedRecoveryCount++;
                                    response = err.partialResponse;
                                    logger.warn({
                                        sessionId,
                                        turnId,
                                        errorType: err.name,
                                        upstreamRequestId: err.upstreamRequestId,
                                        toolName: err.toolName,
                                        malformedRecoveryCount,
                                    }, 'LLM malformed tool arguments · recovering via error tool_result');
                                    break;
                                }
                            }
                            throw err;
                        }
                    }
                }
                catch (err) {
                    if (thinkingStarted)
                        emit(buildThinkingEnd({ sessionId, turnId }));
                    const llmCallDurationMs = Date.now() - llmCallStartMs;
                    const isTimeout = err instanceof Error && err.name === 'TimeoutError';
                    if (signal.aborted) {
                        logger.info({ sessionId, turnId, iteration: state.loopIteration, llmCallDurationMs }, 'LLM call aborted');
                        state.exit = { kind: 'aborted' };
                    }
                    else {
                        logger.error({
                            sessionId,
                            turnId,
                            iteration: state.loopIteration,
                            model: client.getModelName(),
                            llmCallDurationMs,
                            isTimeout,
                            ...(callDeadline.timeoutKind ? { timeoutKind: callDeadline.timeoutKind } : {}),
                            ...(err instanceof MalformedToolArgumentsError
                                ? {
                                    errorType: err.name,
                                    upstreamRequestId: err.upstreamRequestId,
                                    toolName: err.toolName,
                                }
                                : { err }),
                        }, 'LLM call failed');
                        const wrapped = err instanceof Error ? err : new Error(String(err));
                        state.exit = { kind: 'error', error: wrapped };
                    }
                    break;
                }
                finally {
                    callDeadline.dispose();
                }
                if (thinkingStarted)
                    emit(buildThinkingEnd({ sessionId, turnId }));
                const llmCallDurationMs = Date.now() - llmCallStartMs;
                logger.info({
                    sessionId,
                    turnId,
                    iteration: state.loopIteration,
                    llmCallDurationMs,
                    contentChars: response.content?.length ?? 0,
                    toolCalls: response.toolCalls?.length ?? 0,
                    inputTokens: response.usage?.promptTokens,
                    outputTokens: response.usage?.completionTokens,
                    reasoningTokens: response.usage?.reasoningTokens,
                    cachedTokens: response.usage?.cachedTokens,
                    stopReason: response.stopReason,
                    apiModel: client.getModelName(),
                    ttftMs: response.timings?.ttftMs,
                    generateMs: response.timings?.generateMs,
                    outputTokensPerSec: response.timings?.outputTokensPerSec,
                }, 'LLM call done');
                if (signal.aborted) {
                    state.exit = { kind: 'aborted' };
                    break;
                }
                state.metadata.lastLLMTimings = response.timings;
                incNumLLMCalls();
                if (response.usage) {
                    lastInputTokens = response.usage.contextTokens ?? response.usage.promptTokens;
                    totalInputTokens += response.usage.promptTokens;
                    totalOutputTokens += response.usage.completionTokens;
                    totalCachedTokens += response.usage.cachedTokens ?? 0;
                    totalCacheCreationTokens += response.usage.cacheCreationTokens ?? 0;
                    totalReasoningTokens += response.usage.reasoningTokens ?? 0;
                    if (typeof response.usage.usdCost === 'number') {
                        totalUsdCost += response.usage.usdCost;
                    }
                    emit(buildUsageUpdate({ sessionId, turnId, inputTokens: lastInputTokens }));
                }
                if (response.stopReason === 'max_tokens' &&
                    !response.content?.trim() &&
                    (!response.toolCalls || response.toolCalls.length === 0)) {
                    const truncationError = new Error(`Response truncated at max_tokens during reasoning without producing output or tool calls.`);
                    logger.error({ sessionId, turnId, iteration: state.loopIteration, model: client.getModelName() }, truncationError.message);
                    state.exit = { kind: 'error', error: truncationError };
                    break;
                }
                assistantMsg = {
                    type: 'assistant',
                    content: response.content,
                    toolCalls: response.toolCalls?.map(tc => ({
                        id: tc.id, name: tc.name,
                        arguments: tc.malformedError ? '{}' : tc.arguments,
                        ...(tc.malformedError ? { malformedError: tc.malformedError } : {}),
                    })),
                    reasoning: response.reasoning || undefined,
                    reasoningSignature: response.reasoningSignature || undefined,
                    ...(response.reasoningDetails ? { reasoningDetails: response.reasoningDetails } : {}),
                    model: client.getModelName(),
                    turnId,
                    timestamp: new Date(),
                    stopReason: response.stopReason,
                    usedFallbackModel: response.usedFallbackModel,
                };
                state.pending.push(assistantMsg);
                await runHooks('afterLLM');
                if (state.exit)
                    break;
                if (state.pending.length === 0)
                    continue;
                if (!response.content && !response.reasoning && !response.toolCalls?.length &&
                    state.pending.length === 1 && state.pending[0] === assistantMsg) {
                    logger.warn({ sessionId, turnId, iteration: state.loopIteration, model: client.getModelName() }, 'LLM returned empty response — ending turn');
                    state.exit = { kind: 'done' };
                    break;
                }
                if (!assistantMsg.toolCalls || assistantMsg.toolCalls.length === 0) {
                    await persistPending();
                    if (state.exit)
                        break;
                    await runHooks('afterPersist');
                    if (state.exit)
                        break;
                    continue;
                }
            }
            const allToolCalls = assistantMsg.toolCalls ?? [];
            if (allToolCalls.length === 0)
                continue;
            await runHooks('beforeExecTools');
            if (state.exit)
                break;
            const fulfilledInPending = new Set<string>();
            for (const m of state.pending) {
                if (m.type === 'tool')
                    fulfilledInPending.add(m.toolCallId);
            }
            const unfulfilledToolCalls = allToolCalls.filter((tc) => !fulfilledInPending.has(tc.id));
            for (const tc of allToolCalls) {
                let parsedInput: Record<string, unknown> = {};
                try {
                    parsedInput = JSON.parse(tc.arguments);
                }
                catch {
                    logger.error({
                        sessionId,
                        turnId,
                        toolName: tc.name,
                        toolCallId: tc.id,
                        rawArgumentsLength: tc.arguments?.length ?? -1,
                    }, 'Tool call arguments JSON.parse failed');
                }
                emit(buildToolCallStart({
                    sessionId,
                    turnId,
                    toolCallId: tc.id,
                    name: tc.name,
                    input: parsedInput,
                }));
            }
            type PendingToolEnd = {
                toolCallId: string;
                durationMs: number;
            };
            const pendingToolEnds: PendingToolEnd[] = [];
            const emittedToolEndIds = new Set<string>();
            const emitPersistedToolEnds = (persistedResults: readonly ToolMessage[]): void => {
                const byId = new Map(persistedResults.map((m) => [m.toolCallId, m]));
                for (const pending of pendingToolEnds) {
                    if (emittedToolEndIds.has(pending.toolCallId))
                        continue;
                    const result = byId.get(pending.toolCallId);
                    if (!result)
                        continue;
                    emit(buildToolCallEnd({
                        sessionId,
                        turnId,
                        toolCallId: pending.toolCallId,
                        output: result.isError ? undefined : '',
                        error: result.isError ? '1' : undefined,
                        durationMs: pending.durationMs,
                    }));
                    emittedToolEndIds.add(pending.toolCallId);
                }
            };
            for (const tc of allToolCalls) {
                if (unfulfilledToolCalls.includes(tc))
                    continue;
                pendingToolEnds.push({ toolCallId: tc.id, durationMs: 0 });
            }
            const toolMap = new Map(state.tools.map((t) => [t.name, t]));
            if (recoveryAnchor && subagentExecutor && !toolMap.has('subagent')) {
                toolMap.set('subagent', subagentExecutor);
            }
            let handoffDetected = false;
            const toolResultBuffer = new Map<string, ToolMessage>();
            const toolEndBuffer = new Map<string, {
                toolCallId: string;
                durationMs: number;
            }>();
            const observedOutcomes = new Map<string, {
                toolName: string;
                parsedInput: Record<string, unknown>;
                message: ToolMessage;
            }>();
            const runToolCall = async (tc: (typeof unfulfilledToolCalls)[number]) => {
                let parsedInput: Record<string, unknown> = {};
                let argumentError = tc.malformedError;
                try {
                    const value: unknown = JSON.parse(tc.arguments);
                    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
                        throw new Error('Expected a JSON object');
                    }
                    parsedInput = value as Record<string, unknown>;
                }
                catch (err) {
                    argumentError = err instanceof Error ? err.message : String(err);
                }
                const truncated = assistantMsg.stopReason === 'max_tokens';
                if (argumentError || truncated) {
                    const message: ToolMessage = {
                        type: 'tool', toolCallId: tc.id,
                        content: truncated
                            ? 'Assistant response hit max_tokens. Tool execution was skipped for the entire batch. Reissue a concise, complete tool call.'
                            : `Tool arguments for "${tc.name}" were not a valid JSON object: ${argumentError}. The tool was NOT executed. Retry with a valid JSON object.`,
                        isError: true, turnId, timestamp: new Date(),
                    };
                    toolResultBuffer.set(tc.id, message);
                    toolEndBuffer.set(tc.id, { toolCallId: tc.id, durationMs: 0 });
                    return;
                }
                let halt: RuntimeToolResult | void = undefined;
                try {
                    for (const plugin of plugins) {
                        halt = await plugin.beforeToolCall?.({ toolCallId: tc.id, toolName: tc.name, args: parsedInput });
                        if (halt)
                            break;
                    }
                }
                catch (err) {
                    pluginError(err);
                    return;
                }
                const startMs = Date.now();
                let resultContent = '';
                let resultGuidance: AiPostContext[] = [];
                let isError = false;
                let sawHandoff = false;
                if (halt) {
                    resultContent = halt.content;
                    resultGuidance = halt.guidance ?? [];
                    isError = halt.isError ?? false;
                }
                else {
                    const tool = toolMap.get(tc.name);
                    try {
                        if (!tool)
                            throw new Error(`Unknown tool: ${tc.name}`);
                        const ctx = makeToolCtx(tc.id, assistantMsg);
                        const rawResult = await tool.execute(parsedInput, ctx);
                        if (typeof rawResult === 'string') {
                            resultContent = rawResult;
                        }
                        else {
                            resultContent = rawResult.content;
                            resultGuidance = rawResult.guidance ?? [];
                        }
                        if (ctx.aiPostContext?.length) {
                            resultGuidance = [...resultGuidance, ...ctx.aiPostContext];
                        }
                    }
                    catch (err) {
                        if (isSubagentHandoffSignal(err)) {
                            sawHandoff = true;
                            handoffDetected = true;
                        }
                        else {
                            resultContent = err instanceof Error ? err.message : 'Tool execution failed';
                            isError = true;
                        }
                    }
                }
                const durationMs = Date.now() - startMs;
                if (!sawHandoff) {
                    const message: ToolMessage = {
                        type: 'tool',
                        toolCallId: tc.id,
                        content: resultContent,
                        ...(resultGuidance.length > 0 ? { guidance: resultGuidance } : {}),
                        isError,
                        turnId,
                        timestamp: new Date(),
                    };
                    toolResultBuffer.set(tc.id, message);
                    if (!halt) {
                        observedOutcomes.set(tc.id, {
                            toolName: tc.name,
                            parsedInput,
                            message,
                        });
                    }
                }
                if (!sawHandoff) {
                    toolEndBuffer.set(tc.id, { toolCallId: tc.id, durationMs });
                }
            };
            const concurrency = (tc: (typeof unfulfilledToolCalls)[number]) => toolMap.get(tc.name)?.concurrency ?? (tc.name === 'subagent' ? 'deferred' : 'parallel');
            const immediateCalls = unfulfilledToolCalls.filter((tc) => concurrency(tc) !== 'deferred');
            const deferredCalls = unfulfilledToolCalls.filter((tc) => concurrency(tc) === 'deferred');
            const serialCalls = immediateCalls.filter((tc) => concurrency(tc) === 'serial');
            const parallelCalls = immediateCalls.filter((tc) => concurrency(tc) === 'parallel');
            const serialChain = serialCalls.reduce<Promise<void>>((chain, tc) => chain.then(() => runToolCall(tc)), Promise.resolve());
            await Promise.allSettled([serialChain, ...parallelCalls.map(runToolCall)]);
            if (!handoffDetected && deferredCalls.length > 0) {
                await Promise.allSettled(deferredCalls.map(runToolCall));
            }
            if (!handoffDetected && !state.exit) {
                try {
                    for (const tc of unfulfilledToolCalls) {
                        const outcome = observedOutcomes.get(tc.id);
                        if (!outcome)
                            continue;
                        for (const plugin of plugins) {
                            await plugin.afterToolCall?.({
                                toolCallId: tc.id, toolName: outcome.toolName,
                                args: outcome.parsedInput, message: outcome.message,
                            });
                        }
                    }
                }
                catch (err) {
                    pluginError(err);
                }
            }
            if (handoffDetected) {
                toolResultBuffer.clear();
                toolEndBuffer.clear();
                observedOutcomes.clear();
                state.pending = [];
                pendingToolEnds.length = 0;
                logger.info({ sessionId, turnId, loopIteration: state.loopIteration }, 'runtime · subagent handoff · abandoning batch · exit clean');
                state.exit = { kind: 'done' };
                break;
            }
            if (state.exit)
                break;
            for (const tc of unfulfilledToolCalls) {
                const message = toolResultBuffer.get(tc.id);
                if (message)
                    state.pending.push(message);
                const end = toolEndBuffer.get(tc.id);
                if (end)
                    pendingToolEnds.push(end);
            }
            await runHooks('afterExecTools');
            const skipPersisted = await persistPendingBeforeSkip();
            emitPersistedToolEnds(skipPersisted.filter((m): m is ToolMessage => m.type === 'tool'));
            if (state.exit)
                break;
            try {
                for (const plugin of plugins)
                    await plugin.afterToolBatch?.(state);
            }
            catch (err) {
                pluginError(err);
                break;
            }
            if (state.exit)
                break;
            let hasNew = false;
            try {
                hasNew = await cfg.store.hasNew();
            }
            catch (err) {
                state.exit = {
                    kind: 'error',
                    error: err instanceof Error ? err : new Error(String(err)),
                };
                break;
            }
            if (hasNew) {
                const persistedResults = await interleavePersist();
                emitPersistedToolEnds(persistedResults);
            }
            else {
                const persisted = await persistPending();
                emitPersistedToolEnds(persisted.filter((m): m is ToolMessage => m.type === 'tool'));
            }
            if (state.exit)
                break;
            await runHooks('afterPersist');
            if (state.exit)
                break;
            if (cfg.isDraining?.()) {
                logger.info({ sessionId, turnId, loopIteration: state.loopIteration }, 'runtime · draining at step boundary · exit clean');
                state.exit = { kind: 'done' };
                break;
            }
        }
        if (!state.exit)
            state.exit = { kind: 'done' };
        if (userSignal)
            userSignal.removeEventListener('abort', onUserAbort);
        if (state.exit.kind === 'error') {
            const err = state.exit.error;
            const isTimeout = err.name === 'TimeoutError';
            emit(buildTurnError({
                sessionId,
                turnId,
                code: isTimeout ? 'timeout' : 'error',
                message: isTimeout
                    ? `LLM request timed out (model: ${client.getModelName()})`
                    : err.message,
                detail: err.message,
            }));
        }
        const turnDurationMs = Date.now() - turnStartMs;
        if (cfg.usage) {
            const entry: UsageEntry = {
                keyId: opts.keyId ?? '',
                sessionId,
                turnId,
                numLLMCalls: state.numLLMCalls,
                inputTokens: totalInputTokens,
                lastInputTokens,
                outputTokens: totalOutputTokens,
                cachedTokens: totalCachedTokens,
                cacheCreationTokens: totalCacheCreationTokens,
                reasoningTokens: totalReasoningTokens,
                usdCost: totalUsdCost,
                durationMs: turnDurationMs,
                exitKind: state.exit.kind,
                errorMessage: state.exit.kind === 'error' ? state.exit.error.message : undefined,
            };
            try {
                await cfg.usage.record(entry);
            }
            catch (err) {
                logger.error({ sessionId, turnId, err }, 'UsageRecorder.record threw; ignoring');
            }
        }
        await runHooks('afterTurn');
        emit(buildTurnEnd({
            sessionId,
            turnId,
            inputTokens: lastInputTokens || undefined,
            model: state.numLLMCalls > 0 ? client.getModelName() : undefined,
        }));
        const exitKind = state.exit.kind;
        const exitErr = state.exit.kind === 'error' ? state.exit.error : undefined;
        if (exitErr) {
            logger.error({
                sessionId,
                turnId,
                exitKind,
                turnDurationMs,
                numLLMCalls: state.numLLMCalls,
                loopIteration: state.loopIteration,
                ...(exitErr instanceof MalformedToolArgumentsError
                    ? {
                        errorType: exitErr.name,
                        upstreamRequestId: exitErr.upstreamRequestId,
                        toolName: exitErr.toolName,
                    }
                    : { err: exitErr }),
            }, 'turn exited with error');
        }
        else {
            logger.info({
                sessionId,
                turnId,
                exitKind,
                turnDurationMs,
                numLLMCalls: state.numLLMCalls,
                loopIteration: state.loopIteration,
            }, 'turn exited');
        }
    }
}
export type { ExitKind, ExitState };
