# @nia-teams/agent-core

English | [简体中文](./README_CN.md) · [Back to Repository Root](../../README.md)

Single-process agent turn loop (`AgentRuntime`) and multi-replica session coordinator (`AgentHost`) with steering, snapshot streams, subagents, and distributed cron. Built on [`@nia-teams/ai`](../ai/README.md), or pair with any `ILLMClient` implementation.

```sh
npm install @nia-teams/agent-core
```

AI coding assistants can load `node_modules/@nia-teams/agent-core/skills/agent-core/SKILL.md` ([`skills/agent-core/SKILL.md`](./skills/agent-core/SKILL.md)).

---

## Contents

- [Quick Start](#quick-start)
  - [1. Single-Process Loop (`AgentRuntime`)](#1-single-process-loop-agentruntime)
  - [2. Multi-Replica Service (`AgentHost`)](#2-multi-replica-service-agenthost)
- [Core Concepts](#core-concepts)
  - [`AgentRuntime` vs `AgentHost`](#agentruntime-vs-agenthost)
  - [Messages (`AgentMessage`)](#messages-agentmessage)
  - [Single-Turn Data Flow](#single-turn-data-flow)
- [Event Flow](#event-flow)
  - [`run()` Event Sequence](#run-event-sequence)
  - [Event Types (`StreamEvent`)](#event-types-streamevent)
- [Tools & Concurrency](#tools--concurrency)
  - [Defining Tools & Custom Events](#defining-tools--custom-events)
  - [Concurrency Order](#concurrency-order)
  - [Dynamic Tool Activation](#dynamic-tool-activation)
- [Steering & Session Wakeup](#steering--session-wakeup)
- [Lifecycle Hooks & `RuntimeState`](#lifecycle-hooks--runtimestate)
- [Built-in Plugins](#built-in-plugins)
- [Subagents](#subagents)
- [Distributed Cron](#distributed-cron)
- [Crash Recovery & Timeouts](#crash-recovery--timeouts)
- [Subpath Exports](#subpath-exports)

---

## Quick Start

### 1. Single-Process Loop (`AgentRuntime`)

Save as `agent.ts` and run with `tsx`:

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

const store = InMemoryConversationStore.fromUserMessage("What version is in package.json?");
const runtime = new AgentRuntime({
  store,
  sessionId: "session-1",
  plugins: createDefaultBuiltinPlugins({ contextPruning: true, guardrail: "main" }),
});

await runtime.run({
  client,
  systemPrompt: "You are an engineering assistant.",
  contextWindow: 1_000_000,
  tools: [readPackageVersion],
  onEvent: (event) => {
    if (event.type === "text_delta") process.stdout.write(event.delta);
  },
});
```

### 2. Multi-Replica Service (`AgentHost`)

Multi-process or multi-host deployments use `@nia-teams/agent-core/docstore-mongo` and `@nia-teams/agent-core/pubsub-redis` (single-process debugging can use `createMemoryDocStore()` and `createMemoryPubSub()`). Save as `server.ts` and run with `tsx`:

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
    systemPrompt: "You are a cloud assistant.",
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

## Core Concepts

### `AgentRuntime` vs `AgentHost`

- **`AgentRuntime` (`@nia-teams/agent-core`)**: Single-turn state machine operating on a four-method `ConversationStore` (`loadAll`, `fetchNew`, `hasNew`, `persist`).
- **`AgentHost` (`@nia-teams/agent-core/host`)**: Multi-replica coordinator managing `sessions`, `events`, and `subagent_runs` collections, `activeRun` leases and renewal, `pendingInputs` queueing, pub/sub wakeup and stream broadcasts, recovery scans, and per-turn `resolveAgentConfig(sessionId)`.

### Messages (`AgentMessage`)

- **`EventMessage` (`type: "event"`)**: User message (`eventType: "user_message"`) or external event, with optional base64 `attachments` (`image` | `document`) and model-only `context` (`AiPostContext[]`).
- **`AssistantMessage` (`type: "assistant"`)**: Model output containing `content`, `toolCalls`, `reasoning`, `reasoningSignature`, `reasoningDetails`, `stopReason`, and optional `usedFallbackModel`.
- **`ToolMessage` (`type: "tool"`)**: Tool result paired by `toolCallId`, with `content`, `isError`, and optional `guidance`.
- **`SystemInjectionMessage` (`type: "system_injection"`)**: Mid-conversation system injection (`kind: "reminder" | "tool_activation" | "guardrail" | "state_change"`), placed after an `event` or `tool` message (verifiable via `validateSystemInjectionPlacement`).

### Single-Turn Data Flow

```text
prefetchHook?(sessionId)
  → store.loadAll()
  → beforeTurn(state)
  ┌─► store.fetchNew() → afterFetch(state) → [flush state.pending if non-empty]
  │     → plugins.transformContext()
  │     → formatMessagesForLLM()
  │     → client.chat()
  │     → afterLLM(state)
  │     → [no toolCalls]  ──► store.persist() → afterPersist / afterAssistantPersist ──┐
  │     → [has toolCalls] ──► beforeExecTools(state)                                   │
  │                             → plugins.beforeToolCall()                             │
  │                             → Tool.execute() (wave 1: parallel+serial, wave 2: deferred)
  │                             → afterExecTools(state)                                │
  │                             → plugins.afterToolCall / afterToolBatch               │
  │                             → store.hasNew() check & persist                       │
  │                             → afterPersist / afterAssistantPersist ────────────────┴─► loop or exit
  └───────────────────────────────────────────────────────────────────────────────────────┘
  → usage?.record(entry)
  → afterTurn(state)
```

---

## Event Flow

### `run()` Event Sequence

Text reply turn:

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

Turn with tool calls and steering:

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

### Event Types (`StreamEvent`)

| `event.type` | Scope | Description |
| --- | --- | --- |
| `snapshot` | Stream init | `StreamSnapshot` carrying the `session` document and optional `extras` |
| `turn_start` | Turn | Turn started (subagent preview events include `subagentToolCallId`) |
| `thinking_start` / `thinking_delta` / `thinking_end` | Turn | Reasoning stream events |
| `text_delta` | Turn | Assistant text delta (`event.delta: string`) |
| `tool_input_start` / `tool_input_delta` | Turn | Tool name declaration and argument JSON delta |
| `tool_call_start` / `tool_call_end` | Turn | Tool execution start (`input`) and completion (`output`, `error`, `durationMs`) |
| `usage_update` | Turn | Post-call context token count (`inputTokens`) |
| `turn_end` | Turn | Turn completed (`inputTokens`, `model`) |
| `interleave_start` | Turn | Queued user messages (`messageIds`) merged into the active turn |
| `error` | Turn | Turn error (`code`, `message`, `detail`) |
| `custom` | Turn / Tool | Custom event (`name: string`, `data?: unknown`) emitted via `ctx.onEvent` |
| `user_message` / `messages_consumed` / `message_revoked` | Session | Pending input queue updates |
| `session_update` | Session | Session title, `running` state, or `lastError` update |

`host.openSnapshotStream(res, { sessionId, format?: "ndjson" | "sse", buildSnapshot? })` writes the `snapshot` frame and continues with live events ordered by sequence ID (sending an initial flush after `300ms` and keep-alive heartbeats every `15s`).

---

## Tools & Concurrency

### Defining Tools & Custom Events

```ts
import type { Tool } from "@nia-teams/agent-core";

async function triggerPreviewBuild(branch: string, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  return `https://preview.example.com/${encodeURIComponent(branch)}`;
}

const deployTool: Tool = {
  name: "deploy_preview",
  description: "Deploy a preview build",
  concurrency: "serial", // "parallel" (default) | "serial" | "deferred"
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
      guidance: ["Share the preview URL with the user."],
    };
  },
};
```

### Concurrency Order

When a model response calls multiple tools, results are persisted in declaration order while executing in two phases:
1. **Phase 1 (`parallel` + `serial`)**: `"parallel"` tools start concurrently; `"serial"` tools run one by one in declaration order.
2. **Phase 2 (`deferred`)**: Runs after Phase 1 finishes (the built-in `subagent` tool uses `"deferred"`).

### Dynamic Tool Activation

Set `deferLoading: true` on optional tools (or omit them from initial `tools`), call `ctx.activateTools?.(names)` inside a tool, and provide `resolveToolDefinitions: async (names) => Tool[]` to mount them before the next model call.

---

## Steering & Session Wakeup

When new messages arrive while tools are running, `AgentRuntime` closes the pending `tool_use` with a placeholder `ToolMessage` (default `[Tool running...]`, configurable via `interleavePlaceholder`), appends the new user message followed by the tool output (`[Tool Result]` `event` message), and starts the next model step.

`AgentHost` session methods:
- **`host.injectMessage(opts)`**: Appends input to `sessions.pendingInputs` (creating the session if absent) and publishes a wakeup notification. Idle sessions acquire the lease and start; active sessions merge the queued input at the next tool boundary and emit `interleave_start`.
- **`host.wakeUp(sessionId)`**: Writes `runtimeWakeRequestedAt` to wake a session without adding a user message.
- **`isSessionSettled(sessionDoc)`**: Returns whether a session document has neither an active lease nor pending inputs.

---

## Lifecycle Hooks & `RuntimeState`

`AgentHooks` provides 8 lifecycle slots (plus the optional constructor-level `AgentRuntimeConfig.prefetchHook(sessionId)`):

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

## Built-in Plugins

`AgentHost` enables `context-pruning` and `guardrail` by default; standalone `AgentRuntime` callers can create them via `createDefaultBuiltinPlugins`:

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

- **`context-pruning`**: Retains recent turns and trims older large tool outputs and reasoning blocks as context approaches `contextWindow` (5-minute cache TTL awareness).
- **`guardrail`**: Detects repeated identical tool calls or consecutive tool errors, injecting a prompt before halting the loop.
- **`large-tool-result`**: Writes oversized tool outputs to `LargeToolResultStore` and leaves a head/tail preview and resource URI in context.
- **`pending-hidden`**: Filters internal state events before model formatting.

---

## Subagents

Pass `subagentProfiles: SubagentProfile[]` in `AgentConfig` (or `subagent: { profiles, store }` in standalone `run()`) to mount the built-in `subagent` tool (not recursively exposed to child subagents). When a subagent reaches `maxTurns`, it runs one final text-only turn (`toolChoice: "none"`) and sets `SubagentResultForFormat.maxTurnsReached` to that limit:

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
    rolePrompt: "Inspect files and return findings with file:line references.",
    tools: repositoryTools,
    client: fastClient,
    contextWindow: 200_000,
  },
];
```

`AgentHost` persists subagent transcripts in `subagent_runs`, supports follow-up via `resume: "<toolCallId>"`, forwards preview events with `subagentToolCallId` to the parent session, and resumes unfinished runs from checkpoints after a restart.

---

## Distributed Cron

`@nia-teams/agent-core/cron` (and `host.startCron` / `host.startScheduledTask`) provides multi-replica task scheduling:

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

## Crash Recovery & Timeouts

- **Database indexes**: `host.start()` runs no database DDL; apply `REQUIRED_INDEXES` from `@nia-teams/agent-core/host` in your deployment migration script.
- **Crash takeover**: Once a lease expires, the recovery scanner reclaims the session, appends `tool_result` messages for unclosed `tool_use` calls, resumes unfinished subagents from checkpoints, and processes the pending queue.
- **Default timings** (configurable on `AgentHostConfig`):
  - Session lease TTL: `60s` (`lockTtlMs`), renewed every `20s` (`lockRenewMs`) with holder-conditional CAS writes.
  - Stall detection: Renewal stops if no event fires within `90s` before turn start (`preTurnStallMs`) or `25min` within a turn (`inTurnStallMs`); after lease expiration, the recovery scanner (`scanIntervalMs = 60s`) reclaims the session.
  - Per-call LLM timeouts: `20min` max call duration (`llmCallTimeoutMs`) and `5min` streaming idle timeout (`llmIdleTimeoutMs`, reset on non-empty deltas).
  - Shutdown drain timeout: `290s` (`drainTimeoutMs`).

---

## Subpath Exports

| Subpath | Exports |
| --- | --- |
| `@nia-teams/agent-core` | `AgentRuntime`, `InMemoryConversationStore`, `Tool`, `AgentEvent`, `AgentHooks`, `RuntimePlugin`, `validateSystemInjectionPlacement` |
| `@nia-teams/agent-core/host` | `createAgentHost`, `AgentHost`, `REQUIRED_INDEXES`, `isSessionSettled`, `createMemoryDocStore`, `createMemoryPubSub`, cron helpers |
| `@nia-teams/agent-core/memory` | `MemoryDocStore`, `MemoryPubSub`, `createMemoryDocStore`, `createMemoryPubSub` |
| `@nia-teams/agent-core/docstore-mongo` | `createMongoDocStore({ db })` |
| `@nia-teams/agent-core/pubsub-redis` | `createRedisPubSub({ redis, keyPrefix? })` |
| `@nia-teams/agent-core/snapshot-stream` | `createSnapshotStream`, `HEARTBEAT_FIRST_MS` (`300`), `HEARTBEAT_STEADY_MS` (`15_000`) |
| `@nia-teams/agent-core/builtins` | `createDefaultBuiltinPlugins` + `context-pruning`, `guardrail`, `large-tool-result`, `pending-hidden` |
| `@nia-teams/agent-core/cron` | `startCron`, `startScheduledTask`, `calcNextRun`, `createFlatScheduleStore`, `createNestedScheduleStore` |
| `@nia-teams/agent-core/protocol` | `StreamEvent`, `StreamSnapshot`, `CustomAgentEvent`, and event interfaces |
| `@nia-teams/agent-core/llm-protocol` | Re-exports `@nia-teams/ai/protocol` contracts |
| `@nia-teams/agent-core/event-builders` | `StreamEvent` builder functions |

## License

MIT
