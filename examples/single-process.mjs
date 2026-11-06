import assert from 'node:assert/strict';
import { AgentRuntime, InMemoryConversationStore } from '@nia-teams/agent-core';

// Scripted ILLMClient simulating a 2-step tool call + final streaming answer
let callIndex = 0;
/** @type {import('@nia-teams/agent-core').ILLMClient} */
const client = {
  getProviderName: () => 'openai',
  getModelName: () => 'deepseek-v4-pro',
  async chat(req) {
    callIndex++;
    if (callIndex === 1) {
      return {
        content: null,
        toolCalls: [{ id: 'toolu_1', name: 'get_order', arguments: JSON.stringify({ orderId: '1024' }) }],
        stopReason: 'tool_use',
        usage: { promptTokens: 40, completionTokens: 15 },
      };
    }
    const text = 'Order 1024 is in transit (ETA 2026-11-08).';
    req.onStreamDelta?.({ type: 'text', content: text });
    return {
      content: text,
      stopReason: 'end_turn',
      usage: { promptTokens: 80, completionTokens: 12 },
    };
  },
};

/** @type {import('@nia-teams/agent-core').Tool} */
const getOrderTool = {
  name: 'get_order',
  description: 'Look up shipping status by order ID',
  inputSchema: {
    type: 'object',
    properties: { orderId: { type: 'string' } },
    required: ['orderId'],
  },
  execute: async ({ orderId }) =>
    JSON.stringify({ orderId, status: 'in_transit', eta: '2026-11-08' }),
};

const store = InMemoryConversationStore.fromUserMessage('Where is order 1024?');
const runtime = new AgentRuntime({ store, sessionId: 'session-1' });

let streamed = '';
await runtime.run({
  client,
  systemPrompt: 'You are an order assistant. Check order status before answering.',
  tools: [getOrderTool],
  onEvent: (event) => {
    if (event.type === 'text_delta') {
      streamed += event.delta;
      process.stdout.write(event.delta);
    }
  },
});

assert.equal(streamed, 'Order 1024 is in transit (ETA 2026-11-08).');
assert.equal(store.getMessages().length, 4); // user event + assistant(tool_use) + tool(result) + assistant(final)
console.log('\nsingle-process: PASS');
