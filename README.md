# cloud-agent

English | [简体中文](./README_CN.md)

TypeScript agent runtime and multi-protocol LLM clients for multi-replica cloud services.

```sh
npm install @nia-teams/agent-core @nia-teams/ai
```

AI coding assistants can load the bundled package skills:
- `@nia-teams/agent-core`: `node_modules/@nia-teams/agent-core/skills/agent-core/SKILL.md` ([`packages/agent-core/skills/agent-core/SKILL.md`](./packages/agent-core/skills/agent-core/SKILL.md))
- `@nia-teams/ai`: `node_modules/@nia-teams/ai/skills/ai/SKILL.md` ([`packages/ai/skills/ai/SKILL.md`](./packages/ai/skills/ai/SKILL.md))

---

## What It Solves

When an agent runs across multiple service replicas, `AgentHost` handles three problems:

- **Session mutual exclusion**: A session executes on at most one replica at a time; messages arriving at other replicas enter the pending queue.
- **Stream reconnection**: `openSnapshotStream` sends the session snapshot followed by live incremental events.
- **Crash recovery**: `SIGTERM` waits for in-flight turns to finish; after an ungraceful crash, another replica reclaims the session once its lease expires and resumes unfinished subagents from checkpoints.

---

## Quick Start

### 1. Single-Process Agent Loop (`AgentRuntime`)

Save as `agent.ts` and run with `tsx` ([`examples/quickstart-single.ts`](./examples/quickstart-single.ts)):

```sh
DEEPSEEK_API_KEY=sk-... npx tsx agent.ts
```

```ts
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
```

### 2. HTTP Service (`AgentHost`)

Save as `server.ts` and run with `tsx` ([`examples/quickstart-http.ts`](./examples/quickstart-http.ts)):

```sh
DEEPSEEK_API_KEY=sk-... npx tsx server.ts
```

```ts
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
```

---

## Packages

| Package | Responsibility |
| --- | --- |
| **[@nia-teams/agent-core](./packages/agent-core/README.md)** | Single-process agent turn loop (`AgentRuntime`) and multi-replica session coordinator (`AgentHost`) with steering, snapshot streams, subagents, and distributed cron. Depends on `@nia-teams/ai`. |
| **[@nia-teams/ai](./packages/ai/README.md)** | TypeScript clients for Anthropic Messages, OpenAI Chat Completions, OpenAI Responses, and Google Gemini GenerateContent, plus `withFallback`, image generation, and JSON decisions. |

---

## Before You Start

- **Runtime environment**: Node.js >= 20 (ESM). Running TypeScript examples requires `tsx` (`npx tsx ...`) or a prior `tsc` build step.
- **Storage & pub/sub adapters**: `@nia-teams/agent-core` bundles no database, cache, or HTTP framework drivers. `createMemoryDocStore()` and `createMemoryPubSub()` keep state inside a single Node.js process; multi-process or multi-host deployments must use shared adapters (such as `@nia-teams/agent-core/docstore-mongo` and `@nia-teams/agent-core/pubsub-redis`), or the three multi-replica mechanisms above will not apply across processes.
- **No model registry**: `@nia-teams/ai` does not manage model alias tables, billing configurations, or stored credentials.
- **External side effects**: Crash recovery does not roll back external writes already performed by tools; tools that mutate external state require idempotency keys or human confirmation.
- **Authentication & isolation**: HTTP authentication, session ownership checks, and rate limiting belong in your server layer.

---

## Development

```sh
npm ci
npm run build
npm run typecheck
npm test
node examples/single-process.mjs
node examples/multi-replica-http.mjs
```

## License

MIT
