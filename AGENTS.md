# Contributing to cloud-agent

Use Node.js 20 or newer and npm workspaces. Install from the public registry:

```sh
npm ci
npm run build
npm run typecheck
npm test
node examples/single-process.mjs
node examples/multi-replica-http.mjs
node scripts/verify-closure.mjs
node scripts/verify-readme-examples.mjs
```

- `packages/ai` owns the SDK-independent message and client protocol. Only its root entry loads SDK transports. The `/protocol` and `/adapters` entries must remain SDK-free.
- `packages/agent-core` depends on `@nia-teams/ai/protocol`, never the reverse. No database, cache, or HTTP framework driver is bundled.
- Root `AgentRuntime` is the single-process turn loop; `/host` exposes `AgentHost` and `createAgentHost` for coordinated session ownership.
- Use the discriminated event union. Application events use `{ type: 'custom', name, data }`; do not widen the union to arbitrary strings.
- Network fallback must never splice partial streams or intercept caller cancellation.
- Memory adapters are process-local and non-durable; replicas in one process can share them. Separate production processes need shared durable adapters. The HTTP example binds loopback, has no authentication, and is not a production server.
- Optional durable acceptance scenarios in `scripts/acceptance/runtime-durable-*.mjs` require caller-provided database/cache drivers and explicit loopback service URLs. They are intentionally not package dependencies and are not part of the default test command.
- Keep exports, package skills, examples, and `API.md` in sync. Run `node scripts/list-exports.mjs` after changing public types.
- Do not add registry credentials, internal endpoints, or model-selection registries to the AI package. Supply explicit protocol, model, credentials, and endpoint options.

README TypeScript snippets run via `npx tsx`, not `node` on Node 20. Keep root Quick Start blocks byte-identical to `examples/quickstart-*.ts`; the README gate compiles all six READMEs against real driver types (development-only MongoDB/Redis dependencies).

Both packages use MIT licensing. Keep bilingual `README.md` and `README_CN.md` files (at repository root and under each package) synchronized whenever public APIs or defaults change.
