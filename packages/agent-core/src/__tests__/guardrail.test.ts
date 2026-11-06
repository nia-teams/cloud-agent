import { describe, it, expect } from 'vitest';
import { ToolGuardrailController, DEFAULT_MAIN_AGENT_CONFIG, canonicalJson, mergeGuardrailConfig, } from '../builtins/guardrail.js';
describe('canonicalJson', () => {
    it('orders keys', () => {
        expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    });
    it('handles circular refs', () => {
        const o: Record<string, unknown> = { a: 1 };
        o.self = o;
        const out = canonicalJson(o);
        expect(out).toContain('[circular]');
    });
});
describe('ToolGuardrailController', () => {
    it('warns at exact_failure threshold, halts at halt threshold', () => {
        const c = new ToolGuardrailController(DEFAULT_MAIN_AGENT_CONFIG);
        for (let i = 0; i < 6; i++) {
            const halt = c.beforeCall('foo', { a: 1 });
            expect(halt).toBeNull();
            c.afterCall('foo', { a: 1 }, true, 'err');
        }
        const halt = c.beforeCall('foo', { a: 1 });
        expect(halt).not.toBeNull();
        expect(halt?.type).toBe('exact_failure');
    });
    it('does not advance counter when halted (call is not actually made)', () => {
        const c = new ToolGuardrailController(DEFAULT_MAIN_AGENT_CONFIG);
        for (let i = 0; i < 6; i++) {
            c.beforeCall('foo', { a: 1 });
            c.afterCall('foo', { a: 1 }, true, 'err');
        }
        const halt = c.beforeCall('foo', { a: 1 });
        expect(halt).not.toBeNull();
        expect(c.beforeCall('foo', { a: 1 })).not.toBeNull();
    });
    it('idempotent_no_progress fires for repeat-success on idempotent tools', () => {
        const c = new ToolGuardrailController(DEFAULT_MAIN_AGENT_CONFIG);
        expect(c.afterCall('file_read', { path: '/a' }, false, 'same content')).toBeNull();
        const w = c.afterCall('file_read', { path: '/a' }, false, 'same content');
        expect(w?.type).toBe('idempotent_no_progress');
    });
    it('success clears prior failure counts', () => {
        const c = new ToolGuardrailController(DEFAULT_MAIN_AGENT_CONFIG);
        c.afterCall('foo', { a: 1 }, true, 'err');
        c.afterCall('foo', { a: 1 }, true, 'err');
        c.afterCall('foo', { a: 1 }, false, 'ok');
        const w = c.afterCall('foo', { a: 1 }, true, 'err');
        expect(w).toBeNull();
    });
    it('warns on the 3rd consecutive successful call to an opted-in tool', () => {
        const c = new ToolGuardrailController(mergeGuardrailConfig(DEFAULT_MAIN_AGENT_CONFIG, {
            consecutiveSuccessTools: {
                send_message: { warn: 3, message: 'members already saw the prior messages' },
            },
        }));
        expect(c.afterCall('send_message', { content: 'one' }, false, 'sent')).toBeNull();
        expect(c.afterCall('send_message', { content: 'two' }, false, 'sent')).toBeNull();
        const warning = c.afterCall('send_message', { content: 'three' }, false, 'sent');
        expect(warning).toMatchObject({
            type: 'consecutive_success',
            toolName: 'send_message',
            count: 3,
            message: 'members already saw the prior messages',
        });
    });
    it('clears a consecutive-success streak on another tool, failure, and reset', () => {
        const config = mergeGuardrailConfig(DEFAULT_MAIN_AGENT_CONFIG, {
            consecutiveSuccessTools: {
                send_message: { warn: 3, message: 'stop repeating' },
            },
        });
        const c = new ToolGuardrailController(config);
        c.afterCall('send_message', {}, false, 'sent');
        c.afterCall('other', {}, false, 'ok');
        c.afterCall('send_message', {}, false, 'sent');
        expect(c.afterCall('send_message', {}, false, 'sent')).toBeNull();
        c.afterCall('send_message', {}, true, 'failed');
        c.afterCall('send_message', {}, false, 'sent');
        expect(c.afterCall('send_message', {}, false, 'sent')).toBeNull();
        c.reset();
        c.afterCall('send_message', {}, false, 'sent');
        expect(c.afterCall('send_message', {}, false, 'sent')).toBeNull();
    });
    it('keeps successful write tools unchanged unless the host opts them in', () => {
        const c = new ToolGuardrailController(DEFAULT_MAIN_AGENT_CONFIG);
        for (let i = 0; i < 5; i++) {
            expect(c.afterCall('send_message', { content: `${i}` }, false, 'sent')).toBeNull();
        }
    });
    it('merges product-specific monitored tools without replacing preset entries', () => {
        const preset = {
            ...DEFAULT_MAIN_AGENT_CONFIG,
            consecutiveSuccessTools: {
                publish: { warn: 4, message: 'publish warning' },
            },
        };
        const merged = mergeGuardrailConfig(preset, {
            warn: { exactFailure: 5 },
            consecutiveSuccessTools: {
                send_message: { warn: 3, message: 'send warning' },
            },
        });
        expect(merged.warn).toEqual({
            exactFailure: 5,
            sameToolFailure: 3,
            idempotentNoProgress: 2,
        });
        expect(merged.consecutiveSuccessTools).toEqual({
            publish: { warn: 4, message: 'publish warning' },
            send_message: { warn: 3, message: 'send warning' },
        });
        expect(mergeGuardrailConfig(preset, { consecutiveSuccessTools: null }))
            .not.toHaveProperty('consecutiveSuccessTools');
    });
});
