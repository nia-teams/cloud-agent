import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
export default defineConfig({
 resolve: { alias: [
  { find: '@nia-teams/ai/protocol', replacement: fileURLToPath(new URL('./packages/ai/src/protocol/index.ts', import.meta.url)) },
  { find: '@nia-teams/ai/adapters', replacement: fileURLToPath(new URL('./packages/ai/src/adapters/index.ts', import.meta.url)) },
  { find: /^@nia-teams\/ai$/, replacement: fileURLToPath(new URL('./packages/ai/src/index.ts', import.meta.url)) },
 ] },
 test: { include: ['packages/*/src/**/__tests__/**/*.test.ts'], environment: 'node' },
});
