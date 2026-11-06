# cloud-agent

[English](./README.md) | 简体中文

面向多副本云端服务的 TypeScript Agent 运行时与多协议模型客户端。

```sh
npm install @nia-teams/agent-core @nia-teams/ai
```

AI 编程助手可加载随包分发的 `SKILL.md`：
- `@nia-teams/agent-core`：`node_modules/@nia-teams/agent-core/skills/agent-core/SKILL.md`（[`packages/agent-core/skills/agent-core/SKILL.md`](./packages/agent-core/skills/agent-core/SKILL.md)）
- `@nia-teams/ai`：`node_modules/@nia-teams/ai/skills/ai/SKILL.md`（[`packages/ai/skills/ai/SKILL.md`](./packages/ai/skills/ai/SKILL.md)）

---

## 解决的问题

将 Agent 部署为多副本服务时，`AgentHost` 处理三类问题：

- **会话互斥**：同一会话同一时刻只在一个副本上执行，其他副本收到的消息进入待处理队列。
- **断线重连**：`openSnapshotStream` 先发送会话快照，再接续实时事件。
- **故障恢复**：收到 `SIGTERM` 时等待在途轮次结束；进程崩溃后，其他副本在租约过期后接管会话，并从检查点恢复 Subagent。

---

## 快速开始

### 1. 单进程运行（`AgentRuntime`）

保存为 `agent.ts` 并使用 `tsx` 运行（[`examples/quickstart-single.ts`](./examples/quickstart-single.ts)）：

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

const store = InMemoryConversationStore.fromUserMessage("帮我查一下订单 1024 到哪了");
const runtime = new AgentRuntime({ store, sessionId: "session-1" });

await runtime.run({
  client,
  systemPrompt: "你是订单助手，先查询订单状态再回复用户。",
  tools: [getOrderTool],
  onEvent: (event) => {
    if (event.type === "text_delta") process.stdout.write(event.delta);
  },
});
```

### 2. HTTP 服务（`AgentHost`）

保存为 `server.ts` 并使用 `tsx` 运行（[`examples/quickstart-http.ts`](./examples/quickstart-http.ts)）：

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
    systemPrompt: "你是云端订单助手。",
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

## 子包

| 包名 | 职责 |
| --- | --- |
| **[@nia-teams/agent-core](./packages/agent-core/README_CN.md)** | 单进程 Agent 循环（`AgentRuntime`）与多副本协调层（`AgentHost`），支持 Steering、快照流、Subagent 与分布式 Cron。依赖 `@nia-teams/ai`。 |
| **[@nia-teams/ai](./packages/ai/README_CN.md)** | 支持 Anthropic Messages、OpenAI Chat Completions、OpenAI Responses、Google Gemini GenerateContent 四套协议的 TypeScript 客户端，包含 `withFallback`、图像生成与 JSON 决策。 |

---

## 使用前须知

- **运行环境**：Node.js >= 20（ESM）。运行 TypeScript 示例需使用 `tsx`（`npx tsx ...`）或先经 `tsc` 编译。
- **存储与发布/订阅适配器**：`@nia-teams/agent-core` 不捆绑数据库、缓存或 Web 框架驱动。`createMemoryDocStore()` 与 `createMemoryPubSub()` 的状态保存在单个 Node.js 进程内存中；多进程或多机部署需接入共享存储与消息通道（如 `@nia-teams/agent-core/docstore-mongo` 与 `@nia-teams/agent-core/pubsub-redis`），否则前文的三类机制无法跨进程生效。
- **无内置模型注册表**：`@nia-teams/ai` 不管理模型别名映射、计费配置表或密钥存储。
- **外部写副作用**：崩溃恢复不回滚工具对外部系统已产生的写操作；包含外部写副作用的工具需由业务层实现幂等键或人工确认。
- **鉴权与多租户隔离**：HTTP 路由鉴权、会话归属校验与限流由业务服务层处理。

---

## 本地开发

```sh
npm ci
npm run build
npm run typecheck
npm test
node examples/single-process.mjs
node examples/multi-replica-http.mjs
```

## 开源协议

MIT
