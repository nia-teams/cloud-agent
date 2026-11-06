import type { AiPostContext } from './types.js';
export function renderAiPostContext(context: AiPostContext): string {
    if (typeof context === 'string')
        return context;
    if (context.kind === 'tool_loop_warning') {
        return context.message ?? `[Tool loop warning: ${context.toolName} ${context.warningType} (${context.count}). Stop repeating the same call and try a different approach or report to the user.]`;
    }
    if (typeof (context as {
        text?: unknown;
    }).text === 'string') {
        return (context as {
            text: string;
        }).text;
    }
    return '';
}
export function renderAiPostContexts(contexts: readonly AiPostContext[] | undefined): string {
    return (contexts ?? []).map(renderAiPostContext).join('\n\n');
}
