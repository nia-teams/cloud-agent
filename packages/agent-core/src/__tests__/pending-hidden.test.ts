import { describe, it, expect } from 'vitest';
import { buildPendingHiddenTransformer } from '../builtins/pending-hidden.js';
import type { AgentMessage } from '../types.js';
function event(content: string, opts: {
    userId?: string;
    eventType?: string;
} = {}): AgentMessage {
    return {
        type: 'event',
        eventType: opts.eventType ?? 'message',
        content,
        timestamp: new Date(),
        meta: { userId: opts.userId ?? 'human-a' },
    } as AgentMessage;
}
function assistant(text: string): AgentMessage {
    return { type: 'assistant', content: text, timestamp: new Date(), turnId: 't' } as AgentMessage;
}
function tool(content: string): AgentMessage {
    return { type: 'tool', toolCallId: 'tc', content, isError: false, timestamp: new Date(), turnId: 't' } as AgentMessage;
}
const isSkippable = (m: AgentMessage) => m.type === 'event' && m.content.includes('@human') && !m.content.includes('@AI');
const isUserActionable = (m: AgentMessage) => m.type === 'event' && !isSkippable(m);
describe('buildPendingHiddenTransformer', () => {
    it('passes through messages with no trailing skippable events', async () => {
        const fn = buildPendingHiddenTransformer({ isSkippable, isUserActionable });
        const msgs = [event('hi @AI'), assistant('ok')];
        const result = await fn(msgs);
        expect(result).toBe(msgs);
    });
    it('hides contiguous trailing skippable events', async () => {
        const fn = buildPendingHiddenTransformer({ isSkippable, isUserActionable });
        const actionable = event('hi @AI');
        const skip1 = event('foo @human');
        const skip2 = event('bar @human');
        const msgs: AgentMessage[] = [actionable, skip1, skip2];
        const result = await fn(msgs);
        expect(result).toEqual([actionable]);
        expect(result).not.toContain(skip1);
        expect(result).not.toContain(skip2);
    });
    it('safety net: filtered tail would be assistant → falls back to no-filter', async () => {
        const fn = buildPendingHiddenTransformer({ isSkippable, isUserActionable });
        const a = assistant('hello');
        const skip = event('foo @human');
        const msgs = [a, skip];
        const result = await fn(msgs);
        expect(result).toBe(msgs);
    });
    it('subagent mode: passthrough always', async () => {
        const fn = buildPendingHiddenTransformer({
            isSkippable,
            isUserActionable,
            isSubagent: true,
        });
        const msgs = [event('foo @human'), event('bar @human')];
        const result = await fn(msgs);
        expect(result).toBe(msgs);
    });
    it('non-skippable non-actionable msgs (assistant/tool) are skipped over during scan', async () => {
        const fn = buildPendingHiddenTransformer({ isSkippable, isUserActionable });
        const actionable = event('hi @AI');
        const a = assistant('ok');
        const t = tool('result');
        const skip = event('foo @human');
        const msgs: AgentMessage[] = [actionable, a, t, skip];
        const result = await fn(msgs);
        expect(result).toHaveLength(3);
        expect(result).not.toContain(skip);
    });
});
