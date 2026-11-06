import { AgentRuntime, InMemoryConversationStore, type Tool } from "@nia-teams/agent-core";
import { createClient } from "@nia-teams/ai";

const client = createClient({
  protocol: "openai-completions",
  baseURL: "https://api.deepseek.com",
  model: "deepseek-v4-pro",
  apiKey: process.env.DEEPSEEK_API_KEY!,
});

const getOrderTool: Tool = {
  name: "get_order",
  description: "Look up shipping status by order ID",
  inputSchema: {
    type: "object",
    properties: { orderId: { type: "string" } },
    required: ["orderId"],
  },
  execute: async ({ orderId }) =>
    JSON.stringify({ orderId, status: "in_transit", eta: "2026-11-08" }),
};

const store = InMemoryConversationStore.fromUserMessage("Where is order 1024?");
const runtime = new AgentRuntime({ store, sessionId: "session-1" });

await runtime.run({
  client,
  systemPrompt: "You are an order assistant. Check order status before answering.",
  tools: [getOrderTool],
  onEvent: (event) => {
    if (event.type === "text_delta") process.stdout.write(event.delta);
  },
});
