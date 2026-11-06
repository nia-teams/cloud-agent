import type { AgentMessage, AssistantMessage, ToolMessage, Logger } from '../types.js';
import { NOOP_LOGGER } from '../types.js';
export interface LargeToolResultStore {
    write(toolName: string, content: string): Promise<{
        uri: string;
    }>;
    read?(uri: string, range?: {
        offset?: number;
        limit?: number;
    }): Promise<string | null>;
}
export interface LargeToolResultOptions {
    store: LargeToolResultStore;
    thresholdChars?: number;
    previewChars?: number;
    headFraction?: number;
    skip?: boolean;
    envelopeMarkers?: string[];
    logger?: Logger;
    sessionId?: string;
    turnId?: string;
}
const DEFAULT_THRESHOLD = 40000;
const DEFAULT_HEAD_FRACTION = 0.67;
const DEFAULT_ENVELOPE_MARKERS: string[] = [];
export const MAX_PREVIEW_CHARS = 500000;
function safeSliceHead(s: string, n: number): string {
    if (n >= s.length)
        return s;
    if (n <= 0)
        return '';
    const code = s.charCodeAt(n - 1);
    if (code >= 0xd800 && code <= 0xdbff) {
        return s.slice(0, n - 1);
    }
    return s.slice(0, n);
}
function safeSliceTail(s: string, n: number): string {
    if (n >= s.length)
        return s;
    if (n <= 0)
        return '';
    const start = s.length - n;
    const code = s.charCodeAt(start);
    if (code >= 0xdc00 && code <= 0xdfff) {
        return s.slice(start + 1);
    }
    return s.slice(start);
}
function isEnvelope(content: string, markers: string[]): boolean {
    if (markers.length === 0)
        return false;
    if (!content || content[0] !== '{')
        return false;
    let parsed: unknown;
    try {
        parsed = JSON.parse(content);
    }
    catch {
        return false;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
        return false;
    const obj = parsed as Record<string, unknown>;
    return markers.some((k) => obj[k] === true);
}
function buildIdToName(pending: AgentMessage[]): Map<string, string> {
    const out = new Map<string, string>();
    for (const m of pending) {
        if (m.type !== 'assistant')
            continue;
        const a = m as AssistantMessage;
        if (!a.toolCalls)
            continue;
        for (const tc of a.toolCalls)
            out.set(tc.id, tc.name);
    }
    return out;
}
export async function applyLargeToolResult(pending: AgentMessage[], opts: LargeToolResultOptions): Promise<number> {
    if (opts.skip)
        return 0;
    const rawThreshold = opts.thresholdChars ?? DEFAULT_THRESHOLD;
    const thresholdChars = Number.isFinite(rawThreshold) && rawThreshold > 0
        ? Math.min(Math.floor(rawThreshold), MAX_PREVIEW_CHARS)
        : DEFAULT_THRESHOLD;
    const rawPreview = opts.previewChars ?? thresholdChars;
    const previewChars = Number.isFinite(rawPreview) && rawPreview > 0
        ? Math.min(Math.floor(rawPreview), MAX_PREVIEW_CHARS)
        : thresholdChars;
    const rawHeadFraction = opts.headFraction ?? DEFAULT_HEAD_FRACTION;
    const headFraction = Number.isFinite(rawHeadFraction)
        ? Math.min(Math.max(rawHeadFraction, 0), 1)
        : DEFAULT_HEAD_FRACTION;
    const envelopeMarkers = opts.envelopeMarkers ?? DEFAULT_ENVELOPE_MARKERS;
    const logger = opts.logger ?? NOOP_LOGGER;
    const sessionId = opts.sessionId;
    const turnId = opts.turnId;
    const idToName = buildIdToName(pending);
    let truncated = 0;
    for (const m of pending) {
        if (m.type !== 'tool')
            continue;
        const tool = m as ToolMessage;
        if (!tool.content || tool.content.length <= thresholdChars)
            continue;
        if (!tool.isError && tool.content.length <= MAX_PREVIEW_CHARS && isEnvelope(tool.content, envelopeMarkers))
            continue;
        const toolName = idToName.get(tool.toolCallId) ?? 'unknown';
        const original = tool.content;
        let uri: string | undefined;
        if (!tool.isError) {
            try {
                const written = await opts.store.write(toolName, original);
                uri = written.uri;
            }
            catch (err) {
                logger.warn({
                    sessionId,
                    turnId,
                    toolCallId: tool.toolCallId,
                    toolName,
                    originalSize: original.length,
                    err,
                }, 'largeToolResult.store.write threw · truncating to preview without external URI');
            }
        }
        const headSize = Math.floor(previewChars * headFraction);
        const tailSize = Math.max(previewChars - headSize, 0);
        const head = safeSliceHead(original, headSize);
        const tail = safeSliceTail(original, tailSize);
        const omitted = original.length - head.length - tail.length;
        tool.content = [
            uri
                ? `[Tool result over threshold · stored externally]`
                : `[Tool result over threshold · truncated in place]`,
            ``,
            `original size: ${original.length} chars (${Math.round(original.length / 1000)}KB)`,
            ...(uri ? [`resource uri: ${uri}`] : []),
            ``,
            `--- preview head (${head.length} chars) ---`,
            head,
            ``,
            `--- omitted ${omitted} chars ---`,
            ``,
            `--- preview tail (${tail.length} chars) ---`,
            tail,
        ].join('\n');
        truncated += 1;
        logger.info({
            sessionId,
            turnId,
            toolName,
            toolCallId: tool.toolCallId,
            originalSize: original.length,
            uri,
        }, uri
            ? '✂️ largeToolResult · tool result stored externally · LLM sees preview + URI'
            : '✂️ largeToolResult · tool result truncated in place · LLM sees preview');
    }
    return truncated;
}
export function createLargeToolResultPlugin(options: LargeToolResultOptions): import('../types.js').RuntimePlugin {
    return {
        name: 'large-tool-result',
        create: ({ logger, sessionId, turnId }) => ({
            afterToolBatch: async (state) => {
                try {
                    await applyLargeToolResult(state.pending, { ...options, sessionId, turnId, logger });
                }
                catch (err) {
                    logger.warn({ sessionId, turnId, err }, 'largeToolResult step threw at top level · leaving pending untouched');
                }
            },
        }),
    };
}
