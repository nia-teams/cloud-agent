import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpenAIClient } from '../clients/openai.js';
import { ResponsesClient } from '../clients/responses.js';
import { AnthropicClient } from '../clients/anthropic.js';
import { GeminiClient } from '../clients/gemini.js';
import type { LLMChatRequest } from '../protocol/index.js';

const tools = [{ name: 'echo', description: 'Echo text', inputSchema: { type: 'object' as const, properties: {} } }];
const messages: LLMChatRequest['messages'] = [{ type: 'event', eventType: 'user_message', content: 'Summarize', timestamp: new Date() }];
afterEach(() => vi.unstubAllGlobals());

describe('text-only tool choice', () => {
  for (const provider of ['openai', 'responses', 'anthropic', 'gemini'] as const) {
    it.each([undefined, 'auto', 'none'] as const)(`${provider} preserves definitions with toolChoice=%s`, async (toolChoice) => {
      let body: any;
      const capture = (params: any) => {
        body = JSON.parse(JSON.stringify(params));
        return Promise.resolve({ content: [{ type: 'text', text: 'OK' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } });
      };
      vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
        body = JSON.parse(init.body);
        const response = provider === 'responses'
          ? { status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'OK' }] }] }
          : provider === 'gemini'
            ? { candidates: [{ content: { parts: [{ text: 'OK' }] }, finishReason: 'STOP' }] }
            : { choices: [{ message: { content: 'OK' }, finish_reason: 'stop' }] };
        return new Response(JSON.stringify(response), { headers: { 'Content-Type': 'application/json' } });
      }));
      const opts = { apiKey: 'test', baseURL: 'https://provider.test', model: 'test-model' };
      const client = provider === 'openai' ? new OpenAIClient({ ...opts, providerName: 'openai' })
        : provider === 'responses' ? new ResponsesClient(opts)
        : provider === 'gemini' ? new GeminiClient(opts)
        : new AnthropicClient(opts);
      if (provider === 'anthropic') (client as any).client = { messages: { create: capture } };
      await client.chat({ messages, tools, toolChoice });
      expect(body.tools).toHaveLength(1);
      const definition = provider === 'gemini' ? body.tools[0].functionDeclarations[0]
        : provider === 'openai' ? body.tools[0].function : body.tools[0];
      expect(definition.name).toBe('echo');
      if (provider === 'anthropic') expect(body.tool_choice).toEqual(toolChoice === 'none' ? { type: 'none' } : undefined);
      else if (provider === 'gemini') expect(body.toolConfig).toEqual(toolChoice === 'none' ? { functionCallingConfig: { mode: 'NONE' } } : undefined);
      else expect(body.tool_choice).toBe(toolChoice === 'none' ? 'none' : 'auto');
    });
  }
});
