import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpenAIClient, type OpenAIClientOptions } from '../clients/openai.js';
import type { LLMChatRequest } from '../protocol/index.js';

afterEach(() => vi.unstubAllGlobals());
async function wire(options: Partial<OpenAIClientOptions>, request: Partial<LLMChatRequest> = {}) {
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(JSON.stringify({
    choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
  }), { headers: { 'Content-Type': 'application/json' } }));
  vi.stubGlobal('fetch', fetch);
  const client = new OpenAIClient({ apiKey: 'key', model: 'arbitrary-model', baseURL: 'https://wire.invalid/v1', supportsThinking: true, reasoningFormat: 'thinking_object', ...options });
  await client.chat({ messages: [], ...request });
  return JSON.parse(String(fetch.mock.calls[0]![1]?.body));
}

describe('explicit OpenAI-compatible reasoning shapes', () => {
  it.each([
    { label: 'configured budget', defaults: { enableThinking: true, thinkingBudget: 8192 }, request: {}, expected: { type: 'enabled', budget_tokens: 8192 } },
    { label: 'unconfigured budget', defaults: { enableThinking: true }, request: {}, expected: { type: 'enabled' } },
    { label: 'zero is configured', defaults: { enableThinking: true, thinkingBudget: 0 }, request: {}, expected: { type: 'enabled', budget_tokens: 0 } },
    { label: 'request overrides budget', defaults: { enableThinking: true, thinkingBudget: 8192 }, request: { thinkingBudget: 4096 }, expected: { type: 'enabled', budget_tokens: 4096 } },
    { label: 'explicitly disabled', defaults: { enableThinking: true, thinkingBudget: 8192 }, request: { enableThinking: false }, expected: { type: 'disabled' } },
    { label: 'disabled by effort', defaults: { enableThinking: true, thinkingBudget: 8192 }, request: { effort: 'none' as const }, expected: { type: 'disabled' } },
    { label: 'adaptive omits fixed budget', defaults: { enableThinking: true, thinkingBudget: 8192, thinkingType: 'adaptive' as const }, request: {}, expected: { type: 'adaptive' } },
  ])('thinking_object: $label', async ({ defaults, request, expected }) => {
    const body = await wire({ defaults }, request);
    expect(body.thinking).toEqual(expected);
    for (const key of ['reasoning', 'reasoning_effort', 'enable_thinking', 'thinking_budget', 'chat_template_kwargs']) expect(body).not.toHaveProperty(key);
  });

  it('allows endpoints to disable by omission without losing independent effort', async () => {
    const disabled = await wire({ omitDisabledThinking: true, supportsReasoningEffort: true, defaults: { enableThinking: true, thinkingBudget: 8192 } }, { enableThinking: false, effort: 'high' });
    expect(disabled).not.toHaveProperty('thinking');
    expect(disabled.reasoning_effort).toBe('high');
    const none = await wire({ omitDisabledThinking: true, supportsReasoningEffort: true, defaults: { enableThinking: true, thinkingBudget: 8192 } }, { effort: 'none' });
    expect(none).not.toHaveProperty('thinking');
    expect(none.reasoning_effort).toBe('none');
  });
  it('does not infer thinking from a budget alone', async () => {
    expect(await wire({ defaults: { thinkingBudget: 8192 } })).not.toHaveProperty('thinking');
  });
  it('only emits enabled thinking when supported', async () => {
    expect(await wire({ supportsThinking: false, defaults: { enableThinking: true, thinkingBudget: 8192 } })).not.toHaveProperty('thinking');
  });
  it('preserves explicit effort with a configured thinking budget', async () => {
    expect(await wire({ supportsReasoningEffort: true, defaults: { enableThinking: true, thinkingBudget: 8192 } }, { effort: 'high' })).toMatchObject({ thinking: { type: 'enabled', budget_tokens: 8192 }, reasoning_effort: 'high' });
  });
  it('emits chat-template booleans, including explicit disable', async () => {
    for (const enabled of [true, false]) {
      const body = await wire({ reasoningFormat: 'chat_template_kwargs', defaults: { enableThinking: enabled } });
      expect(body.chat_template_kwargs).toEqual({ enable_thinking: enabled });
      expect(body).not.toHaveProperty('thinking');
    }
    expect(await wire({ reasoningFormat: 'chat_template_kwargs', defaults: { enableThinking: true } }, { effort: 'none' })).toHaveProperty('chat_template_kwargs.enable_thinking', false);
  });
  it('emits top-level thinking_budget only when configured and enabled', async () => {
    expect(await wire({ reasoningFormat: 'thinking_budget', defaults: { enableThinking: true, thinkingBudget: 4096 } })).toHaveProperty('thinking_budget', 4096);
    expect(await wire({ reasoningFormat: 'thinking_budget', defaults: { enableThinking: true } })).not.toHaveProperty('thinking_budget');
    expect(await wire({ reasoningFormat: 'thinking_budget', defaults: { enableThinking: true, thinkingBudget: 4096 } }, { effort: 'none' })).not.toHaveProperty('thinking_budget');
  });
  it('keeps enable_thinking independent from unsupported effort none and omits effort when disabled', async () => {
    expect(await wire({ reasoningFormat: 'enable_thinking', supportsReasoningEffort: true }, { enableThinking: true, effort: 'none' })).toMatchObject({ enable_thinking: true });
    const body = await wire({ reasoningFormat: 'enable_thinking', supportsReasoningEffort: true }, { enableThinking: false, effort: 'high' });
    expect(body.enable_thinking).toBe(false);
    expect(body).not.toHaveProperty('reasoning_effort');
  });
});
