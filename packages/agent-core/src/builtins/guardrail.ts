import { createHash } from 'node:crypto';
export type GuardrailWarningType = 'exact_failure' | 'same_tool_failure' | 'idempotent_no_progress' | 'consecutive_success';
export interface GuardrailWarning {
    type: GuardrailWarningType;
    toolName: string;
    count: number;
    message: string;
}
export interface GuardrailHalt {
    type: 'exact_failure' | 'same_tool_failure';
    toolName: string;
    count: number;
    message: string;
}
export interface GuardrailThresholds {
    exactFailure: number;
    sameToolFailure: number;
    idempotentNoProgress: number;
}
export interface GuardrailHaltThresholds {
    exactFailure: number;
    sameToolFailure: number;
}
export interface ConsecutiveSuccessToolConfig {
    warn: number;
    message: string;
}
export interface GuardrailConfig {
    warn: GuardrailThresholds;
    halt: GuardrailHaltThresholds;
    idempotentTools: ReadonlySet<string>;
    consecutiveSuccessTools?: Readonly<Record<string, ConsecutiveSuccessToolConfig>>;
}
export interface GuardrailConfigOverride {
    warn?: Partial<GuardrailThresholds>;
    halt?: Partial<GuardrailHaltThresholds>;
    idempotentTools?: ReadonlySet<string>;
    consecutiveSuccessTools?: Readonly<Record<string, ConsecutiveSuccessToolConfig>> | null;
}
export const DEFAULT_MAIN_AGENT_CONFIG: GuardrailConfig = {
    warn: { exactFailure: 2, sameToolFailure: 3, idempotentNoProgress: 2 },
    halt: { exactFailure: 6, sameToolFailure: 6 },
    idempotentTools: new Set([
        'file_read',
        'file_list',
        'file_search',
        'web_search',
        'web_fetch',
    ]),
};
export const DEFAULT_SUBAGENT_CONFIG: GuardrailConfig = {
    warn: { exactFailure: 2, sameToolFailure: 3, idempotentNoProgress: 2 },
    halt: { exactFailure: 6, sameToolFailure: 6 },
    idempotentTools: DEFAULT_MAIN_AGENT_CONFIG.idempotentTools,
};
export function mergeGuardrailConfig(preset: GuardrailConfig, override: GuardrailConfigOverride | undefined): GuardrailConfig {
    if (!override)
        return preset;
    const consecutiveSuccessTools = override.consecutiveSuccessTools === null
        ? {}
        : {
            ...(preset.consecutiveSuccessTools ?? {}),
            ...(override.consecutiveSuccessTools ?? {}),
        };
    return {
        warn: { ...preset.warn, ...override.warn },
        halt: { ...preset.halt, ...override.halt },
        idempotentTools: override.idempotentTools ?? preset.idempotentTools,
        ...(Object.keys(consecutiveSuccessTools).length > 0
            ? { consecutiveSuccessTools }
            : {}),
    };
}
function signature(toolName: string, args: unknown): string {
    const canonical = canonicalJson(args);
    return createHash('sha256').update(toolName).update('\0').update(canonical).digest('hex');
}
function hashResult(result: string): string {
    return createHash('sha256').update(result).digest('hex');
}
export function canonicalJson(value: unknown): string {
    const seen = new WeakSet<object>();
    const walk = (v: unknown): unknown => {
        if (v === null || typeof v !== 'object')
            return v;
        if (seen.has(v as object))
            return '[circular]';
        seen.add(v as object);
        if (Array.isArray(v))
            return v.map(walk);
        const entries = Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
        const out: Record<string, unknown> = {};
        for (const [k, val] of entries)
            out[k] = walk(val);
        return out;
    };
    try {
        return JSON.stringify(walk(value));
    }
    catch {
        return String(value);
    }
}
export class ToolGuardrailController {
    private exactFailCounts = new Map<string, number>();
    private sameToolFailCounts = new Map<string, number>();
    private idempotentResults = new Map<string, {
        hash: string;
        count: number;
    }>();
    private consecutiveSuccess: {
        toolName: string;
        count: number;
    } | null = null;
    constructor(private readonly config: GuardrailConfig) { }
    beforeCall(toolName: string, args: unknown): GuardrailHalt | null {
        const sig = signature(toolName, args);
        const exactCount = this.exactFailCounts.get(sig) ?? 0;
        const sameCount = this.sameToolFailCounts.get(toolName) ?? 0;
        if (exactCount >= this.config.halt.exactFailure) {
            return {
                type: 'exact_failure',
                toolName,
                count: exactCount,
                message: `[Tool loop halted: ${toolName} has already failed ${exactCount}x with these exact arguments. ` +
                    `This call has been blocked. Change your approach — either use different arguments, ` +
                    `a different tool, or report the failure back to the user.]`,
            };
        }
        if (sameCount >= this.config.halt.sameToolFailure) {
            return {
                type: 'same_tool_failure',
                toolName,
                count: sameCount,
                message: `[Tool loop halted: ${toolName} has already failed ${sameCount}x in this run. ` +
                    `This call has been blocked. Stop using ${toolName} for this task — ` +
                    `try a different tool or report the failure back to the user.]`,
            };
        }
        return null;
    }
    afterCall(toolName: string, args: unknown, isError: boolean, result: string): GuardrailWarning | null {
        const sig = signature(toolName, args);
        if (isError) {
            this.consecutiveSuccess = null;
            const exactCount = (this.exactFailCounts.get(sig) ?? 0) + 1;
            const sameCount = (this.sameToolFailCounts.get(toolName) ?? 0) + 1;
            this.exactFailCounts.set(sig, exactCount);
            this.sameToolFailCounts.set(toolName, sameCount);
            this.idempotentResults.delete(sig);
            if (exactCount >= this.config.warn.exactFailure) {
                return {
                    type: 'exact_failure',
                    toolName,
                    count: exactCount,
                    message: `[Tool loop warning: ${toolName} failed ${exactCount}x with identical arguments. ` +
                        `Change your arguments or try a different approach — the same call will keep failing.]`,
                };
            }
            if (sameCount >= this.config.warn.sameToolFailure) {
                return {
                    type: 'same_tool_failure',
                    toolName,
                    count: sameCount,
                    message: `[Tool loop warning: ${toolName} has failed ${sameCount}x in this run. ` +
                        `Stop retrying this tool and try a different approach (different tool, or report the failure back to the user).]`,
                };
            }
            return null;
        }
        this.exactFailCounts.delete(sig);
        this.sameToolFailCounts.delete(toolName);
        const consecutiveConfig = this.config.consecutiveSuccessTools?.[toolName];
        if (consecutiveConfig) {
            const count = this.consecutiveSuccess?.toolName === toolName
                ? this.consecutiveSuccess.count + 1
                : 1;
            this.consecutiveSuccess = { toolName, count };
            if (count >= consecutiveConfig.warn) {
                return {
                    type: 'consecutive_success',
                    toolName,
                    count,
                    message: consecutiveConfig.message,
                };
            }
        }
        else {
            this.consecutiveSuccess = null;
        }
        if (!this.config.idempotentTools.has(toolName)) {
            this.idempotentResults.delete(sig);
            return null;
        }
        const rHash = hashResult(result);
        const prev = this.idempotentResults.get(sig);
        if (prev && prev.hash === rHash) {
            const count = prev.count + 1;
            this.idempotentResults.set(sig, { hash: rHash, count });
            if (count >= this.config.warn.idempotentNoProgress) {
                return {
                    type: 'idempotent_no_progress',
                    toolName,
                    count,
                    message: `[Tool loop warning: ${toolName} has returned the same result ${count}x. ` +
                        `The data hasn't changed — stop re-reading and act on what you already have.]`,
                };
            }
        }
        else {
            this.idempotentResults.set(sig, { hash: rHash, count: 1 });
        }
        return null;
    }
    reset(): void {
        this.exactFailCounts.clear();
        this.sameToolFailCounts.clear();
        this.idempotentResults.clear();
        this.consecutiveSuccess = null;
    }
    debugStats(): {
        exactFails: number;
        sameToolFails: number;
        idempotentTracked: number;
        consecutiveSuccess: {
            toolName: string;
            count: number;
        } | null;
    } {
        return {
            exactFails: this.exactFailCounts.size,
            sameToolFails: this.sameToolFailCounts.size,
            idempotentTracked: this.idempotentResults.size,
            consecutiveSuccess: this.consecutiveSuccess,
        };
    }
}
export function createGuardrailPlugin(options: {
    preset?: 'main' | 'subagent';
    config?: GuardrailConfigOverride;
} = {}): import('../types.js').RuntimePlugin {
    return {
        name: 'guardrail',
        forSubagent: () => createGuardrailPlugin({ preset: 'subagent' }),
        create: () => {
            const controller = new ToolGuardrailController(mergeGuardrailConfig(options.preset === 'subagent' ? DEFAULT_SUBAGENT_CONFIG : DEFAULT_MAIN_AGENT_CONFIG, options.config));
            return {
                beforeToolCall: ({ toolName, args }) => {
                    const halt = controller.beforeCall(toolName, args);
                    if (!halt)
                        return;
                    return {
                        content: halt.message,
                        isError: true,
                        guidance: [{
                                kind: 'tool_loop_warning', warningType: halt.type,
                                toolName: halt.toolName, count: halt.count,
                            }],
                    };
                },
                afterToolCall: ({ toolName, args, message }) => {
                    const warning = controller.afterCall(toolName, args, !!message.isError, message.content);
                    if (!warning)
                        return;
                    message.content += `\n\n${warning.message}`;
                    message.guidance = [...(message.guidance ?? []), {
                            kind: 'tool_loop_warning', warningType: warning.type,
                            toolName: warning.toolName, count: warning.count,
                            ...(warning.type === 'consecutive_success' ? { message: warning.message } : {}),
                        }];
                },
            };
        },
    };
}
