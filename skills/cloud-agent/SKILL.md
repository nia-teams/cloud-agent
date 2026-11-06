---
name: cloud-agent
description: Work in the cloud-agent repo (@nia-teams/ai, @nia-teams/agent-core): choose the package, run examples, and pass repo checks before delivery.
---

`@nia-teams/ai` provides LLM protocol clients, `withFallback`, `generateImage`, and `createDecisionClient`.
`@nia-teams/agent-core` provides `AgentRuntime` (single-process turn loop) and `@nia-teams/agent-core/host` (`AgentHost` for multi-replica deployment: one replica per session, stream resume after disconnect, takeover after crash).
`examples/single-process.mjs` and `examples/multi-replica-http.mjs` run with a scripted local client (no API key); `examples/quickstart-*.ts` call a live endpoint via `DEEPSEEK_API_KEY`.
Run the commands in `AGENTS.md` before delivery. See `API.md` for the export inventory.
