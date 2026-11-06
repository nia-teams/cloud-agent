/** @type {import('@nia-teams/ai/protocol').ILLMClient} */
export const client = {
 getProviderName: () => 'scripted',
 getModelName: () => 'demo',
 async chat(request) {
  request.signal?.throwIfAborted();
  const content = 'Hello from cloud-agent!';
  request.onStreamDelta?.({ type: 'text', content });
  return { content, stopReason: 'end_turn', usage: { promptTokens: 1, completionTokens: 5 } };
 },
};
