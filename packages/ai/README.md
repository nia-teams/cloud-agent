# @nia-teams/ai

English | [简体中文](./README_CN.md) · [Back to Repository Root](../../README.md)

TypeScript clients for Anthropic, OpenAI, and Gemini HTTP wire protocols, including `withFallback`, image generation, and structured JSON decisions. Implements `ILLMClient` for [`@nia-teams/agent-core`](../agent-core/README.md) and works standalone.

```sh
npm install @nia-teams/ai
```

AI coding assistants can load `node_modules/@nia-teams/ai/skills/ai/SKILL.md` ([`skills/ai/SKILL.md`](./skills/ai/SKILL.md)).

---

## Contents

- [Four HTTP Protocols](#four-http-protocols)
- [Quick Start](#quick-start)
- [Protocol Clients & Options](#protocol-clients--options)
  - [1. Anthropic Messages (`anthropic`)](#1-anthropic-messages-anthropic)
  - [2. OpenAI Chat Completions (`openai-completions`)](#2-openai-chat-completions-openai-completions)
  - [3. OpenAI Responses (`openai-responses`)](#3-openai-responses-openai-responses)
  - [4. Google Gemini GenerateContent (`gemini`)](#4-google-gemini-generatecontent-gemini)
- [Three-Tier Fallback (`withFallback`)](#three-tier-fallback-withfallback)
- [Reasoning Replay & Cross-Protocol Continuity](#reasoning-replay--cross-protocol-continuity)
- [Tool Input Repair & On-Demand Loading](#tool-input-repair--on-demand-loading)
- [Response Structure, Token Usage & Timings](#response-structure-token-usage--timings)
- [Image Generation & Editing (`generateImage`)](#image-generation--editing-generateimage)
- [Structured JSON Decisions (`createDecisionClient`)](#structured-json-decisions-createdecisionclient)
- [Subpath Exports](#subpath-exports)

---

## Four HTTP Protocols

Major model providers define mutually incompatible HTTP formats that differ in **how model reasoning state is carried across multi-turn tool calls**:

| `protocol` | Client Class | HTTP Endpoint | Multi-Turn Reasoning & Protocol Specifics |
| --- | --- | --- | --- |
| `"anthropic"` | `AnthropicClient` | `POST {baseURL}/v1/messages` | Top-level `system` array, content-block messages (`thinking`, `redacted_thinking`, `tool_use`, `tool_result`), `thinking.signature` replay, 4-breakpoint `cache_control`, `defer_loading`, and mid-conversation tool reference updates. |
| `"openai-completions"` | `OpenAIClient` | `POST {baseURL}/chat/completions` | Role-based `messages[]` and `tool_calls[]` with configurable reasoning parameter formats (`reasoning_effort`, `reasoning`, `thinking`, `enable_thinking`). |
| `"openai-responses"` | `ResponsesClient` | `POST {baseURL}/responses` | Flat item array `input[]` (`message`, `reasoning`, `function_call`, `function_call_output`) that round-trips encrypted reasoning items (`reasoning.encrypted_content`) across tool turns. |
| `"gemini"` | `GeminiClient` | `POST {baseURL}/v1beta/models/{model}:streamGenerateContent?alt=sse` | Native `contents[]` / `parts[]` (`functionCall`, `functionResponse`) and `systemInstruction`, replaying `parts[].thoughtSignature` and stripping JSON Schema keywords rejected by the native endpoint (`additionalProperties`, `$schema`, `default`). |

`@nia-teams/ai` unifies these four protocols behind `ILLMClient` and `AgentMessage`, does not read API key, auth token, organization, or `baseURL` environment variables, and holds no model registry or global connection pool.

---

## Quick Start

Save as `agent.ts` and run with `tsx`:

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
  systemPrompt: "Answer in two sentences.",
  messages: [
    {
      type: "event",
      eventType: "user_message",
      content: "Explain optimistic concurrency control.",
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

## Protocol Clients & Options

Use `createClient({ protocol, ... })` or instantiate `AnthropicClient`, `OpenAIClient`, `ResponsesClient`, or `GeminiClient`. All clients accept explicit `apiKey`, `model`, and optional `baseURL`, `extraHeaders`, `defaults` (`ChatDefaults`), and `logger`.

### 1. Anthropic Messages (`anthropic`)

```ts
import { AnthropicClient } from "@nia-teams/ai";

const anthropic = new AnthropicClient({
  apiKey: process.env.DEEPSEEK_API_KEY!,
  model: "deepseek-v4-pro",
  baseURL: "https://api.deepseek.com/anthropic", // defaults to https://api.anthropic.com; SDK appends /v1/messages
  extraHeaders: { "X-Custom-Header": "value" },
  supportsMidConversationTools: false,
  defaults: {
    enableThinking: true,
    thinkingType: "adaptive", // "enabled" (fixed budget_tokens) | "adaptive"
    effort: "high",         // maps to output_config.effort
    maxOutputTokens: 16_384,
  },
});
```

- **Prompt Cache breakpoints**: Places up to four `cache_control: { type: "ephemeral" }` breakpoints across the root payload, `system` prompt, the last non-deferred tool definition, and the second-to-last user message without mutating input arrays. Cache breakpoints and `defer_loading` are capabilities of the official Anthropic endpoint; compatible endpoints (such as DeepSeek) may ignore them.
- **Adjacent same-`role` merging**: The client adapter merges consecutive same-`role` blocks to keep `tool_use` / `tool_result` pairing and cache breakpoint positions fixed.

### 2. OpenAI Chat Completions (`openai-completions`)

```ts
import { OpenAIClient } from "@nia-teams/ai";

const openai = new OpenAIClient({
  apiKey: process.env.DASHSCOPE_API_KEY!,
  model: "qwen3.8-max",
  baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1", // defaults to https://api.openai.com/v1
  supportsThinking: true,
  supportsReasoningEffort: true,
  reasoningFormat: "enable_thinking", // "openai" | "reasoning_object" | "thinking_object" | "enable_thinking"
  includeUsageCost: false,   // set true on endpoints that accept usage: { include: true }
});
```

- **`reasoningFormat`**:
  - `"openai"`: top-level `reasoning_effort`
  - `"reasoning_object"`: `reasoning: { effort }` or `{ enabled }`
  - `"thinking_object"`: `thinking: { type: "enabled" | "disabled" }`
  - `"enable_thinking"`: top-level `enable_thinking: boolean`

### 3. OpenAI Responses (`openai-responses`)

```ts
import { ResponsesClient } from "@nia-teams/ai";

const responses = new ResponsesClient({
  apiKey: process.env.MOONSHOT_API_KEY!,
  model: "kimi-k3.1-pro",
  baseURL: "https://api.moonshot.ai/v1", // defaults to https://api.openai.com/v1
  supportsThinking: true,
  promptCacheKey: "session-1", // sets request body prompt_cache_key
  defaults: {
    effort: "high",
    maxOutputTokens: 16_384,
  },
});
```

### 4. Google Gemini GenerateContent (`gemini`)

```ts
import { GeminiClient } from "@nia-teams/ai";

const gemini = new GeminiClient({
  apiKey: process.env.GEMINI_API_KEY!,
  model: "gemini-3.8-flash",
  baseURL: "https://generativelanguage.googleapis.com",
  authHeader: "x-goog-api-key", // default "x-goog-api-key"; set "bearer" for Bearer gateways
  defaults: {
    enableThinking: true,
    thinkingBudget: 8192,
    maxOutputTokens: 65_536,
  },
});
```

---

## Three-Tier Fallback (`withFallback`)

`withFallback(primary, options)` wraps an `ILLMClient` instance (or lazy factory `() => ILLMClient | Promise<ILLMClient>`):

```ts
import { createClient, withFallback } from "@nia-teams/ai";

const primary = createClient({
  protocol: "openai-completions",
  baseURL: "https://api.deepseek.com",
  model: "deepseek-v4-pro",
  apiKey: process.env.DEEPSEEK_API_KEY!,
});

const resilientClient = withFallback(primary, {
  // 1. Network & rate limits: HTTP 5xx, 429, connection reset, or timeout
  network: [
    () =>
      createClient({
        protocol: "openai-completions",
        baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
        model: "qwen3.8-max",
        apiKey: process.env.DASHSCOPE_API_KEY!,
      }),
  ],

  // 2. Content policy error: switches on OpenAI-compatible invalid_prompt errors
  policyViolation: () =>
    createClient({
      protocol: "openai-responses",
      baseURL: "https://api.moonshot.ai/v1",
      model: "kimi-k3.1-pro",
      apiKey: process.env.MOONSHOT_API_KEY!,
    }),

  // 3. Refusal: retries once when stopReason === "refusal"
  refusal: () =>
    createClient({
      protocol: "anthropic",
      baseURL: "https://api.z.ai/api/anthropic",
      model: "glm-5.3",
      apiKey: process.env.ZHIPU_API_KEY!,
    }),
});
```

Trigger rules and boundaries:
- **`policyViolation` protocol scope**: Matches `providerCode === "invalid_prompt"` returned by OpenAI-compatible protocols (`openai-completions` and `openai-responses`); `network` and `refusal` apply to all four protocols.
- **No partial-stream splicing**: Once `primary` emits any stream delta via `onStreamDelta`, `network` and `policyViolation` skip retries and rethrow the original error.
- **Cancellation passthrough**: `request.signal` cancellations rethrow without entering fallback tiers.
- **Fallback model attribution**: Responses from a backup client set `response.usedFallbackModel = backupClient.getModelName()`.

---

## Reasoning Replay & Cross-Protocol Continuity

- `LLMChatResponse` retains `reasoning`, `reasoningSignature` (Anthropic `signature` / Gemini `thoughtSignature`), and `reasoningDetails` (OpenAI Responses encrypted reasoning items).
- Once persisted on `AssistantMessage`, same-protocol turns replay signatures; on cross-protocol switches, the target adapter strips or degrades incompatible signature fields.

---

## Tool Input Repair & On-Demand Loading

- **Tool argument JSON repair**: When tool arguments contain syntax defects such as trailing commas or unclosed quotes, `repairToolInputJson` performs deterministic repair; if still invalid JSON, the call carries `malformedError` (`MalformedToolArgumentsError`) for `AgentRuntime` to return to the model.
- **Anthropic on-demand tool loading**:
  - `supportsDeferLoading: true`: Maps `ToolDefinition.deferLoading: true` to `defer_loading: true` (see [Anthropic Tool Search docs](https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool)).
  - `supportsMidConversationTools: true`: Enables mid-conversation tool reference additions and removals via `SystemInjectionMessage` (Anthropic beta).

---

## Response Structure, Token Usage & Timings

`client.chat()` returns `LLMChatResponse`:

- `content`: `string | null`
- `toolCalls`: `LLMToolCall[] | undefined` (`id`, `name`, `arguments`, optional `malformedError`)
- `stopReason`: `"end_turn" | "tool_use" | "max_tokens" | "refusal" | "error"`
- `usage`: `{ promptTokens, completionTokens, contextTokens?, reasoningTokens?, cachedTokens?, cacheCreationTokens?, usdCost? }`
- `timings` (streaming Anthropic calls): `{ ttftMs, generateMs, outputTokensPerSec? }`
- `upstreamRequestId` / `upstreamCompletionId` / `usedFallbackModel`

---

## Image Generation & Editing (`generateImage`)

```ts
import { generateImage } from "@nia-teams/ai";

// 1. OpenAI Images endpoint (/v1/images/generations & /v1/images/edits)
const generated = await generateImage({
  protocol: "openai-images",
  model: "gpt-image-2",
  apiKey: process.env.OPENAI_API_KEY!,
  prompt: "Isometric cloud server topology on dark background",
});

// 2. Multimodal Chat Completions image output (modalities: ["image", "text"])
const edited = await generateImage({
  protocol: "chat-multimodal",
  model: "google/gemini-3.1-flash-image",
  baseURL: "https://openrouter.ai/api/v1",
  apiKey: process.env.OPENROUTER_API_KEY!,
  prompt: "Highlight the primary database node in amber",
  referenceImage: { buffer: generated.imageBuffer, mime: generated.mime },
  aspectRatio: "16:9",
  imageSize: "2K",
});
```

---

## Structured JSON Decisions (`createDecisionClient`)

Evaluates named questions over any `ILLMClient` with timeout control (`DecisionTimeoutError`, default `15_000ms`):

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
      description: "True if this operation is destructive in production",
    },
  },
});

console.log(res.answers.requiresHumanApproval); // true
```

---

## Subpath Exports

| Subpath | Exports | Loads Provider SDKs |
| --- | --- | --- |
| `@nia-teams/ai` | `createClient`, protocol clients, `withFallback`, `generateImage`, `createDecisionClient`, `repairToolInputJson`, `createProxyDispatcher` | Yes (`@anthropic-ai/sdk`, `openai`, `undici`) |
| `@nia-teams/ai/protocol` | `AgentMessage` union, `ILLMClient`, `LLMChatRequest`, `LLMChatResponse`, `MalformedToolArgumentsError`, `renderAiPostContext` | **No** |
| `@nia-teams/ai/adapters` | Wire formatters `AnthropicAdapter`, `OpenAIAdapter`, `GeminiAdapter`, `mergeSystemInjectionsIntoFollowingMessage` | **No** |

## License

MIT
