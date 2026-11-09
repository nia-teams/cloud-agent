import { afterEach, expect, it, vi } from 'vitest';
import type { AgentMessage } from '@nia-teams/ai/protocol';
import { AnthropicClient } from '../clients/anthropic.js';
import { OpenAIClient } from '../clients/openai.js';
import { ResponsesClient } from '../clients/responses.js';
import { GeminiClient } from '../clients/gemini.js';
const timestamp = new Date(0);
const signature = 'opaque-signature-'.repeat(10);
const detail = { type: 'reasoning.encrypted', data: 'signed', id: 'r1', format: 'google-gemini-v1', unknown: { retained: true } };
function history(model: string): AgentMessage[] {
    return [
        { type: 'event', eventType: 'message', content: 'look', timestamp, attachments: [{ type: 'image', mediaType: 'image/png', data: 'aW1n' }] },
        { type: 'assistant', content: 'checking', timestamp, model, reasoning: 'private plan', reasoningSignature: signature, reasoningDetails: [detail], toolCalls: [{ id: 'call_1', name: 'lookup', arguments: '{"key":"x"}' }] },
        { type: 'tool', toolCallId: 'call_1', content: '{"found":true}', timestamp },
        { type: 'system_injection', content: 'Keep going', timestamp },
        { type: 'event', eventType: 'message', content: 'finish', timestamp },
    ];
}
function capture(response: unknown, sse = false) {
    const bodies: any[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
        bodies.push(JSON.parse(init.body));
        return new Response(sse ? `data: ${JSON.stringify(response)}\n\n` : JSON.stringify(response), { headers: { 'Content-Type': sse ? 'text/event-stream' : 'application/json' } });
    }));
    return bodies;
}
afterEach(() => vi.unstubAllGlobals());
it('Anthropic ingress replays canonical events, signed reasoning, tools, documents and native injections', async () => {
    const bodies = capture({ id: 'msg_1', type: 'message', role: 'assistant', content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: { input_tokens: 11, output_tokens: 2, cache_read_input_tokens: 13, cache_creation_input_tokens: 17 } });
    const messages = history('claude-test');
    (messages[0] as any).attachments.push({ type: 'document', mediaType: 'application/pdf', data: 'cGRm' });
    messages[3] = { type: 'system_injection', content: '', blocks: [{ type: 'tool_addition', toolName: 'lookup' }], timestamp };
    const before = structuredClone(messages);
    const client = new AnthropicClient({ apiKey: 'test', baseURL: 'https://fake.invalid', model: 'claude-test', supportsMidConversationTools: true });
    const result = await client.chat({ messages });
    expect(messages).toEqual(before);
    expect(result.usage).toMatchObject({ promptTokens: 11, contextTokens: 41, cachedTokens: 13, cacheCreationTokens: 17 });
    expect(bodies[0].messages[0].content).toEqual(expect.arrayContaining([
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aW1n' } },
        { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: 'cGRm' } },
    ]));
    expect(bodies[0].messages[1].content).toEqual(expect.arrayContaining([
        { type: 'thinking', thinking: 'private plan', signature },
        { type: 'tool_use', id: 'call_1', name: 'lookup', input: { key: 'x' } },
    ]));
    expect(bodies[0].messages[2].content[0]).toMatchObject({ type: 'tool_result', tool_use_id: 'call_1', content: '{"found":true}' });
    expect(bodies[0].messages[3]).toEqual({ role: 'system', content: [{ type: 'tool_addition', tool: { type: 'tool_reference', name: 'lookup' } }] });
    expect(new Headers(vi.mocked(fetch).mock.calls[0][1]!.headers).get('anthropic-beta')).toBe('mid-conversation-tool-changes-2026-07-01');
});
it.each(['deepseek-test', 'google/gemini-4-argon', 'anthropic/claude-test'])('OpenAI-compatible ingress uses its wire protocol for model family %s', async (model) => {
    const bodies = capture({ id: 'c1', choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] });
    const messages = history(model), before = structuredClone(messages);
    await new OpenAIClient({ apiKey: 'test', baseURL: 'https://openrouter.invalid/v1', model, reasoningFormat: 'reasoning_object' }).chat({ messages });
    expect(messages).toEqual(before);
    expect(bodies[0].messages[0]).toEqual({ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,aW1n' } }, { type: 'text', text: 'look' }] });
    expect(bodies[0].messages[1]).toMatchObject({ role: 'assistant', reasoning_content: 'private plan', reasoning_details: [detail], tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'lookup', arguments: '{"key":"x"}' } }] });
    expect(bodies[0].messages[2]).toEqual({ role: 'tool', tool_call_id: 'call_1', content: '{"found":true}' });
    expect(bodies[0].messages[3].content).toBe('<system-reminder>\nKeep going\n</system-reminder>\n\nfinish');
});
it('Responses ingress replays signed output items, canonical tools and images', async () => {
    const bodies = capture({ id: 'resp_1', status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] }] });
    const messages = history('gpt-test');
    const reasoning = { type: 'reasoning', id: 'rs_1', encrypted_content: 'opaque', summary: [] };
    (messages[1] as any).reasoningDetails = [reasoning];
    const before = structuredClone(messages);
    await new ResponsesClient({ apiKey: 'test', baseURL: 'https://fake.invalid/v1', model: 'gpt-test' }).chat({ messages });
    expect(messages).toEqual(before);
    expect(bodies[0].input[0]).toMatchObject({ role: 'user', content: expect.arrayContaining([{ type: 'input_image', image_url: 'data:image/png;base64,aW1n' }, { type: 'input_text', text: 'look' }]) });
    expect(bodies[0].input).toContainEqual(reasoning);
    expect(bodies[0].input).toContainEqual(expect.objectContaining({ type: 'function_call', call_id: 'call_1', name: 'lookup', arguments: '{"key":"x"}' }));
    expect(bodies[0].input).toContainEqual({ type: 'function_call_output', call_id: 'call_1', output: '{"found":true}' });
    expect(bodies[0].input.at(-1).content).toContain('<system-reminder>');
});
it('Gemini ingress replays canonical media, signed function calls, results and reminders', async () => {
    const bodies = capture({ candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }] });
    const messages = history('gemini-test'), before = structuredClone(messages);
    await new GeminiClient({ apiKey: 'test', baseURL: 'https://fake.invalid', model: 'gemini-test' }).chat({ messages });
    expect(messages).toEqual(before);
    expect(bodies[0].contents[0]).toEqual({ role: 'user', parts: [{ inlineData: { mimeType: 'image/png', data: 'aW1n' } }, { text: 'look' }] });
    expect(bodies[0].contents[1]).toEqual({ role: 'model', parts: [{ text: 'checking' }, { functionCall: { name: 'lookup', args: { key: 'x' } }, thoughtSignature: signature }] });
    expect(bodies[0].contents[2].parts).toContainEqual({ functionResponse: { name: 'lookup', response: { found: true } } });
    expect(bodies[0].contents[2].parts).toContainEqual({ text: '<system-reminder>\nKeep going\n</system-reminder>\n\nfinish' });
});
