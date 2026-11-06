import type { AgentEvent, Tool } from '@nia-teams/agent-core';
import type { AgentConfig, OpenSnapshotStreamOptions } from '@nia-teams/agent-core/host';
import { client } from './scripted-client.mjs';
export function write(event: AgentEvent): void {
 if (event.type === 'text_delta') process.stdout.write(event.delta);
}
export const tool: Tool = {
 name: 'lookup', description: 'Look up an order', inputSchema: { type: 'object' },
 async execute(_input, ctx) {
  ctx.onEvent({ type: 'custom', name: 'order_lookup', data: { progress: 50 } });
  ctx.onEvent({ type: 'text_delta', delta: 'progress' });
  return 'done';
 },
};
export const config: AgentConfig = { client, systemPrompt: '', tools: [tool] };
export const stream: OpenSnapshotStreamOptions = { sessionId: 'demo' };
