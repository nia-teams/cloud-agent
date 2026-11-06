import type { AgentMessage, Logger } from '../types.js';
import { NOOP_LOGGER } from '../types.js';
export interface PendingHiddenOptions {
    isSkippable: (msg: AgentMessage) => boolean;
    isUserActionable: (msg: AgentMessage) => boolean;
    isSubagent?: boolean;
    logger?: Logger;
    sessionId?: string;
}
export function buildPendingHiddenTransformer(opts: PendingHiddenOptions): (messages: AgentMessage[]) => Promise<AgentMessage[]> {
    const { isSkippable, isUserActionable, isSubagent = false } = opts;
    const logger = opts.logger ?? NOOP_LOGGER;
    const sessionId = opts.sessionId;
    if (isSubagent) {
        return async (messages) => messages;
    }
    return async (messages) => {
        const hidden: AgentMessage[] = [];
        for (let i = messages.length - 1; i >= 0; i--) {
            const m = messages[i];
            if (isUserActionable(m))
                break;
            if (isSkippable(m))
                hidden.push(m);
        }
        if (hidden.length === 0)
            return messages;
        const hiddenSet = new Set(hidden);
        const filtered = messages.filter((m) => !hiddenSet.has(m));
        const lastMsg = filtered[filtered.length - 1];
        if (filtered.length === 0 || lastMsg?.type === 'assistant') {
            logger.warn({
                sessionId,
                hiddenCount: hidden.length,
                filteredLength: filtered.length,
                filteredLast: lastMsg?.type ?? 'empty',
            }, '⚠ mid-turn pendingHidden filter would leave assistant-trailing or empty msgs · falling back to no-filter (defense)');
            return messages;
        }
        logger.info({ sessionId, hiddenCount: hidden.length }, '🙈 mid-turn pendingHidden · hiding trailing @-human-only msgs from LLM');
        return filtered;
    };
}
export function createPendingHiddenPlugin(options: PendingHiddenOptions): import('../types.js').RuntimePlugin {
    return {
        name: 'pending-hidden',
        forSubagent: () => undefined,
        create: ({ logger, sessionId }) => {
            const transform = buildPendingHiddenTransformer({
                ...options, logger: options.logger ?? logger, sessionId,
            });
            return { transformContext: ({ messages }) => transform([...messages]) };
        },
    };
}
