---
name: ai
description: Call LLMs through @nia-teams/ai: one ILLMClient over Anthropic Messages, OpenAI Chat Completions, OpenAI Responses and Gemini, plus withFallback, generateImage and createDecisionClient. Use when code imports @nia-teams/ai or connects an official or compatible endpoint (DeepSeek, Qwen, Kimi, GLM).
---

Call `createClient({ protocol, model, apiKey, baseURL, ... })` from `@nia-teams/ai`. The client does not read API key or `baseURL` environment variables.
Supported protocols: `anthropic`, `openai-completions`, `openai-responses`, and `gemini`.
OpenAI-compatible endpoints differ in reasoning parameters; set `supportsThinking: true` and `reasoningFormat` (`'thinking_object' | 'enable_thinking' | 'reasoning_object' | 'openai'`) per provider, or thinking options are not sent. Compatible Anthropic endpoints (such as DeepSeek) may ignore `cache_control` and `defer_loading`.
Import message types from `@nia-teams/ai/protocol` and wire formatters from `@nia-teams/ai/adapters` when you do not want to load the Anthropic or OpenAI SDKs.
Wrap clients or lazy factories with `withFallback(primary, { network, policyViolation, refusal })`. After any stream delta has been emitted, `withFallback` does not retry; it rethrows the original error.
Use `createDecisionClient({ client })` for structured JSON answers and `generateImage` with `protocol: 'openai-images' | 'chat-multimodal'`.

Exact signatures: `node_modules/@nia-teams/ai/dist/**/*.d.ts`. Reference manual & TypeScript examples: `node_modules/@nia-teams/ai/README.md` (run `.ts` snippets with `npx tsx`).
