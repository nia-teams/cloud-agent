import { createServer } from "node:http";
import {
  createAgentHost,
  createMemoryDocStore,
  createMemoryPubSub,
} from "@nia-teams/agent-core/host";
import { createClient } from "@nia-teams/ai";

const client = createClient({
  protocol: "openai-completions",
  baseURL: "https://api.deepseek.com",
  model: "deepseek-v4-pro",
  apiKey: process.env.DEEPSEEK_API_KEY!,
});

const docStore = createMemoryDocStore();
const pubSub = createMemoryPubSub();

const host = createAgentHost({
  docStore,
  pubSub,
  resolveAgentConfig: async (_sessionId) => ({
    client,
    systemPrompt: "You are a helpful cloud assistant.",
    tools: [],
  }),
});

await host.start();

createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const match = url.pathname.match(/^\/sessions\/([^/]+)\/(messages|stream)$/);
  if (!match) return res.writeHead(404).end();
  const [, sessionId, action] = match;

  if (req.method === "POST" && action === "messages") {
    let body = "";
    for await (const chunk of req) body += chunk;
    const { content } = JSON.parse(body);
    const result = await host.injectMessage({
      sessionId,
      eventType: "user_message",
      content,
      userId: "user-1",
      userName: "Alice",
    });
    res.writeHead(202, { "Content-Type": "application/json" });
    res.end(JSON.stringify(result));
    return;
  }

  if (req.method === "GET" && action === "stream") {
    await host.openSnapshotStream(res, { sessionId, format: "sse" });
    return;
  }

  res.writeHead(405).end();
}).listen(3000);
