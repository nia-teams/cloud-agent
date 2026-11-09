import { afterEach, describe, expect, it, vi } from 'vitest';
import { createClient } from '../create-client.js';
import { AnthropicClient } from '../clients/anthropic.js';
import { OpenAIClient } from '../clients/openai.js';
import { ResponsesClient } from '../clients/responses.js';
import { GeminiClient } from '../clients/gemini.js';
afterEach(() => vi.unstubAllGlobals());
describe('wire factory', () => {
 it.each([
  ['anthropic', AnthropicClient], ['openai-completions', OpenAIClient], ['openai-responses', ResponsesClient], ['gemini', GeminiClient],
 ] as const)('constructs %s without a registry', (protocol, Constructor) => {
  const client = createClient({ protocol, apiKey: 'test-key', model: 'test-model' });
  expect(client).toBeInstanceOf(Constructor); expect(client.getModelName()).toBe('test-model');
 });
 it('identifies the Responses transport by its wire name', () => {
  expect(createClient({ protocol: 'openai-responses', apiKey: 'key', model: 'model' }).getProviderName()).toBe('responses');
 });
 it.each([
  { reasoningFormat: 'openai', effort: 'high', expected: { reasoning_effort: 'high' } },
  { reasoningFormat: 'reasoning_object', effort: 'high', expected: { reasoning: { effort: 'high' } } },
  { reasoningFormat: 'reasoning_object', effort: undefined, expected: { reasoning: { enabled: true } } },
  { reasoningFormat: 'thinking_object', effort: 'high', expected: { thinking: { type: 'enabled' }, reasoning_effort: 'high' } },
  { reasoningFormat: 'thinking_object', effort: 'none', expected: { thinking: { type: 'disabled' } } },
  { reasoningFormat: 'enable_thinking', effort: 'high', expected: { enable_thinking: true, reasoning_effort: 'high' } },
  { reasoningFormat: 'enable_thinking', effort: 'none', expected: { enable_thinking: true } },
 ] as const)('sends only the selected $reasoningFormat wire shape ($effort)', async ({ reasoningFormat, effort, expected }) => {
  const fetch = vi.fn(async () => new Response(JSON.stringify({ id: 'completion', choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] }), { headers: { 'Content-Type': 'application/json' } }));
  vi.stubGlobal('fetch', fetch);
  const client = createClient({ protocol: 'openai-completions', apiKey: 'test-key', model: 'arbitrary-model', baseURL: 'https://mock.invalid/v1', reasoningFormat, supportsThinking: true, supportsReasoningEffort: true });
  await client.chat({ messages: [], enableThinking: true, effort });
  const init = fetch.mock.calls[0]?.[1] as RequestInit | undefined;
  const body = JSON.parse(String(init?.body));
  expect(body).toMatchObject(expected);
  for (const key of ['reasoning_effort','reasoning','thinking','enable_thinking']) if (!(key in expected)) expect(body).not.toHaveProperty(key);
 });
 it('ignores ANTHROPIC_AUTH_TOKEN, ANTHROPIC_WEBHOOK_SIGNING_KEY, and ANTHROPIC_BASE_URL from process.env', async () => {
  vi.stubEnv('ANTHROPIC_AUTH_TOKEN', 'leaked-bearer-token');
  vi.stubEnv('ANTHROPIC_WEBHOOK_SIGNING_KEY', 'leaked-webhook-secret');
  vi.stubEnv('ANTHROPIC_BASE_URL', 'https://leaked-anthropic.invalid');
  const fetch = vi.fn(async () => new Response(JSON.stringify({
   id: 'msg_1',
   type: 'message',
   role: 'assistant',
   model: 'claude-sonnet-5-5',
   content: [{ type: 'text', text: 'ok' }],
   stop_reason: 'end_turn',
   stop_sequence: null,
   usage: { input_tokens: 1, output_tokens: 1 },
  }), { headers: { 'Content-Type': 'application/json' } }));
  vi.stubGlobal('fetch', fetch);
  try {
   const client = createClient({ protocol: 'anthropic', apiKey: 'explicit-anthropic-key', model: 'claude-sonnet-5-5' });
   await client.chat({ messages: [{ type: 'event', eventType: 'user_message', content: 'hi' }] });
   const [url, init] = fetch.mock.calls[0]!;
   const headers = new Headers((init as RequestInit)?.headers);
   expect(String(url)).toBe('https://api.anthropic.com/v1/messages');
   expect(headers.get('x-api-key')).toBe('explicit-anthropic-key');
   expect(headers.get('authorization')).toBeNull();
  } finally {
   vi.unstubAllEnvs();
  }
 });
 it('ignores OPENAI_ORG_ID, OPENAI_PROJECT_ID, and OPENAI_BASE_URL from process.env', async () => {
  vi.stubEnv('OPENAI_ORG_ID', 'org_leaked');
  vi.stubEnv('OPENAI_PROJECT_ID', 'proj_leaked');
  vi.stubEnv('OPENAI_BASE_URL', 'https://leaked-openai.invalid/v1');
  const fetch = vi.fn(async () => new Response(JSON.stringify({
   id: 'chatcmpl_1',
   choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
  }), { headers: { 'Content-Type': 'application/json' } }));
  vi.stubGlobal('fetch', fetch);
  try {
   const client = createClient({ protocol: 'openai-completions', apiKey: 'explicit-openai-key', model: 'gpt-5.4' });
   await client.chat({ messages: [{ type: 'event', eventType: 'user_message', content: 'hi' }] });
   expect(fetch).toHaveBeenCalledTimes(1);
   for (const [url, init] of fetch.mock.calls) {
    const headers = new Headers((init as RequestInit)?.headers);
    expect(String(url)).toBe('https://api.openai.com/v1/chat/completions');
    expect(headers.get('authorization')).toBe('Bearer explicit-openai-key');
    expect(headers.get('openai-organization')).toBeNull();
    expect(headers.get('openai-project')).toBeNull();
   }
  } finally {
   vi.unstubAllEnvs();
  }
 });
});
