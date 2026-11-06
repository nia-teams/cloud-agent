---
name: agent-core
description: Build agents with @nia-teams/agent-core: AgentRuntime runs one turn in one process; AgentHost deploys it across replicas — one replica per session, stream resume after disconnect, takeover after crash. Use when code imports @nia-teams/agent-core or an agent must run as a horizontally scaled service.
---

`AgentRuntime` (`@nia-teams/agent-core`) runs one turn in one process over `ConversationStore` (`InMemoryConversationStore` for local state).
`AgentHost` (`@nia-teams/agent-core/host`) coordinates multi-replica deployment: it keeps each session on one replica, lets clients reconnect via snapshot + live events, and lets another replica take over after a crash.

For a local turn, construct `AgentRuntime` with `InMemoryConversationStore` and call `run({ client, systemPrompt, tools, onEvent })`. Narrow events by `event.type`; emit custom tool events with `ctx.onEvent({ type: 'custom', name, data })`.
For multi-replica deployment, import `createAgentHost` from `@nia-teams/agent-core/host` and pass shared MongoDB/Redis adapters (`@nia-teams/agent-core/docstore-mongo`, `@nia-teams/agent-core/pubsub-redis`); `createMemoryDocStore` and `createMemoryPubSub` work only within a single process.
Call `host.start()`, `host.injectMessage` (creates the session if absent), `host.openSnapshotStream(res, { sessionId, format: 'sse' })`, and `host.stop()` on shutdown.
HTTP authentication, session authorization, and rate limiting belong in the application server.

Exact signatures: `node_modules/@nia-teams/agent-core/dist/**/*.d.ts`. Reference manual & TypeScript examples: `node_modules/@nia-teams/agent-core/README.md` (run `.ts` snippets with `npx tsx`).
