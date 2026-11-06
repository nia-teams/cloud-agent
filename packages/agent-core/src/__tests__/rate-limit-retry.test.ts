import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentRuntime } from '../runtime.js';
import { isRateLimitError, rateLimitDelayMs } from '../rate-limit-retry.js';
import { MemoryStore, MockLLMClient, userEvent } from './fixtures.js';
const limited = (retryAfter = '0') => Object.assign(new Error('HTTP 429'), { status: 429, retryAfter });
afterEach(() => vi.useRealTimers());
describe('shared runtime 429 current-step retry', () => {
    it('reads SDK headers, OpenAI retryAfter and cyclic causes safely', () => {
        expect(rateLimitDelayMs(limited('2'))).toBe(2000);
        expect(rateLimitDelayMs({ headers: new Headers({ 'retry-after': '3' }) })).toBe(3000);
        expect(rateLimitDelayMs(new Error('429'))).toBe(60000);
        expect(rateLimitDelayMs(limited('600'))).toBeNull();
        const e: any = new Error('other');
        e.cause = e;
        expect(isRateLimitError(e)).toBe(false);
    });
    it('retries twice using identical prepared messages, then persists only the successful response', async () => {
        const client = new MockLLMClient([{ throws: limited() }, { throws: limited() }, { content: 'done' }]);
        const store = new MemoryStore([userEvent('task')]);
        const runtime = new AgentRuntime({ store });
        await runtime.run({ client, systemPrompt: '', tools: [], keyId: 'k' });
        expect(client.calls).toHaveLength(3);
        expect(client.calls[1].messages).toBe(client.calls[0].messages);
        expect(store.stored.filter(m => m.type === 'assistant')).toHaveLength(1);
    });
    it('exhausts exactly two retries without persisting a fabricated assistant', async () => {
        const client = new MockLLMClient([{ throws: limited() }, { throws: limited() }, { throws: limited() }]);
        const store = new MemoryStore([userEvent('task')]);
        await new AgentRuntime({ store }).run({ client, systemPrompt: '', tools: [], keyId: 'k' });
        expect(client.calls).toHaveLength(3);
        expect(store.stored.filter(m => m.type === 'assistant')).toHaveLength(0);
    });
    it('cancels a pending delay without another request', async () => {
        const abort = new AbortController();
        const client = new MockLLMClient([{ throws: limited('60') }]);
        const run = new AgentRuntime({ store: new MemoryStore([userEvent('task')]) }).run({ client, systemPrompt: '', tools: [], keyId: 'k', abortSignal: abort.signal });
        await new Promise(resolve => setTimeout(resolve, 10));
        abort.abort();
        await run;
        expect(client.calls).toHaveLength(1);
    });
    it('does not replay visible streamed output', async () => {
        const client = new MockLLMClient([{ throws: limited(), streamDeltas: [{ type: 'text', content: 'partial' }] }]);
        const runtime = new AgentRuntime({ store: new MemoryStore([userEvent('task')]) });
        await runtime.run({ client, systemPrompt: '', tools: [], keyId: 'k' });
        expect(client.calls).toHaveLength(1);
    });
});
