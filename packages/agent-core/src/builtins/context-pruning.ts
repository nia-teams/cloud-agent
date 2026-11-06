import type { AgentMessage, Logger } from '../types.js';
import { NOOP_LOGGER } from '../types.js';
const CACHE_TTL_MS = 5 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 10 * 60 * 1000;
const CHARS_PER_TOKEN = 2.5;
const NON_LATIN_RE = /[\u2E80-\u9FFF\uA000-\uA4FF\uAC00-\uD7AF\uF900-\uFAFF\u{20000}-\u{2FA1F}]/gu;
function estimateWeightedChars(text: string): number {
    if (text.length === 0)
        return 0;
    const nonLatinCount = (text.match(NON_LATIN_RE) ?? []).length;
    if (nonLatinCount === 0)
        return text.length;
    return text.length + nonLatinCount * (CHARS_PER_TOKEN - 1);
}
const KEEP_LAST_ASSISTANTS = 3;
const DEFAULT_SOFT_TRIM_RATIO = 0.5;
const DEFAULT_HARD_CLEAR_RATIO = 0.7;
const SOFT_TRIM_MAX_CHARS = 4000;
const SOFT_TRIM_HEAD = 1500;
const SOFT_TRIM_TAIL = 1500;
const HARD_CLEAR_PLACEHOLDER = '[Old tool result content cleared]';
const MIN_PRUNABLE_CHARS = 50000;
type PruneLevel = 'soft' | 'hard';
const LEVEL_RANK: Record<PruneLevel, number> = { soft: 1, hard: 2 };
function levelRank(level: PruneLevel | undefined): number {
    return level ? LEVEL_RANK[level] : 0;
}
const EMPTY_LEVELS: ReadonlyMap<string, PruneLevel> = new Map();
function estimateMessageChars(msg: AgentMessage): number {
    if (msg.type === 'event')
        return estimateWeightedChars(msg.content);
    if (msg.type === 'tool')
        return estimateWeightedChars(msg.content);
    if (msg.type === 'assistant') {
        let chars = msg.content ? estimateWeightedChars(msg.content) : 0;
        if (msg.reasoning)
            chars += estimateWeightedChars(msg.reasoning);
        if (msg.toolCalls) {
            for (const tc of msg.toolCalls) {
                chars += estimateWeightedChars(tc.arguments) + tc.name.length;
            }
        }
        return chars;
    }
    return 0;
}
function estimateTotalChars(messages: readonly AgentMessage[]): number {
    let total = 0;
    for (const m of messages)
        total += estimateMessageChars(m);
    return total;
}
function findPruneCutoff(messages: readonly AgentMessage[], keepLast: number): number | null {
    if (keepLast <= 0)
        return messages.length;
    let remaining = keepLast;
    for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].type === 'assistant') {
            remaining--;
            if (remaining === 0)
                return i;
        }
    }
    return null;
}
function isToolResult(msg: AgentMessage): boolean {
    return msg.type === 'tool' || (msg.type === 'event' && msg.eventType === 'tool.result');
}
const TOOL_RESULT_HEADER_RE = /^\[Tool Result\] toolCallId=(\S+) isError=(?:true|false)/;
function stableId(msg: AgentMessage): string | undefined {
    if (msg.type === 'tool')
        return `tool:${msg.toolCallId}`;
    if (msg.type === 'event' && msg.eventType === 'tool.result') {
        const meta = msg.meta;
        const fromMeta = (typeof meta?.toolCallId === 'string' && meta.toolCallId) ||
            (typeof meta?.messageId === 'string' && meta.messageId) ||
            undefined;
        if (fromMeta)
            return `event:${fromMeta}`;
        const match = TOOL_RESULT_HEADER_RE.exec(msg.content);
        return match ? `event:${match[1]}` : undefined;
    }
    return undefined;
}
function softTrimContent(content: string): string {
    if (content.length <= SOFT_TRIM_MAX_CHARS)
        return content;
    const head = content.slice(0, SOFT_TRIM_HEAD);
    const tail = content.slice(-SOFT_TRIM_TAIL);
    return `${head}\n...\n${tail}\n\n[Tool result trimmed: kept first ${SOFT_TRIM_HEAD} and last ${SOFT_TRIM_TAIL} chars of ${content.length} total.]`;
}
function hardClearContent(content: string): string {
    const match = TOOL_RESULT_HEADER_RE.exec(content);
    if (!match)
        return HARD_CLEAR_PLACEHOLDER;
    const headerEndsAt = content.indexOf('\n');
    const header = headerEndsAt === -1 ? content : content.slice(0, headerEndsAt);
    return `${header}\n${HARD_CLEAR_PLACEHOLDER}`;
}
function applyLevel(msg: AgentMessage, level: PruneLevel): AgentMessage {
    if (level === 'hard') {
        const cleared = hardClearContent(msg.content ?? '');
        if (msg.content === cleared)
            return msg;
        return { ...msg, content: cleared } as AgentMessage;
    }
    const content = msg.content ?? '';
    const trimmed = softTrimContent(content);
    if (trimmed === content)
        return msg;
    return { ...msg, content: trimmed } as AgentMessage;
}
const MODEL_CONTEXT_WINDOW: Record<string, number> = {
    'deepseek-v4-pro': 1048576,
    'deepseek-flash': 1048576,
    'deepseek-v4': 1048576,
    'kimi-k3': 1048576,
    'qwen3.8': 1000000,
    'glm-5': 200000,
    'claude-sonnet-5-5': 1000000,
    'claude-opus-5-5': 1000000,
    'claude-haiku-5-5': 1000000,
    'gpt-5.4': 1050000,
    'gemini-3.8-flash': 1000000,
    'gemini-4-argon': 1000000,
    'claude-opus-4-7': 200000,
    'claude-opus-4-6': 200000,
    'claude-opus-4-5': 200000,
    'claude-sonnet-4-5': 200000,
    'claude-sonnet-4': 200000,
    'gpt-5.2': 400000,
    'gpt-4o': 128000,
    'gemini-2.5-pro': 1000000,
};
const DEFAULT_CONTEXT_WINDOW = 200000;
export function lookupContextWindow(modelName: string): number {
    if (!modelName)
        return DEFAULT_CONTEXT_WINDOW;
    if (MODEL_CONTEXT_WINDOW[modelName])
        return MODEL_CONTEXT_WINDOW[modelName];
    for (const key of Object.keys(MODEL_CONTEXT_WINDOW)) {
        if (modelName.startsWith(key))
            return MODEL_CONTEXT_WINDOW[key];
    }
    return DEFAULT_CONTEXT_WINDOW;
}
export interface ContextPrunerOptions {
    logger?: Logger;
    softTrimRatio?: number;
    hardClearRatio?: number;
}
export class ContextPruner {
    private readonly logger: Logger;
    private readonly softTrimRatio: number;
    private readonly hardClearRatio: number;
    private lastEvalTimestamps = new Map<string, number>();
    private toolResultLevels = new Map<string, Map<string, PruneLevel>>();
    private lastTouchedAt = new Map<string, number>();
    private lastCleanupAt = Date.now();
    constructor(opts: ContextPrunerOptions = {}) {
        this.logger = opts.logger ?? NOOP_LOGGER;
        this.softTrimRatio = opts.softTrimRatio ?? DEFAULT_SOFT_TRIM_RATIO;
        this.hardClearRatio = opts.hardClearRatio ?? DEFAULT_HARD_CLEAR_RATIO;
    }
    private maybeCleanup(): void {
        const now = Date.now();
        if (now - this.lastCleanupAt < CLEANUP_INTERVAL_MS)
            return;
        this.lastCleanupAt = now;
        const expiry = now - CACHE_TTL_MS * 2;
        for (const [sid, ts] of this.lastTouchedAt) {
            if (ts < expiry) {
                this.lastTouchedAt.delete(sid);
                this.lastEvalTimestamps.delete(sid);
                this.toolResultLevels.delete(sid);
            }
        }
    }
    private getOrCreateLevels(sessionId: string): Map<string, PruneLevel> {
        let levels = this.toolResultLevels.get(sessionId);
        if (!levels) {
            levels = new Map();
            this.toolResultLevels.set(sessionId, levels);
        }
        return levels;
    }
    private applyDecisions(messages: readonly AgentMessage[], levels: ReadonlyMap<string, PruneLevel>): readonly AgentMessage[] {
        if (levels.size === 0)
            return messages;
        let result: AgentMessage[] | null = null;
        for (let i = 0; i < messages.length; i++) {
            const msg = messages[i];
            if (!isToolResult(msg))
                continue;
            const id = stableId(msg);
            if (!id)
                continue;
            const level = levels.get(id);
            if (!level)
                continue;
            const applied = applyLevel(msg, level);
            if (applied !== msg) {
                if (!result)
                    result = messages.slice();
                result[i] = applied;
            }
        }
        return result ?? messages;
    }
    prune(messages: readonly AgentMessage[], contextWindowTokens: number, sessionId: string, overheadChars = 0): readonly AgentMessage[] {
        this.maybeCleanup();
        this.lastTouchedAt.set(sessionId, Date.now());
        const levelsReadOnly = this.toolResultLevels.get(sessionId) ?? EMPTY_LEVELS;
        const applied = this.applyDecisions(messages, levelsReadOnly);
        const lastPrunedAt = this.lastEvalTimestamps.get(sessionId);
        if (lastPrunedAt && Date.now() - lastPrunedAt < CACHE_TTL_MS) {
            this.lastEvalTimestamps.set(sessionId, Date.now());
            return applied;
        }
        const charWindow = contextWindowTokens * CHARS_PER_TOKEN;
        if (charWindow <= 0)
            return applied;
        let totalChars = estimateTotalChars(applied) + overheadChars;
        let ratio = totalChars / charWindow;
        if (ratio < this.softTrimRatio)
            return applied;
        const cutoff = findPruneCutoff(applied, KEEP_LAST_ASSISTANTS);
        if (cutoff === null)
            return applied;
        const prunableIndices: number[] = [];
        for (let i = 0; i < cutoff; i++) {
            const msg = applied[i];
            if (!isToolResult(msg))
                continue;
            const id = stableId(msg);
            if (id && levelsReadOnly.get(id) === 'hard')
                continue;
            prunableIndices.push(i);
        }
        if (prunableIndices.length === 0)
            return applied;
        let prunableChars = 0;
        for (const i of prunableIndices)
            prunableChars += estimateMessageChars(applied[i]);
        if (prunableChars < MIN_PRUNABLE_CHARS)
            return applied;
        const levels = this.getOrCreateLevels(sessionId);
        const result: AgentMessage[] = applied.slice();
        for (const i of prunableIndices) {
            const msg = result[i];
            const content = msg.content ?? '';
            const trimmed = softTrimContent(content);
            if (trimmed !== content) {
                result[i] = { ...msg, content: trimmed } as AgentMessage;
                totalChars += estimateWeightedChars(trimmed) - estimateWeightedChars(content);
                const id = stableId(msg);
                if (id && levelRank(levels.get(id)) < levelRank('soft'))
                    levels.set(id, 'soft');
            }
        }
        ratio = totalChars / charWindow;
        if (ratio < this.hardClearRatio) {
            const savedChars = estimateTotalChars(messages) + overheadChars - totalChars;
            this.logger.info({ sessionId, savedChars, phase: 'soft-trim' }, 'Context pruned');
            this.lastEvalTimestamps.set(sessionId, Date.now());
            return result;
        }
        for (const i of prunableIndices) {
            if (ratio < this.hardClearRatio)
                break;
            const msg = result[i];
            const oldContent = msg.content ?? '';
            const oldChars = estimateWeightedChars(oldContent);
            const id = stableId(msg);
            const cleared = hardClearContent(oldContent);
            result[i] = { ...msg, content: cleared } as AgentMessage;
            totalChars += estimateWeightedChars(cleared) - oldChars;
            ratio = totalChars / charWindow;
            if (id)
                levels.set(id, 'hard');
        }
        const savedChars = estimateTotalChars(messages) + overheadChars - totalChars;
        this.logger.info({ sessionId, savedChars, phase: 'hard-clear' }, 'Context pruned');
        this.lastEvalTimestamps.set(sessionId, Date.now());
        return result;
    }
}
export function createContextPruningPlugin(options: ContextPrunerOptions = {}): import('../types.js').RuntimePlugin {
    return {
        name: 'context-pruning',
        create: ({ logger, sessionId }) => {
            const pruner = new ContextPruner({ ...options, logger: options.logger ?? logger });
            return {
                transformContext: ({ messages, state, model, contextWindow }) => {
                    const overhead = state.systemPrompt.length + state.tools.reduce((sum, tool) => {
                        try {
                            return sum + (tool.description?.length ?? 0) + JSON.stringify(tool.inputSchema).length;
                        }
                        catch {
                            return sum;
                        }
                    }, 0);
                    return pruner.prune(messages, contextWindow ?? lookupContextWindow(model), sessionId, overhead);
                },
            };
        },
    };
}
