import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentRuntimeConfig } from '../types.js';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { AgentRuntime, type AgentEvent, type LLMChatResponse } from '../index.js';
import type { LLMChatRequest } from '../protocol/llm-protocol.js';
import { CapturingUsageRecorder, MemoryStore, MockLLMClient, makeEchoTool, userEvent } from './fixtures.js';
async function within(promise: Promise<void>, ms = 250): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout>;
    try {
        return await Promise.race([
            promise.then(() => true),
            new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), ms); }),
        ]);
    }
    finally {
        clearTimeout(timer!);
    }
}
function pendingCall(timeoutMs?: number, abortSignal?: AbortSignal, config: Partial<AgentRuntimeConfig> = {}) {
    const store = new MemoryStore([userEvent('start')]);
    const client = new MockLLMClient([]);
    const usage = new CapturingUsageRecorder();
    const echo = makeEchoTool();
    const events: AgentEvent[] = [];
    let resolve!: (response: LLMChatResponse) => void;
    let reject!: (error: Error) => void;
    let request!: LLMChatRequest;
    let started!: () => void;
    const ready = new Promise<void>(r => { started = r; });
    client.chat = async (req) => {
        request = req;
        client.calls.push(req);
        started();
        return await new Promise<LLMChatResponse>((yes, no) => { resolve = yes; reject = no; });
    };
    const runtime = new AgentRuntime({ store, sessionId: 'deadline', usage, llmCallTimeoutMs: timeoutMs, ...config });
    const running = runtime.run({ client, systemPrompt: '', tools: [echo], keyId: 'test', abortSignal, onEvent: event => { events.push(event); } });
    return { store, client, usage, echo, events, ready, running, resolve: (value: LLMChatResponse) => resolve(value), reject: (error: Error) => reject(error), request: () => request };
}
describe('runtime enforces the existing per-call deadline', () => {
    it('settles on timeout even when a client never observes cancellation', async () => {
        const call = pendingCall(20);
        try {
            await call.ready;
            expect(await within(call.running)).toBe(true);
            expect(call.request().signal?.reason?.name).toBe('TimeoutError');
            expect(call.usage.entries[0].exitKind).toBe('error');
            expect(call.client.calls).toHaveLength(1);
            expect(call.store.stored.some(message => message.type === 'assistant')).toBe(false);
        }
        finally {
            call.resolve({ content: 'late', stopReason: 'end_turn', usage: { promptTokens: 1, completionTokens: 1 } });
            await call.running;
        }
    });
    it('does not accept late tool calls, stream deltas or completion after deadline', async () => {
        const call = pendingCall(20);
        try {
            await call.ready;
            expect(await within(call.running)).toBe(true);
            const count = call.events.length;
            call.request().onStreamDelta?.({ type: 'text', content: 'late text' });
            call.resolve({ content: null, stopReason: 'tool_use', toolCalls: [{ id: 'late', name: 'echo', arguments: '{"text":"late"}' }], usage: { promptTokens: 1, completionTokens: 1 } });
            await Promise.resolve();
            await Promise.resolve();
            expect(call.events).toHaveLength(count);
            expect(call.echo.calls).toHaveLength(0);
            expect(call.store.stored.some(message => message.type === 'assistant')).toBe(false);
        }
        finally {
            call.resolve({ content: 'late', stopReason: 'end_turn' });
            await call.running;
        }
    });
    it('consumes late client rejection after the timeout has already settled', async () => {
        const call = pendingCall(20);
        try {
            await call.ready;
            expect(await within(call.running)).toBe(true);
            call.reject(new Error('late upstream failure'));
            await new Promise(resolve => setImmediate(resolve));
            expect(call.usage.entries).toHaveLength(1);
            expect(call.usage.entries[0].exitKind).toBe('error');
        }
        finally {
            call.resolve({ content: 'late', stopReason: 'end_turn' });
            await call.running;
        }
    });
    it('settles manual cancellation without waiting for an uncooperative client', async () => {
        const controller = new AbortController();
        const call = pendingCall(10000, controller.signal);
        try {
            await call.ready;
            controller.abort();
            expect(await within(call.running)).toBe(true);
            expect(call.usage.entries[0].exitKind).toBe('aborted');
            expect(call.echo.calls).toHaveLength(0);
        }
        finally {
            call.resolve({ content: 'late', stopReason: 'end_turn' });
            await call.running;
        }
    });
    it('keeps the deadline source alive through garbage collection', async () => {
        setFlagsFromString('--expose_gc');
        const gc = runInNewContext('gc') as () => void;
        const call = pendingCall(50);
        try {
            await call.ready;
            await new Promise(resolve => setImmediate(resolve));
            gc();
            expect(await within(call.running, 500)).toBe(true);
            expect(call.request().signal?.reason?.name).toBe('TimeoutError');
            expect(call.usage.entries[0].exitKind).toBe('error');
        }
        finally {
            call.resolve({ content: 'late', stopReason: 'end_turn' });
            await call.running;
            setFlagsFromString('--no-expose_gc');
        }
    });
    it.each([-1, 1.5, NaN, Infinity, 4294967296])('rejects the previously invalid timeout value %s', async (timeoutMs) => {
        const store = new MemoryStore([userEvent('start')]);
        const client = new MockLLMClient([{ content: 'must not run' }]);
        const runtime = new AgentRuntime({ store, sessionId: 'invalid-timeout', llmCallTimeoutMs: timeoutMs });
        await expect(runtime.run({ client, systemPrompt: '', tools: [], keyId: 'test' })).rejects.toBeInstanceOf(RangeError);
        expect(client.calls).toHaveLength(0);
    });
});
describe('per-call streaming idle deadline', () => {
    afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
    function streamingCall(config: Partial<AgentRuntimeConfig> = {}) {
        vi.useFakeTimers();
        const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
        const call = pendingCall(undefined, undefined, { logger, ...config });
        return { ...call, logger };
    }
    it.each(['thinking', 'text', 'tool_input_start', 'tool_input_delta'] as const)('keeps a healthy %s stream alive past the default 300s idle limit', async (type) => {
        const call = streamingCall();
        await call.ready;
        expect(call.logger.info).toHaveBeenCalledWith(expect.objectContaining({
            timeoutMs: 1200000, idleTimeoutMs: 300000,
        }), 'LLM call start');
        for (let elapsed = 10000; elapsed <= 350000; elapsed += 10000) {
            await vi.advanceTimersByTimeAsync(10000);
            call.request().onStreamDelta?.({ type, content: type === 'tool_input_start' ? '' : 'delta', toolCallId: 'c1', toolName: 'echo' });
            expect(call.request().signal?.aborted).toBe(false);
        }
        call.resolve({ content: 'done', stopReason: 'end_turn' });
        await call.running;
        expect(call.usage.entries[0].exitKind).not.toBe('error');
        expect(vi.getTimerCount()).toBe(0);
    });
    it('aborts at 420s after the last valid delta at 120s, ignoring empty and unknown deltas', async () => {
        const call = streamingCall();
        await call.ready;
        for (let elapsed = 10000; elapsed <= 120000; elapsed += 10000) {
            await vi.advanceTimersByTimeAsync(10000);
            call.request().onStreamDelta?.({ type: 'thinking', content: 'still thinking' });
        }
        for (let elapsed = 135000; elapsed <= 405000; elapsed += 15000) {
            await vi.advanceTimersByTimeAsync(15000);
            for (const delta of [
                { type: 'text', content: '' },
                { type: 'thinking', content: '' },
                { type: 'tool_input_delta', toolCallId: 'c1', content: '', partialJson: '' },
                { type: 'tool_input_delta', content: 'missing id' },
                { type: 'tool_input_delta', toolCallId: 'c1', content: 'ignored fallback', partialJson: '' },
                { type: 'unknown', content: 'not business data' },
            ]) {
                call.request().onStreamDelta?.(delta as Parameters<NonNullable<LLMChatRequest['onStreamDelta']>>[0]);
            }
            expect(call.request().signal?.aborted).toBe(false);
        }
        await vi.advanceTimersByTimeAsync(14999);
        expect(call.request().signal?.aborted).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        await call.running;
        expect(call.request().signal?.reason).toBeInstanceOf(DOMException);
        expect(call.request().signal?.reason.name).toBe('TimeoutError');
        expect(call.request().signal?.reason.message).toContain('stream idle timeout');
        expect(call.logger.error).toHaveBeenCalledWith(expect.objectContaining({
            llmCallDurationMs: 420000, isTimeout: true, timeoutKind: 'idle',
        }), 'LLM call failed');
        call.request().onStreamDelta?.({ type: 'text', content: 'late' });
        expect(vi.getTimerCount()).toBe(0);
    });
    it('enforces the default 1200s maximum duration despite continuous valid deltas', async () => {
        const call = streamingCall();
        await call.ready;
        for (let elapsed = 10000; elapsed < 1200000; elapsed += 10000) {
            await vi.advanceTimersByTimeAsync(10000);
            call.request().onStreamDelta?.({ type: 'text', content: 'still working' });
            expect(call.request().signal?.aborted).toBe(false);
        }
        await vi.advanceTimersByTimeAsync(9999);
        expect(call.request().signal?.aborted).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        await call.running;
        expect(call.request().signal?.reason.name).toBe('TimeoutError');
        expect(call.logger.error).toHaveBeenCalledWith(expect.objectContaining({
            llmCallDurationMs: 1200000, isTimeout: true, timeoutKind: 'max_duration',
        }), 'LLM call failed');
        expect(vi.getTimerCount()).toBe(0);
    });
    it('arms idle detection before the first delta or connection completes', async () => {
        const call = streamingCall();
        await call.ready;
        await vi.advanceTimersByTimeAsync(299999);
        expect(call.request().signal?.aborted).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        await call.running;
        expect(call.request().signal?.reason.name).toBe('TimeoutError');
        expect(call.logger.error).toHaveBeenCalledWith(expect.objectContaining({ timeoutKind: 'idle' }), 'LLM call failed');
        expect(vi.getTimerCount()).toBe(0);
    });
    it('disposes both timers on manual cancellation and ignores subsequent valid deltas', async () => {
        const controller = new AbortController();
        vi.useFakeTimers();
        const call = pendingCall(1000, controller.signal, { llmIdleTimeoutMs: 100 });
        await call.ready;
        expect(vi.getTimerCount()).toBe(2);
        controller.abort();
        await call.running;
        call.request().onStreamDelta?.({ type: 'text', content: 'too late' });
        expect(vi.getTimerCount()).toBe(0);
        expect(call.usage.entries[0].exitKind).toBe('aborted');
    });
    it.each([20, 300000])('uses only the max timer when idle timeout %s cannot fire first', async (llmIdleTimeoutMs) => {
        const call = streamingCall({ llmCallTimeoutMs: 20, llmIdleTimeoutMs });
        await call.ready;
        expect(vi.getTimerCount()).toBe(1);
        expect(call.logger.info).toHaveBeenCalledWith(expect.objectContaining({ idleTimeoutMs: 20 }), 'LLM call start');
        await vi.advanceTimersByTimeAsync(20);
        await call.running;
        expect(call.logger.error).toHaveBeenCalledWith(expect.objectContaining({ timeoutKind: 'max_duration' }), 'LLM call failed');
        expect(vi.getTimerCount()).toBe(0);
    });
    it.each([-1, 1.5, NaN, Infinity, 4294967296])('rejects invalid idle timeout %s before allocating any timer or calling the client', async (llmIdleTimeoutMs) => {
        vi.useFakeTimers();
        const store = new MemoryStore([userEvent('start')]);
        const client = new MockLLMClient([{ content: 'must not run' }]);
        const runtime = new AgentRuntime({ store, sessionId: 'invalid-idle', llmCallTimeoutMs: 20, llmIdleTimeoutMs });
        await expect(runtime.run({ client, systemPrompt: '', tools: [], keyId: 'test' }))
            .rejects.toThrow(new RangeError('LLM timeout must be an integer between 0 and 4294967295 ms'));
        expect(client.calls).toHaveLength(0);
        expect(vi.getTimerCount()).toBe(0);
    });
});
