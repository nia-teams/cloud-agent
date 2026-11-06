# @nia-teams/ai

[English](./README.md) | 简体中文 · [返回仓库主页](../../README_CN.md)

支持 Anthropic、OpenAI、Gemini 四套 HTTP 协议的 TypeScript 客户端，包含 `withFallback`、图像生成与结构化 JSON 决策。可作为 [`@nia-teams/agent-core`](../agent-core/README_CN.md) 的 `ILLMClient` 使用，也可独立安装。

```sh
npm install @nia-teams/ai
```

AI 编程助手可加载 `node_modules/@nia-teams/ai/skills/ai/SKILL.md`（[`skills/ai/SKILL.md`](./skills/ai/SKILL.md)）。

---

## 目录

- [四套 HTTP 协议](#四套-http-协议)
- [快速开始](#快速开始)
- [协议客户端与参数](#协议客户端与参数)
  - [1. Anthropic Messages（`anthropic`）](#1-anthropic-messagesanthropic)
  - [2. OpenAI Chat Completions（`openai-completions`）](#2-openai-chat-completionsopenai-completions)
  - [3. OpenAI Responses（`openai-responses`）](#3-openai-responsesopenai-responses)
  - [4. Google Gemini GenerateContent（`gemini`）](#4-google-gemini-generatecontentgemini)
- [三层 Fallback（`withFallback`）](#三层-fallbackwithfallback)
- [推理状态回传与跨协议切换](#推理状态回传与跨协议切换)
- [工具参数修复与按需加载](#工具参数修复与按需加载)
- [响应结构、Token 用量与耗时指标](#响应结构token-用量与耗时指标)
- [图像生成与编辑（`generateImage`）](#图像生成与编辑generateimage)
- [结构化 JSON 决策（`createDecisionClient`）](#结构化-json-决策createdecisionclient)
- [子路径导出表](#子路径导出表)

---

## 四套 HTTP 协议

四家模型厂商定义了互不兼容的 HTTP 请求格式，差异集中在**多轮工具调用时推理状态的回传方式**：

| `protocol` | 客户端类 | HTTP 端点 | 多轮推理回传与协议特性 |
| --- | --- | --- | --- |
| `"anthropic"` | `AnthropicClient` | `POST {baseURL}/v1/messages` | 顶层 `system` 数组，消息由内容块（`thinking`、`redacted_thinking`、`tool_use`、`tool_result`）组成；多轮回传 `thinking.signature`，支持 4 档 `cache_control` 断点、`defer_loading` 按需加载与运行中按引用增删工具。 |
| `"openai-completions"` | `OpenAIClient` | `POST {baseURL}/chat/completions` | 基于 `role` 的 `messages[]` 与 `tool_calls[]`，支持配置不同兼容接口的推理参数格式（`reasoning_effort`、`reasoning`、`thinking`、`enable_thinking`）。 |
| `"openai-responses"` | `ResponsesClient` | `POST {baseURL}/responses` | 扁平输入流 `input[]`（`message`、`reasoning`、`function_call`、`function_call_output`），支持在多轮工具调用间回传加密推理项（`reasoning.encrypted_content`）。 |
| `"gemini"` | `GeminiClient` | `POST {baseURL}/v1beta/models/{model}:streamGenerateContent?alt=sse` | 原生 `contents[]` / `parts[]`（`functionCall`、`functionResponse`）与 `systemInstruction`，回传 `parts[].thoughtSignature` 签名，并剥离原生接口不支持的 JSON Schema 字段（`additionalProperties`、`$schema`、`default`）。 |

`@nia-teams/ai` 将四套协议统一为 `ILLMClient` 接口与 `AgentMessage` 消息结构，不读取 API Key、认证令牌、组织标识与 `baseURL` 相关的环境变量，也不内置模型注册表或全局连接池。

---

## 快速开始

保存为 `agent.ts` 并使用 `tsx` 运行：

```sh
DEEPSEEK_API_KEY=sk-... npx tsx agent.ts
```

```ts
import { createClient } from "@nia-teams/ai";

const client = createClient({
  protocol: "openai-completions",
  baseURL: "https://api.deepseek.com",
  model: "deepseek-v4-pro",
  apiKey: process.env.DEEPSEEK_API_KEY!,
  supportsThinking: true,
  reasoningFormat: "thinking_object",
  defaults: {
    enableThinking: true,
    maxOutputTokens: 8192,
  },
});

const response = await client.chat({
  systemPrompt: "用两句话简洁回答。",
  messages: [
    {
      type: "event",
      eventType: "user_message",
      content: "解释一下什么是乐观并发控制。",
      timestamp: new Date(),
    },
  ],
  onStreamDelta: (delta) => {
    if (delta.type === "text") process.stdout.write(delta.content);
  },
});

console.log("\nStop reason:", response.stopReason, "Usage:", response.usage);
```

---

## 协议客户端与参数

可通过 `createClient({ protocol, ... })` 创建客户端，或实例化 `AnthropicClient`、`OpenAIClient`、`ResponsesClient`、`GeminiClient`。所有客户端接收显式 `apiKey`、`model`，以及可选的 `baseURL`、`extraHeaders`、`defaults`（`ChatDefaults`）与 `logger`。

### 1. Anthropic Messages（`anthropic`）

```ts
import { AnthropicClient } from "@nia-teams/ai";

const anthropic = new AnthropicClient({
  apiKey: process.env.DEEPSEEK_API_KEY!,
  model: "deepseek-v4-pro",
  baseURL: "https://api.deepseek.com/anthropic", // 省略时默认为 https://api.anthropic.com；SDK 追加 /v1/messages
  extraHeaders: { "X-Custom-Header": "value" },
  supportsMidConversationTools: false,
  defaults: {
    enableThinking: true,
    thinkingType: "adaptive", // "enabled"（固定 budget_tokens）| "adaptive"
    effort: "high",         // 映射为 output_config.effort
    maxOutputTokens: 16_384,
  },
});
```

- **Prompt Cache 断点**：在请求根级、`system` 提示词、最后一个非延迟加载工具定义、倒数第二条用户消息上放置最多 4 个 `cache_control: { type: "ephemeral" }` 断点，不修改传入的消息数组。缓存断点和 `defer_loading` 是 Anthropic 官方端点的能力，兼容端点（如 DeepSeek）可能忽略。
- **相邻同 `role` 消息合并**：客户端适配器合并连续同 `role` 块，以固定 `tool_use` / `tool_result` 配对位置与缓存断点落点。

### 2. OpenAI Chat Completions（`openai-completions`）

```ts
import { OpenAIClient } from "@nia-teams/ai";

const openai = new OpenAIClient({
  apiKey: process.env.DASHSCOPE_API_KEY!,
  model: "qwen3.8-max",
  baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1", // 省略时默认为 https://api.openai.com/v1
  supportsThinking: true,
  supportsReasoningEffort: true,
  reasoningFormat: "enable_thinking", // "openai" | "reasoning_object" | "thinking_object" | "enable_thinking"
  includeUsageCost: false,   // 对支持 usage: { include: true } 的端点可设为 true
});
```

- **`reasoningFormat`**：
  - `"openai"`：顶层 `reasoning_effort`
  - `"reasoning_object"`：`reasoning: { effort }` 或 `{ enabled }`
  - `"thinking_object"`：`thinking: { type: "enabled" | "disabled" }`
  - `"enable_thinking"`：顶层布尔值 `enable_thinking`

### 3. OpenAI Responses（`openai-responses`）

```ts
import { ResponsesClient } from "@nia-teams/ai";

const responses = new ResponsesClient({
  apiKey: process.env.MOONSHOT_API_KEY!,
  model: "kimi-k3.1-pro",
  baseURL: "https://api.moonshot.cn/v1", // 省略时默认为 https://api.openai.com/v1
  supportsThinking: true,
  promptCacheKey: "session-1", // 写入请求体 prompt_cache_key
  defaults: {
    effort: "high",
    maxOutputTokens: 16_384,
  },
});
```

### 4. Google Gemini GenerateContent（`gemini`）

```ts
import { GeminiClient } from "@nia-teams/ai";

const gemini = new GeminiClient({
  apiKey: process.env.GEMINI_API_KEY!,
  model: "gemini-3.8-flash",
  baseURL: "https://generativelanguage.googleapis.com",
  authHeader: "x-goog-api-key", // 默认 "x-goog-api-key"；Bearer 网关可设为 "bearer"
  defaults: {
    enableThinking: true,
    thinkingBudget: 8192,
    maxOutputTokens: 65_536,
  },
});
```

---

## 三层 Fallback（`withFallback`）

`withFallback(primary, options)` 包装 `ILLMClient` 实例（或惰性工厂函数 `() => ILLMClient | Promise<ILLMClient>`）：

```ts
import { createClient, withFallback } from "@nia-teams/ai";

const primary = createClient({
  protocol: "openai-completions",
  baseURL: "https://api.deepseek.com",
  model: "deepseek-v4-pro",
  apiKey: process.env.DEEPSEEK_API_KEY!,
});

const resilientClient = withFallback(primary, {
  // 1. 网络与限流层：HTTP 5xx、429、连接重置或传输超时
  network: [
    () =>
      createClient({
        protocol: "openai-completions",
        baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
        model: "qwen3.8-max",
        apiKey: process.env.DASHSCOPE_API_KEY!,
      }),
  ],

  // 2. 内容策略报错：OpenAI 兼容协议返回 invalid_prompt 报错时切换
  policyViolation: () =>
    createClient({
      protocol: "openai-responses",
      baseURL: "https://api.moonshot.cn/v1",
      model: "kimi-k3.1-pro",
      apiKey: process.env.MOONSHOT_API_KEY!,
    }),

  // 3. 模型拒答：stopReason === "refusal" 时重试一次
  refusal: () =>
    createClient({
      protocol: "anthropic",
      baseURL: "https://open.bigmodel.cn/api/anthropic",
      model: "glm-5.3",
      apiKey: process.env.ZHIPU_API_KEY!,
    }),
});
```

触发条件与边界：
- **`policyViolation` 协议范围**：仅匹配 OpenAI 兼容协议（`openai-completions` 与 `openai-responses`）返回的 `providerCode === "invalid_prompt"` 报错；`network` 和 `refusal` 对四套协议均生效。
- **不拼接半截流式输出**：主客户端向 `onStreamDelta` 发出过任何增量分片后，`network` 与 `policyViolation` 均跳过重试并抛出原错误。
- **取消信号透传**：`request.signal` 触发取消时原样抛出，不进入 Fallback 分支。
- **响应模型标记**：备用客户端返回的响应设置 `response.usedFallbackModel = backupClient.getModelName()`。

---

## 推理状态回传与跨协议切换

- `LLMChatResponse` 保留 `reasoning`、`reasoningSignature`（Anthropic `signature` / Gemini `thoughtSignature`）与 `reasoningDetails`（OpenAI Responses 加密推理项）。
- 落盘为 `AssistantMessage` 后，同协议下一轮调用原样回传签名；跨协议切换时，目标协议适配器剥离或降级不兼容的签名字段。

---

## 工具参数修复与按需加载

- **工具参数 JSON 修复**：模型输出的工具参数含尾随逗号或未闭合引号时，`repairToolInputJson` 进行确定性修复；仍非合法 JSON 时附带 `malformedError`（`MalformedToolArgumentsError`），由 `AgentRuntime` 传回模型修正。
- **Anthropic 按需加载工具**：
  - `supportsDeferLoading: true`：将 `ToolDefinition.deferLoading: true` 映射为 `defer_loading: true`（详见 [Anthropic Tool Search 文档](https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool)）。
  - `supportsMidConversationTools: true`：支持运行中通过 `SystemInjectionMessage` 按引用增删工具（Anthropic beta）。

---

## 响应结构、Token 用量与耗时指标

`client.chat()` 返回 `LLMChatResponse`：

- `content`：`string | null`
- `toolCalls`：`LLMToolCall[] | undefined`（`id`、`name`、`arguments` 及可选 `malformedError`）
- `stopReason`：`"end_turn" | "tool_use" | "max_tokens" | "refusal" | "error"`
- `usage`：`{ promptTokens, completionTokens, contextTokens?, reasoningTokens?, cachedTokens?, cacheCreationTokens?, usdCost? }`
- `timings`（Anthropic 流式调用）：`{ ttftMs, generateMs, outputTokensPerSec? }`
- `upstreamRequestId` / `upstreamCompletionId` / `usedFallbackModel`

---

## 图像生成与编辑（`generateImage`）

```ts
import { generateImage } from "@nia-teams/ai";

// 1. OpenAI Images 接口（/v1/images/generations 与 /v1/images/edits）
const generated = await generateImage({
  protocol: "openai-images",
  model: "gpt-image-2",
  apiKey: process.env.OPENAI_API_KEY!,
  prompt: "深色背景下的云端服务器等距拓扑图",
});

// 2. 多模态 Chat Completions 图像输出（modalities: ["image", "text"]）
const edited = await generateImage({
  protocol: "chat-multimodal",
  model: "google/gemini-3.1-flash-image",
  baseURL: "https://openrouter.ai/api/v1",
  apiKey: process.env.OPENROUTER_API_KEY!,
  prompt: "将主数据库节点高亮为琥珀色",
  referenceImage: { buffer: generated.imageBuffer, mime: generated.mime },
  aspectRatio: "16:9",
  imageSize: "2K",
});
```

---

## 结构化 JSON 决策（`createDecisionClient`）

基于 `ILLMClient` 评估一组具名问题，带超时控制（`DecisionTimeoutError`，默认 `15_000ms`）：

```ts
import { createClient, createDecisionClient } from "@nia-teams/ai";

const client = createClient({
  protocol: "openai-completions",
  baseURL: "https://api.deepseek.com",
  model: "deepseek-flash",
  apiKey: process.env.DEEPSEEK_API_KEY!,
});

const decision = createDecisionClient({ client, timeoutMs: 10_000 });

const res = await decision.decide({
  state: { action: "DROP TABLE users", environment: "production" },
  questions: {
    requiresHumanApproval: {
      type: "boolean",
      description: "生产环境破坏性操作返回 true",
    },
  },
});

console.log(res.answers.requiresHumanApproval); // true
```

---

## 子路径导出表

| 子路径 | 导出内容 | 加载上游 SDK |
| --- | --- | --- |
| `@nia-teams/ai` | `createClient`、四个协议客户端、`withFallback`、`generateImage`、`createDecisionClient`、`repairToolInputJson`、`createProxyDispatcher` | 是（`@anthropic-ai/sdk`、`openai`、`undici`） |
| `@nia-teams/ai/protocol` | `AgentMessage` 联合类型、`ILLMClient`、`LLMChatRequest`、`LLMChatResponse`、`MalformedToolArgumentsError`、`renderAiPostContext` | **否** |
| `@nia-teams/ai/adapters` | 报文转换器 `AnthropicAdapter`、`OpenAIAdapter`、`GeminiAdapter`、`mergeSystemInjectionsIntoFollowingMessage` | **否** |

## 开源协议

MIT
