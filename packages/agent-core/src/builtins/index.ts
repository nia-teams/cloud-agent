import type { RuntimePlugin } from '../types.js';
import { createContextPruningPlugin } from './context-pruning.js';
import type { ContextPrunerOptions } from './context-pruning.js';
import { createGuardrailPlugin } from './guardrail.js';
import type { GuardrailConfigOverride } from './guardrail.js';
import { createLargeToolResultPlugin } from './large-tool-result.js';
import type { LargeToolResultOptions } from './large-tool-result.js';
export * from './context-pruning.js';
export * from './guardrail.js';
export * from './large-tool-result.js';
export * from './pending-hidden.js';
export type GuardrailSwitch = 'main' | 'subagent' | false;
export interface DefaultBuiltinPluginOptions {
    contextPruning?: boolean | ContextPrunerOptions;
    guardrail?: GuardrailSwitch;
    guardrailConfig?: GuardrailConfigOverride;
    largeToolResult?: LargeToolResultOptions;
}
export function createDefaultBuiltinPlugins(options: DefaultBuiltinPluginOptions = {}): RuntimePlugin[] {
    return [
        ...(options.contextPruning === false ? [] : [createContextPruningPlugin(typeof options.contextPruning === 'object' ? options.contextPruning : {})]),
        ...(options.guardrail === false ? [] : [createGuardrailPlugin({
                preset: options.guardrail, config: options.guardrailConfig,
            })]),
        ...(options.largeToolResult ? [createLargeToolResultPlugin(options.largeToolResult)] : []),
    ];
}
