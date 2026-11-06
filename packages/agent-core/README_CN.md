# @nia-teams/agent-core

[English](./README.md) | 简体中文 · [返回仓库主页](../../README_CN.md)

单进程 Agent 循环（`AgentRuntime`）与多副本协调层（`AgentHost`），支持 Steering、快照流、Subagent 与分布式 Cron。基于 [`@nia-teams/ai`](../ai/README_CN.md) 构建，也可接入任意 `ILLMClient` 实现。

```sh
npm install @nia-teams/agent-core
```

AI 编程助手可加载 `node_modules/@nia-teams/agent-core/skills/agent-core/SKILL.md`（[`skills/agent-core/SKILL.md`](./skills/agent-core/SKILL.md)）。

---

## 目录

- [快速开始](#快速开始)
  - [1. 单进程循环（`AgentRuntime`）](#1-单进程循环agentruntime)
  - [2. 多副本服务（`AgentHost`）](#2-多副本服务agenthost)
- [核心概念](#核心概念)
  - [`AgentRuntime` 与 `AgentHost`](#agentruntime-与-agenthost)
  - [消息结构（`AgentMessage`）](#消息结构agentmessage)
  - [单轮数据流](#单轮数据流)
- [事件流](#事件流)
  - [`run()` 事件序列](#run-事件序列)
  - [事件类型（`StreamEvent`）](#事件类型streamevent)
- [工具与并发执行](#工具与并发执行)
  - [定义工具与自定义事件](#定义工具与自定义事件)
  - [并发执行顺序](#并发执行顺序)
  - [动态激活工具](#动态激活工具)
- [Steering 与会话唤醒](#steering-与会话唤醒)
- [生命周期钩子与 `RuntimeState`](#生命周期钩子与-runtimestate)
- [内置插件](#内置插件)
- [Subagent](#subagent)
- [分布式 Cron](#分布式-cron)
- [故障恢复与超时配置](#故障恢复与超时配置)
- [子路径导出表](#子路径导出表)

---

## 快速开始

### 1. 单进程循环（`AgentRuntime`）

保存为 `agent.ts` 并使用 `tsx` 运行：

```sh
DEEPSEEK_API_KEY=sk-... npx tsx agent.ts
```

```ts
import {
  AgentRuntime,
  InMemoryConversationStore,
  type Tool,
} from "@nia-teams/agent-core";
import { createDefaultBuiltinPlugins } from "@nia-teams/agent-core/builtins";
import { createClient } from "@nia-teams/ai";

const client = createClient({
  protocol: "openai-completions",
  baseURL: "https://api.deepseek.com",
  model: "deepseek-v4-pro",
  apiKey: process.env.DEEPSEEK_API_KEY!,
});

const readPackageVersion: Tool = {
  name: "read_package_version",
  description: "Read the version field from package.json",
  inputSchema: { type: "object", properties: {} },
  execute: async () => {
    const fs = await import("node:fs/promises");
    const pkg = JSON.parse(await fs.readFile("package.json", "utf8"));
    return String(pkg.version ?? "0.0.0");
  },
};

const store = InMemoryConversationStore.fromUserMessage("读取当前 package.json 的版本号");
const runtime = new AgentRuntime({
  store,
  sessionId: "session-1",
  plugins: createDefaultBuiltinPlugins({ contextPruning: true, guardrail: "main" }),
});

await runtime.run({
  client,
  systemPrompt: "你是工程助手。",
  contextWindow: 1_000_000,
  tools: [readPackageVersion],
  onEvent: (event) => {
    if (event.type === "text_delta") process.stdout.write(event.delta);
  },
});
```

### 2. 多副本服务（`AgentHost`）

多进程或多机部署使用 `@nia-teams/agent-core/docstore-mongo` 与 `@nia-teams/agent-core/pubsub-redis`（单进程调试可使用 `createMemoryDocStore()` 与 `createMemoryPubSub()`）。保存为 `server.ts` 并使用 `tsx` 运行：

```sh
MONGODB_URI=mongodb://127.0.0.1:27017 REDIS_URL=redis://127.0.0.1:6379 DEEPSEEK_API_KEY=sk-... npx tsx server.ts
```

```ts
import { createServer } from "node:http";
import { MongoClient } from "mongodb";
import { Redis } from "ioredis";
import { createAgentHost } from "@nia-teams/agent-core/host";
import { createMongoDocStore } from "@nia-teams/agent-core/docstore-mongo";
import { createRedisPubSub } from "@nia-teams/agent-core/pubsub-redis";
import { createClient } from "@nia-teams/ai";

const mongo = await new MongoClient(process.env.MONGODB_URI!).connect();
const db = mongo.db("my_app");
const redis = new Redis(process.env.REDIS_URL!);

const client = createClient({
  protocol: "openai-completions",
  baseURL: "https://api.deepseek.com",
  model: "deepseek-v4-pro",
  apiKey: process.env.DEEPSEEK_API_KEY!,
});

const host = createAgentHost({
  docStore: createMongoDocStore({ db }),
  pubSub: createRedisPubSub({ redis }),
  logger: console,
  resolveAgentConfig: async (_sessionId) => ({
    client,
    systemPrompt: "你是云端助手。",
    contextWindow: 200_000,
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
    const out = await host.injectMessage({
      sessionId,
      eventType: "user_message",
      content,
      userId: "u_1",
      userName: "Alice",
    });
    res.writeHead(202, { "Content-Type": "application/json" });
    res.end(JSON.stringify(out));
    return;
  }

  if (req.method === "GET" && action === "stream") {
    await host.openSnapshotStream(res, { sessionId, format: "sse" });
    return;
  }

  res.writeHead(405).end();
}).listen(3000);

process.on("SIGTERM", async () => {
  await host.stop();
  redis.disconnect();
  await mongo.close();
});
```

---

## 核心概念

### `AgentRuntime` 与 `AgentHost`

- **`AgentRuntime`（`@nia-teams/agent-core`）**：单进程内执行单个轮次的状态机，通过 `ConversationStore`（`loadAll`、`fetchNew`、`hasNew`、`persist`）读写消息。
- **`AgentHost`（`@nia-teams/agent-core/host`）**：多副本协调层，管理 `sessions`、`events`、`subagent_runs` 集合，处理 `activeRun` 租约与续期、`pendingInputs` 队列、发布/订阅广播、自愈扫描，并在每轮开始前调用 `resolveAgentConfig(sessionId)`。

### 消息结构（`AgentMessage`）

- **`EventMessage`（`type: "event"`）**：用户消息（`eventType: "user_message"`）或外部事件，可选包含多模态 `attachments`（`image` | `document`）与仅对模型可见的 `context`（`AiPostContext[]`）。
- **`AssistantMessage`（`type: "assistant"`）**：模型输出，包含 `content`、`toolCalls`、`reasoning`、`reasoningSignature`、`reasoningDetails`、`stopReason` 与可选 `usedFallbackModel`。
- **`ToolMessage`（`type: "tool"`）**：按 `toolCallId` 关联的工具返回结果，包含 `content`、`isError` 与可选 `guidance`。
- **`SystemInjectionMessage`（`type: "system_injection"`）**：运行中系统注入（`kind: "reminder" | "tool_activation" | "guardrail" | "state_change"`），置于 `event` 或 `tool` 消息之后（可用 `validateSystemInjectionPlacement` 校验）。

### 单轮数据流

```text
prefetchHook?(sessionId)
  → store.loadAll()
  → beforeTurn(state)
  ┌─► store.fetchNew() → afterFetch(state) → [若 state.pending 非空则先落盘]
  │     → plugins.transformContext()
  │     → formatMessagesForLLM()
  │     → client.chat()
  │     → afterLLM(state)
  │     → [无 toolCalls] ──► store.persist() → afterPersist / afterAssistantPersist ──┐
  │     → [有 toolCalls] ──► beforeExecTools(state)                                   │
  │                            → plugins.beforeToolCall()                             │
  │                            → Tool.execute() (第 1 阶段 parallel+serial，第 2 阶段 deferred)
  │                            → afterExecTools(state)                                │
  │                            → plugins.afterToolCall / afterToolBatch               │
  │                            → store.hasNew() 检查与落盘                            │
  │                            → afterPersist / afterAssistantPersist ────────────────┴─► 继续循环或退出
  └───────────────────────────────────────────────────────────────────────────────────────┘
  → usage?.record(entry)
  → afterTurn(state)
```

---

## 事件流

### `run()` 事件序列

纯文本回复轮次：

```text
run()
├─ turn_start          { sessionId, turnId, timestamp }
├─ thinking_start
├─ thinking_delta      { delta }
├─ thinking_end
├─ text_delta          { delta }
├─ usage_update        { inputTokens }
└─ turn_end            { inputTokens, model }
```

含工具调用与 Steering 的轮次：

```text
run()
├─ turn_start
├─ text_delta...
├─ tool_input_start    { toolCallId, name }
├─ tool_input_delta    { toolCallId, partial_json }
├─ tool_call_start     { toolCallId, name, input }
├─ tool_call_end       { toolCallId, output, error, durationMs }
├─ usage_update        { inputTokens }
├─ interleave_start    { messageIds }
├─ thinking_start / thinking_delta / thinking_end
├─ text_delta...
├─ usage_update        { inputTokens }
└─ turn_end            { inputTokens, model }
```

### 事件类型（`StreamEvent`）

| `event.type` | 作用域 | 说明 |
| --- | --- | --- |
| `snapshot` | 连接首帧 | `StreamSnapshot`，携带 `session` 文档及可选 `extras` |
| `turn_start` | 轮次 | 轮次开始（Subagent 预览事件含 `subagentToolCallId`） |
| `thinking_start` / `thinking_delta` / `thinking_end` | 轮次 | 思考链流式事件 |
| `text_delta` | 轮次 | 助手正文增量（`event.delta: string`） |
| `tool_input_start` / `tool_input_delta` | 轮次 | 工具名称声明与参数 JSON 增量 |
| `tool_call_start` / `tool_call_end` | 轮次 | 工具执行开始（`input`）与结束（`output`、`error`、`durationMs`） |
| `usage_update` | 轮次 | 单次模型调用后的上下文 Token 数（`inputTokens`） |
| `turn_end` | 轮次 | 轮次结束（`inputTokens`、`model`） |
| `interleave_start` | 轮次 | 待处理队列中的用户消息（`messageIds`）并入当前轮次 |
| `error` | 轮次 | 轮次错误（`code`、`message`、`detail`） |
| `custom` | 轮次 / 工具 | 工具通过 `ctx.onEvent` 发送的自定义事件（`name: string`、`data?: unknown`） |
| `user_message` / `messages_consumed` / `message_revoked` | 会话 | 待处理队列状态变更 |
| `session_update` | 会话 | 会话标题、`running` 状态或 `lastError` 变更 |

`host.openSnapshotStream(res, { sessionId, format?: "ndjson" | "sse", buildSnapshot? })` 先输出 `snapshot` 首帧，再按事件序号接续实时事件流（首帧后 `300ms` 发送首次刷新帧，之后每 `15s` 发送保活心跳）。

---

## 工具与并发执行

### 定义工具与自定义事件

```ts
import type { Tool } from "@nia-teams/agent-core";

async function triggerPreviewBuild(branch: string, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  return `https://preview.example.com/${encodeURIComponent(branch)}`;
}

const deployTool: Tool = {
  name: "deploy_preview",
  description: "Deploy a preview build",
  concurrency: "serial", // "parallel"（默认）| "serial" | "deferred"
  inputSchema: {
    type: "object",
    properties: { branch: { type: "string" } },
    required: ["branch"],
  },
  execute: async (input, ctx) => {
    ctx.onEvent({
      type: "custom",
      name: "deploy_progress",
      data: { branch: input.branch, stage: "building" },
    });
    const url = await triggerPreviewBuild(String(input.branch), ctx.signal);
    return {
      content: `Preview live at ${url}`,
      guidance: ["向用户告知预览链接。"],
    };
  },
};
```

### 并发执行顺序

模型单次响应调用多个工具时，结果按模型声明顺序落盘，执行分为两阶段：
1. **第一阶段（`parallel` + `serial`）**：`"parallel"` 工具并发执行；`"serial"` 工具按声明顺序依次执行。
2. **第二阶段（`deferred`）**：第一阶段完成后执行（内置 `subagent` 工具为 `"deferred"`）。

### 动态激活工具

将工具设为 `deferLoading: true`（或初始不放入 `tools`），在工具内调用 `ctx.activateTools?.(names)`，并通过 `resolveToolDefinitions: async (names) => Tool[]` 在下一轮模型调用前挂载。

---

## Steering 与会话唤醒

工具运行期间有新消息到达时，`AgentRuntime` 在工具批次结束后先用占位 `ToolMessage`（默认 `[Tool running...]`，可通过 `interleavePlaceholder` 配置）闭合上一条 `tool_use`，再依次写入用户新消息与工具输出（`[Tool Result]` `event` 消息），随后进入下一轮推理。

`AgentHost` 会话操作方法：
- **`host.injectMessage(opts)`**：写入 `sessions.pendingInputs`（会话不存在时创建）并发送唤醒通知。空闲会话立即获取租约执行；运行中会话在下一工具批次边界并入新消息并发出 `interleave_start`。
- **`host.wakeUp(sessionId)`**：写入 `runtimeWakeRequestedAt` 唤醒会话而不追加用户消息。
- **`isSessionSettled(sessionDoc)`**：判断会话文档当前是否既无活跃租约也无待处理输入。

---

## 生命周期钩子与 `RuntimeState`

`AgentHooks` 提供 8 个生命周期钩子（另可通过 `AgentRuntimeConfig.prefetchHook(sessionId)` 配置预热回调）：

```ts
import type { AgentHooks } from "@nia-teams/agent-core";

const hooks: AgentHooks = {
  beforeTurn: async (state) => {
    state.metadata.startedAt = Date.now();
  },
  afterFetch: async (state) => {
    if (state.newMessages.every((m) => m.type === "event" && m.eventType === "silent_sync")) {
      state.exit = { kind: "skip" };
    }
  },
  afterLLM: async (state) => {},
  beforeExecTools: async (state) => {},
  afterExecTools: async (state) => {},
  afterPersist: async (state) => {},
  afterAssistantPersist: async (state, assistantMessage) => {},
  afterTurn: async (state) => {},
};
```

---

## 内置插件

`AgentHost` 默认启用 `context-pruning` 与 `guardrail`；单独使用 `AgentRuntime` 时可通过 `createDefaultBuiltinPlugins` 创建：

```ts
import { createDefaultBuiltinPlugins } from "@nia-teams/agent-core/builtins";

const myLargeResultStore = {
  async write(_toolName: string, content: string) {
    return { uri: `data:text/plain,${encodeURIComponent(content)}` };
  },
};

const plugins = createDefaultBuiltinPlugins({
  contextPruning: true,
  guardrail: "main", // "main" | "subagent" | false
  largeToolResult: {
    store: myLargeResultStore,
    thresholdChars: 30_000, // MAX_PREVIEW_CHARS = 500,000
  },
});
```

- **`context-pruning`**：上下文接近 `contextWindow` 时保留近期轮次，裁剪早期轮次的大体积工具输出与思考块（5 分钟缓存 TTL 感知）。
- **`guardrail`**：检测连续重复参数调用或连续工具报错，先注入提示，超过阈值则中止循环。
- **`large-tool-result`**：将超长工具输出写入 `LargeToolResultStore`，上下文中保留首尾摘要与资源 URI。
- **`pending-hidden`**：在发往模型前过滤内部状态事件。

---

## Subagent

在 `AgentConfig` 中传入 `subagentProfiles: SubagentProfile[]`（单进程模式传入 `run({ subagent: { profiles, store } })`），`AgentRuntime` 会挂载内置 `subagent` 工具（不向子级 Subagent 递归暴露）：

```ts
import type { SubagentProfile, Tool } from "@nia-teams/agent-core";
import { createClient } from "@nia-teams/ai";

const fastClient = createClient({
  protocol: "openai-completions",
  baseURL: "https://api.deepseek.com",
  model: "deepseek-flash",
  apiKey: process.env.DEEPSEEK_API_KEY!,
});

const repositoryTools: Tool[] = [];

const subagentProfiles: SubagentProfile[] = [
  {
    name: "codebase",
    description: "Fast read-only repository search and review",
    rolePrompt: "检索代码并返回带 file:line 的结论。",
    tools: repositoryTools,
    client: fastClient,
    contextWindow: 200_000,
  },
];
```

`AgentHost` 将 Subagent 历史保存在 `subagent_runs` 集合中，支持通过 `resume: "<toolCallId>"` 继续追问，向父会话转发带 `subagentToolCallId` 的预览事件，并在进程重启后从检查点恢复未完成的运行。

---

## 分布式 Cron

`@nia-teams/agent-core/cron`（以及 `host.startCron` / `host.startScheduledTask`）提供多副本定时任务调度：

```ts
import { createFlatScheduleStore, type ScheduleSpec } from "@nia-teams/agent-core/cron";
import type { AgentHost } from "@nia-teams/agent-core/host";
import { MongoClient } from "mongodb";

interface JobDoc {
  _id: string;
  schedule: ScheduleSpec;
  nextRun: Date | null;
  enabled: boolean;
  sessionId: string;
  prompt: string;
}

export async function registerCron(host: AgentHost, mongoUri: string) {
  const mongo = await new MongoClient(mongoUri).connect();
  const db = mongo.db("my_app");

  const scheduleStore = createFlatScheduleStore<JobDoc, { sessionId: string; prompt: string }>({
    collection: db.collection<JobDoc>("schedules"),
    toSpec: (doc) => doc.schedule,
    payloadFn: (doc) => ({ sessionId: doc.sessionId, prompt: doc.prompt }),
  });

  return host.startCron({
    scheduleStore,
    intervalMs: 20_000,
    onFire: async (job) => {
      await host.injectMessage({
        sessionId: job.payload.sessionId,
        eventType: "cron_trigger",
        content: job.payload.prompt,
        userId: "system",
        userName: "Cron",
      });
    },
  });
}
```

---

## 故障恢复与超时配置

- **数据库索引**：`host.start()` 不执行数据库 DDL；部署迁移脚本需读取 `@nia-teams/agent-core/host` 导出的 `REQUIRED_INDEXES` 创建索引。
- **崩溃接管**：租约过期后，自愈扫描器接管会话，为未闭合的 `tool_use` 补齐 `tool_result` 消息，从检查点恢复未完成的 Subagent，再继续消费待处理队列。
- **默认时间参数**（均可在 `AgentHostConfig` 中覆盖）：
  - 会话租约有效期：`60s`（`lockTtlMs`），每 `20s`（`lockRenewMs`）续期，写库带 `holder` 条件（CAS）。
  - 卡死检测：获锁后 `90s` 内无首事件（`preTurnStallMs`）或轮内静默超过 `25min`（`inTurnStallMs`）时停止续期；租约过期后由后台自愈扫描器（默认 `scanIntervalMs = 60s`）接管。
  - 单次模型调用超时：总时长 `20min`（`llmCallTimeoutMs`），流式空闲超时 `5min`（`llmIdleTimeoutMs`，收到非空增量时重置）。
  - 停机等待超时：`290s`（`drainTimeoutMs`）。

---

## 子路径导出表

| 子路径 | 导出内容 |
| --- | --- |
| `@nia-teams/agent-core` | `AgentRuntime`、`InMemoryConversationStore`、`Tool`、`AgentEvent`、`AgentHooks`、`RuntimePlugin`、`validateSystemInjectionPlacement` |
| `@nia-teams/agent-core/host` | `createAgentHost`、`AgentHost`、`REQUIRED_INDEXES`、`isSessionSettled`、`createMemoryDocStore`、`createMemoryPubSub`、定时任务入口 |
| `@nia-teams/agent-core/memory` | `MemoryDocStore`、`MemoryPubSub`、`createMemoryDocStore`、`createMemoryPubSub` |
| `@nia-teams/agent-core/docstore-mongo` | `createMongoDocStore({ db })` |
| `@nia-teams/agent-core/pubsub-redis` | `createRedisPubSub({ redis, keyPrefix? })` |
| `@nia-teams/agent-core/snapshot-stream` | `createSnapshotStream`、`HEARTBEAT_FIRST_MS`（`300`）、`HEARTBEAT_STEADY_MS`（`15_000`） |
| `@nia-teams/agent-core/builtins` | `createDefaultBuiltinPlugins` 及 `context-pruning`、`guardrail`、`large-tool-result`、`pending-hidden` |
| `@nia-teams/agent-core/cron` | `startCron`、`startScheduledTask`、`calcNextRun`、`createFlatScheduleStore`、`createNestedScheduleStore` |
| `@nia-teams/agent-core/protocol` | `StreamEvent`、`StreamSnapshot`、`CustomAgentEvent` 及事件类型 |
| `@nia-teams/agent-core/llm-protocol` | 重导出 `@nia-teams/ai/protocol` 契约 |
| `@nia-teams/agent-core/event-builders` | 流事件构造函数 |

## 开源协议

MIT
