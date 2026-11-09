import type { AgentEvent } from '../../types.js';
import type { Tool, ToolContext, SubagentProfile, SubagentStore, ConversationStore, AgentMessage, AssistantMessage, SubagentResultForFormat, RunOptions, SubagentRunDoc, } from '../../types.js';
import { AgentRuntime, DEFAULT_MAX_LOOP_ITERATIONS } from '../../runtime.js';

export function buildSubagentMaxTurnsWrapUpPrompt(maxTurns: number): string {
  return `<system-reminder>
The maximum step limit (${maxTurns}) has been reached. Tool calls are disabled for this final response. Do NOT call tools; respond with text only.
Explicitly state that the step limit was reached before full completion. Summarize concrete findings, verified facts (including file:line references, commands, or commit details where available), and any edits already made. List remaining unfinished items and recommend next steps. Do not claim unverified work is complete.
</system-reminder>`;
}

export const SUBAGENT_CANCELLED_RESULT = '(subagent cancelled by user)';
export class SubagentHandoffSignal extends Error {
    constructor(public readonly toolCallId: string) {
        super(`subagent handoff: toolCallId=${toolCallId}`);
        this.name = 'SubagentHandoffSignal';
    }
}
export function isSubagentHandoffSignal(err: unknown): err is SubagentHandoffSignal {
    return (err instanceof SubagentHandoffSignal ||
        (typeof err === 'object' &&
            err !== null &&
            (err as {
                name?: string;
            }).name === 'SubagentHandoffSignal'));
}
const activeSubagents = new Map<string, AbortController>();
export function cancelSubagentInProcess(sessionId: string, toolCallId: string): boolean {
    const ctrl = activeSubagents.get(cancelKey(sessionId, toolCallId));
    if (!ctrl)
        return false;
    ctrl.abort();
    return true;
}
export function cancelSubagentInProcessByToolCallId(toolCallId: string): boolean {
    const suffix = `:${toolCallId}`;
    for (const [key, ctrl] of activeSubagents) {
        if (key.endsWith(suffix)) {
            ctrl.abort();
            return true;
        }
    }
    return false;
}
function cancelKey(sessionId: string, toolCallId: string): string {
    return `${sessionId}:${toolCallId}`;
}
const FORWARDED_EVENT_TYPES = new Set<string>([
    'tool_input_start',
    'tool_call_start',
    'text_delta',
    'thinking_start',
]);
const DESCRIPTION_FIXED = `Launch a sub-agent in a fresh conversation. **Context isolation is the point**: exploration / build noise stays in the sub-agent; only the reduced answer comes back to you. Multiple sub-agents run concurrently when issued in the same response.

## Activation requirement

Use this tool only when the user or an active Skill explicitly requests delegation to a sub-agent. Delegate only work covered by that explicit request. This requirement applies to both new launches and resumes. Otherwise, complete the task in the parent conversation. Task size, search complexity, and potential parallelism do not by themselves authorize delegation.

## Suitable tasks after explicit delegation

- Big haystack, small needle: finding one fact across many files.
- Independent fact-finding that can parallelize (dispatch multiple sub-agents in one message).
- High-noise exploration with a small structured answer (e.g. "which file handles route X — return path + line number").
- Tasks that will clearly require more than 3 search queries. Fewer than that, use direct search / read tools — sub-agent has startup overhead.
- Multi-step coding / editing tasks where a dedicated worktree keeps the parent conversation clean.

## When NOT to use

- If you know a specific file path, use read tools directly — faster than spinning up a sub-agent.
- If you're searching for one class / function definition, use search directly.
- **One-off writes that aren't a batched change** — writing a single file, running one shell command. Do those yourself.
- **Creative thinking / judgment / synthesis** (analyze bottleneck, design architecture, compare approaches). Delegate facts / execution, keep analysis and decisions yourself — the sub-agent has no conversation context to judge with.
- **Content relay** — do NOT ask it to "read these files and return the contents". Use read tools directly. The sub-agent's job is to **find** (file, line, function), not to copy.

## Key rules

- Sub-agent CANNOT see your conversation. Put everything into \`task\`; use \`context\` for code snippets or file contents.
- Results are only visible to you — relay findings, don't parrot back.
- When the sub-agent is done, it returns a single message back to you. To show the user, send a concise summary — the raw result is not visible to them.
- The sub-agent's outputs should generally be trusted.

## Writing the prompt

When spawning a sub-agent, it starts with zero context. Brief it like a smart colleague who just walked into the room — it hasn't seen this conversation, doesn't know what you've tried, doesn't understand why this task matters.

- Explain what you're trying to accomplish and why.
- Describe what you've already learned or ruled out.
- Give enough context about the surrounding problem that the sub-agent can make judgment calls rather than just following a narrow instruction.
- **Specify the return format** (table, list of paths+lines, structured facts). Never open-ended.
- If you need a short response, say so ("report in under 200 words").
- Lookups: hand over the exact command. Investigations: hand over the question — prescribed steps become dead weight when the premise is wrong.

Terse command-style prompts produce shallow, generic work.

**Never delegate understanding.** Don't write "based on your findings, fix the bug" or "based on the research, implement it." Those phrases push synthesis onto the sub-agent instead of doing it yourself. Write prompts that prove you understood: include file paths, line numbers, what specifically to change.

## Parallelism

After the user or an active Skill explicitly requests delegation, launch multiple sub-agents concurrently when the delegated questions are independent — use a single message with multiple sub-agent tool calls. This maximizes throughput since they share no state.`;
function buildDescription(profiles: SubagentProfile[]): string {
    const modes = profiles
        .map((p) => `- \`mode="${p.name}"\` — ${p.description}`)
        .join('\n');
    return `${DESCRIPTION_FIXED}\n\n## Modes\n\n${modes}`;
}
const DEFAULT_TASK_DESCRIPTION = 'The task description for the sub-agent. Start with a short summary, then provide full context and explicit instructions on what to return.';
const DEFAULT_CONTEXT_DESCRIPTION = 'Optional context (code snippets, file contents, etc.)';
function buildInputSchema(profiles: SubagentProfile[], descriptions?: {
    task?: string;
    context?: string;
}): Record<string, unknown> {
    const modeNames = profiles.map((p) => p.name);
    return {
        type: 'object',
        properties: {
            task: {
                type: 'string',
                description: descriptions?.task ?? DEFAULT_TASK_DESCRIPTION,
            },
            context: {
                type: 'string',
                description: descriptions?.context ?? DEFAULT_CONTEXT_DESCRIPTION,
            },
            resume: {
                type: 'string',
                description: "Previous sub-agent tool_call_id. Use to restart interrupted or failed work, or when the new task requires its context.",
            },
            mode: {
                type: 'string',
                enum: modeNames,
                description: `Sub-agent mode. Determines role / tools / model. Default: "${modeNames[0]}".`,
            },
        },
        required: ['task'],
    };
}
export interface CreateSubagentToolOptions {
    profiles: SubagentProfile[];
    store: SubagentStore;
    parentPlugins?: readonly import('../../types.js').RuntimePlugin[];
    parentFormatMessagesForLLM?: ((messages: AgentMessage[]) => Promise<AgentMessage[]>) | Array<(messages: AgentMessage[]) => Promise<AgentMessage[]>>;
    parentMaxLoopIterations?: number;
    parentLlmCallTimeoutMs?: number;
    parentLlmIdleTimeoutMs?: number;
    parentIsDraining?: () => boolean;
    logger?: import('../../types.js').Logger;
    publishChildEvent?: (toolCallId: string, event: Record<string, unknown>) => void;
    checkpointChildEvents?: (toolCallId: string, turnId: string) => Promise<number | undefined>;
    recoveryAnchor?: {
        replayedToolCallIds: Set<string>;
        runIds: Array<string | {
            toHexString(): string;
        }>;
    };
    inputOverride?: {
        resolveInput: (raw: {
            task: string;
            context?: string;
        }, ctx: ToolContext) => Promise<{
            task: string;
            context?: string;
        }>;
        taskDescription?: string;
        contextDescription?: string;
    };
    resultOverride?: NonNullable<RunOptions['subagent']>['resultOverride'];
}
function defaultFormatSubagentResult(result: SubagentResultForFormat): string {
    const output = result.content || '(subagent completed with no text output)';
    if (result.maxTurnsReached !== undefined) {
        return `[Subagent reached max turns (${result.maxTurnsReached}) · partial result]\n\n${output}\n\n[tool_call_id: ${result.toolCallId}]`;
    }
    return `${output}\n\n[tool_call_id: ${result.toolCallId}]`;
}
export function createSubagentTool(opts: CreateSubagentToolOptions): Tool {
    const { profiles, store } = opts;
    const publishChildEvent = opts.publishChildEvent;
    const checkpointChildEvents = opts.checkpointChildEvents;
    const inputOverride = opts.inputOverride;
    const resultOverride = opts.resultOverride;
    if (profiles.length === 0) {
        throw new Error('createSubagentTool: at least one profile is required');
    }
    const seen = new Set<string>();
    for (const p of profiles) {
        if (seen.has(p.name)) {
            throw new Error(`createSubagentTool: duplicate profile name "${p.name}"`);
        }
        seen.add(p.name);
    }
    const profileMap = new Map(profiles.map((p) => [p.name, p]));
    const defaultProfileName = profiles[0].name;
    const description = buildDescription(profiles);
    const inputSchema = buildInputSchema(profiles, {
        task: inputOverride?.taskDescription,
        context: inputOverride?.contextDescription,
    });
    const log = opts.logger;
    return {
        name: 'subagent',
        concurrency: 'deferred',
        description,
        inputSchema,
        async execute(input: Record<string, unknown>, ctx: ToolContext): Promise<string> {
            const task = typeof input.task === 'string' ? input.task : '';
            if (!task)
                return 'Error: "task" is required';
            const context = typeof input.context === 'string' ? input.context : undefined;
            const resumeId = typeof input.resume === 'string' && input.resume ? input.resume : undefined;
            const userSpecifiedMode = typeof input.mode === 'string' && input.mode;
            let modeName = userSpecifiedMode ? (input.mode as string) : defaultProfileName;
            const parentToolCallId = ctx.toolCallId || '';
            if (!parentToolCallId) {
                return 'Error: subagent tool requires ctx.toolCallId (runtime guarantees this — should not happen)';
            }
            let seedMessages: AgentMessage[] = [];
            let resumedFromExplicit: string | undefined;
            let isRecovery = false;
            let existingRunId: string | undefined;
            let variantSourceDoc: SubagentRunDoc | undefined;
            let variantResumeSource: 'fresh' | 'recovery' | 'explicit-resume' = 'fresh';
            const existingDoc = await store.findByToolCallId(ctx.sessionId, parentToolCallId);
            if (existingDoc) {
                isRecovery = true;
                existingRunId = existingDoc.subagentId;
                variantSourceDoc = existingDoc;
                variantResumeSource = 'recovery';
                seedMessages = existingDoc.messages;
                if (!userSpecifiedMode && existingDoc.profileName) {
                    modeName = existingDoc.profileName;
                }
            }
            else if (opts.recoveryAnchor?.replayedToolCallIds.has(parentToolCallId)) {
                log?.warn?.({
                    sessionId: ctx.sessionId,
                    toolCallId: parentToolCallId,
                    staleRunIds: opts.recoveryAnchor.runIds,
                }, 'subagent recovery · doc missing for anchored toolCallId · draining anchor with error');
                for (const staleId of opts.recoveryAnchor.runIds) {
                    try {
                        await store.finalize({
                            subagentId: typeof staleId === 'string' ? staleId : staleId.toHexString(),
                            sessionId: ctx.sessionId,
                            status: 'error',
                            lastError: {
                                code: 'subagent_recovery_doc_missing',
                                message: `subagent_runs doc missing during recovery of toolCallId=${parentToolCallId}`,
                            },
                        });
                    }
                    catch (err) {
                        log?.warn?.({ err, staleId, sessionId: ctx.sessionId }, 'subagent recovery · finalize on stale runId threw · continuing');
                    }
                }
                throw new Error(`subagent recovery failed — the internal run record for tool_call_id="${parentToolCallId}" was lost (mongo doc missing while activeSubagentTurn anchor still referenced it). This run cannot resume. Decide whether to relaunch a fresh subagent for the same task or give up.`);
            }
            else if (resumeId) {
                const prevDoc = await store.findByToolCallId(ctx.sessionId, resumeId);
                if (!prevDoc) {
                    return `Error: cannot resume — no subagent run found with tool_call_id "${resumeId}" in this session.`;
                }
                if (prevDoc.status === 'running') {
                    return `Error: cannot resume — subagent "${resumeId}" is still running.`;
                }
                seedMessages = prevDoc.messages;
                resumedFromExplicit = resumeId;
                variantSourceDoc = prevDoc;
                variantResumeSource = 'explicit-resume';
                if (!userSpecifiedMode && prevDoc.profileName) {
                    modeName = prevDoc.profileName;
                }
            }
            const profile = profileMap.get(modeName);
            if (!profile) {
                return `Error: unknown mode "${modeName}". Available: ${Array.from(profileMap.keys()).join(', ')}`;
            }
            let resolvedTask = task;
            let resolvedContext = context;
            if (!isRecovery && inputOverride) {
                const resolved = await inputOverride.resolveInput({ task, context }, ctx);
                resolvedTask = resolved.task;
                resolvedContext = resolved.context;
            }
            if (isRecovery && variantSourceDoc) {
                resolvedTask = variantSourceDoc.task;
                resolvedContext = undefined;
            }
            const resolvedProfile = profile.resolveVariant
                ? await profile.resolveVariant({
                    sessionId: ctx.sessionId,
                    toolCallId: parentToolCallId,
                    task: resolvedTask,
                    ...(resolvedContext ? { context: resolvedContext } : {}),
                    resumeSource: variantResumeSource,
                    ...(variantSourceDoc ? { existingRunDoc: variantSourceDoc } : {}),
                })
                : profile;
            const effectiveProfile = resolvedProfile.createUsageRecorder
                ? resolvedProfile
                : { ...resolvedProfile, createUsageRecorder: profile.createUsageRecorder };
            if (effectiveProfile.name !== profile.name) {
                throw new Error(`subagent resolveVariant must preserve profile name: expected "${profile.name}", got "${effectiveProfile.name}"`);
            }
            const taskContent = resolvedContext ? `${resolvedTask}\n\n---\n\n${resolvedContext}` : resolvedTask;
            const seededPlusTask: AgentMessage[] = [
                ...seedMessages,
                {
                    type: 'event',
                    eventType: 'message.received',
                    content: taskContent,
                    timestamp: new Date(),
                },
            ];
            let subagentId: string;
            if (isRecovery && existingRunId) {
                subagentId = existingRunId;
            }
            else {
                if (!ctx.parentAssistantSnapshot) {
                    return 'Error: subagent tool requires ctx.parentAssistantSnapshot (runtime contract violation)';
                }
                const insertResult = await store.insertRun({
                    sessionId: ctx.sessionId,
                    parentTurnId: ctx.turnId,
                    parentAssistantSnapshot: ctx.parentAssistantSnapshot,
                    toolCallId: parentToolCallId,
                    profileName: effectiveProfile.name,
                    profileVariant: effectiveProfile.profileVariant,
                    task: resolvedTask,
                    resumedFrom: resumedFromExplicit,
                    initialMessages: seededPlusTask,
                });
                subagentId = insertResult.subagentId;
            }
            const cancelController = new AbortController();
            const key = cancelKey(ctx.sessionId, parentToolCallId);
            activeSubagents.set(key, cancelController);
            const onParentAbort = () => cancelController.abort();
            if (ctx.signal.aborted) {
                cancelController.abort();
            }
            else {
                ctx.signal.addEventListener('abort', onParentAbort, { once: true });
            }
            let lastBlockUpdate: Promise<unknown> = Promise.resolve();
            let finalResult = '';
            let finalStatus: 'complete' | 'error' | 'cancelled' = 'complete';
            let runtimeError: unknown;
            let didHandoff = false;
            let childExitKind: 'done' | 'skip' | 'aborted' | 'error' | undefined;
            let childExitError: Error | undefined;
            let childMaxTurnsReached: number | undefined;
            try {
                const cached: AgentMessage[] = isRecovery
                    ? [...seedMessages]
                    : [...seededPlusTask];
                const childStore: ConversationStore = {
                    loadAll: async () => [...cached],
                    fetchNew: async () => [],
                    hasNew: async () => false,
                    persist: async (msgs) => {
                        for (const m of msgs)
                            cached.push(m);
                        for (const m of msgs) {
                            if (m.type === 'assistant') {
                                const a = m as AssistantMessage;
                                if (a.content)
                                    finalResult = a.content;
                            }
                        }
                        let replayThroughSeq: number | undefined;
                        if (checkpointChildEvents) {
                            const persistedTurnIds = new Set(msgs
                                .map((m) => ('turnId' in m ? m.turnId : undefined))
                                .filter((id): id is string => typeof id === 'string' && id.length > 0));
                            for (const persistedTurnId of persistedTurnIds) {
                                const seq = await checkpointChildEvents(parentToolCallId, persistedTurnId);
                                if (seq !== undefined) {
                                    replayThroughSeq = Math.max(replayThroughSeq ?? 0, seq);
                                }
                            }
                        }
                        await store.appendMessages(subagentId, msgs, replayThroughSeq);
                    },
                };
                const forwardEvent = (event: AgentEvent) => {
                    publishChildEvent?.(parentToolCallId, { ...event });
                    const typ = event.type;
                    if (event.type === 'tool_call_start') {
                        const blockUpdate = store
                            .updateLastBlock(subagentId, {
                            type: 'tool_call',
                            name: event.name || 'unknown',
                            description: undefined,
                        })
                            .catch((err) => {
                            log?.warn?.({ err, subagentId }, 'updateLastBlock failed');
                        });
                        lastBlockUpdate = blockUpdate;
                    }
                    if (!typ || !FORWARDED_EVENT_TYPES.has(typ))
                        return;
                    ctx.onEvent({
                        ...event,
                        subagentToolCallId: parentToolCallId,
                    });
                };
                const childUsage = effectiveProfile.createUsageRecorder?.({
                    sessionId: ctx.sessionId,
                    toolCallId: parentToolCallId,
                    subagentId,
                    parentTurnId: ctx.turnId,
                    profileName: effectiveProfile.name,
                });
                const effectiveMaxTurns = effectiveProfile.maxTurns ?? opts.parentMaxLoopIterations ?? DEFAULT_MAX_LOOP_ITERATIONS;
                const childRuntime = new AgentRuntime({
                    store: childStore,
                    ...(childUsage ? { usage: childUsage } : {}),
                    sessionId: ctx.sessionId,
                    plugins: opts.parentPlugins?.flatMap((plugin) => plugin.forSubagent ? plugin.forSubagent() ?? [] : plugin),
                    maxLoopIterations: effectiveMaxTurns,
                    maxIterationsWrapUpPrompt: buildSubagentMaxTurnsWrapUpPrompt(effectiveMaxTurns),
                    llmCallTimeoutMs: opts.parentLlmCallTimeoutMs,
                    llmIdleTimeoutMs: opts.parentLlmIdleTimeoutMs,
                    formatMessagesForLLM: opts.parentFormatMessagesForLLM,
                    isDraining: opts.parentIsDraining,
                    logger: log,
                });
                await childRuntime.run({
                    client: effectiveProfile.client,
                    systemPrompt: effectiveProfile.rolePrompt,
                    tools: effectiveProfile.tools,
                    keyId: `subagent:${subagentId}`,
                    resolveToolDefinitions: effectiveProfile.resolveToolDefinitions,
                    contextWindow: effectiveProfile.contextWindow,
                    onEvent: (event) => forwardEvent(event),
                    abortSignal: cancelController.signal,
                    hooks: {
                        beforeTurn: async (state) => {
                            for (const [k, v] of Object.entries(ctx.metadata)) {
                                state.metadata[k] = v;
                            }
                            state.metadata.parentTurnId = ctx.turnId;
                            state.metadata.subagentId = subagentId;
                            state.metadata.subagentProfileName = effectiveProfile.name;
                            state.metadata.deferredToolNames = effectiveProfile.deferredToolNames ?? [];
                            state.metadata.modelTier = effectiveProfile.modelTier;
                            state.metadata.nativeToolActivationQueue = [];
                        },
                        afterTurn: async (state) => {
                            childExitKind = state.exit?.kind;
                            childMaxTurnsReached = state.maxIterationsReached;
                            if (state.exit?.kind === 'error') {
                                childExitError = state.exit.error;
                            }
                        },
                    },
                });
                if (childExitKind === 'error') {
                    finalStatus = 'error';
                    runtimeError = childExitError ?? new Error('subagent runtime error');
                }
                else if (cancelController.signal.aborted &&
                    !ctx.signal.aborted) {
                    finalStatus = 'cancelled';
                    finalResult = SUBAGENT_CANCELLED_RESULT;
                }
                else if (opts.parentIsDraining?.()) {
                    didHandoff = true;
                }
                else if (ctx.signal.aborted) {
                    didHandoff = true;
                    log?.warn?.({
                        sessionId: ctx.sessionId,
                        toolCallId: parentToolCallId,
                        subagentId,
                        childExitKind,
                    }, 'subagent · parent ctx.signal aborted for a non-draining reason (stall-detection self-abort / lock lost mid-turn) · treating as handoff, NOT finalizing · activeSubagentTurn anchor stays intact for the next pod to resume');
                }
            }
            catch (err) {
                finalStatus = 'error';
                runtimeError = err;
                log?.warn?.({ err, subagentId }, 'Subagent child runtime threw (unexpected)');
            }
            finally {
                activeSubagents.delete(key);
                ctx.signal.removeEventListener('abort', onParentAbort);
                await lastBlockUpdate;
            }
            if (didHandoff) {
                throw new SubagentHandoffSignal(parentToolCallId);
            }
            const lastError = finalStatus === 'error' && runtimeError !== undefined
                ? {
                    code: 'subagent_runtime_error',
                    message: runtimeError instanceof Error
                        ? runtimeError.message
                        : String(runtimeError),
                    detail: runtimeError instanceof Error && runtimeError.stack
                        ? runtimeError.stack
                        : undefined,
                }
                : undefined;
            await store.finalize({
                subagentId,
                sessionId: ctx.sessionId,
                status: finalStatus,
                lastError,
            });
            const resultForFormat: SubagentResultForFormat = {
                ...(finalStatus === 'complete' && childMaxTurnsReached !== undefined
                    ? { maxTurnsReached: childMaxTurnsReached } : {}),
                status: finalStatus,
                content: finalResult,
                toolCallId: parentToolCallId,
                mode: modeName,
                lastError,
            };
            const formatted = resultOverride
                ? await resultOverride(resultForFormat, ctx)
                : defaultFormatSubagentResult(resultForFormat);
            if (finalStatus === 'error') {
                throw new Error(formatted);
            }
            return formatted;
        },
    };
}
export const __testInternals = {
    activeSubagents,
    cancelKey,
    buildDescription,
    buildInputSchema,
    DESCRIPTION_FIXED,
    defaultFormatSubagentResult,
};
