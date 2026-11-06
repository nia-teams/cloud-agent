import { describe, it, expect, vi } from 'vitest';
import { createDecisionClient, DecisionTimeoutError } from '../decision.js';
import type { ILLMClient } from '../protocol/index.js';
const make = (chat: ILLMClient['chat']): ILLMClient => ({ getModelName: () => 'test-model', getProviderName: () => 'scripted', chat });
describe('structured decisions', () => {
 it('runs over any injected client and returns parsed answers and usage', async () => {
  const chat = vi.fn(async () => ({ content: '{"answers":{"ready":true}}', stopReason: 'end_turn' as const, usage: { promptTokens: 4, completionTokens: 2, usdCost: 0.01 } }));
  const result = await createDecisionClient({ client: make(chat) }).decide({ state: { status: 'ready' }, questions: { ready: { type: 'boolean' } } });
  expect(result).toMatchObject({ model: 'test-model', answers: { ready: true }, usage: { totalTokens: 6, usdCost: 0.01 } });
  expect(chat).toHaveBeenCalledOnce();
 });
 it.each(['not json','[]','{"answers":[]}','{"missing":1}'])('rejects invalid structured output %s', async content => {
  await expect(createDecisionClient({ client: make(async () => ({ content, stopReason: 'end_turn' })) }).decide({ state: {}, questions: {} })).rejects.toThrow();
 });
 it.each([0,-1,Infinity,NaN])('rejects invalid timeout %s', timeoutMs => {
  expect(() => createDecisionClient({ client: make(async () => ({ content: '{}', stopReason: 'end_turn' })), timeoutMs })).toThrow();
 });
 it('times out even a client that ignores the signal', async () => {
  const keepAlive = setInterval(() => {}, 1000);
  try { await expect(createDecisionClient({ client: make(() => new Promise(() => {})), timeoutMs: 5 }).decide({ state: {}, questions: {} })).rejects.toBeInstanceOf(DecisionTimeoutError); }
  finally { clearInterval(keepAlive); }
 });
 it('preserves caller cancellation', async () => {
  const abort = new AbortController(); const error = new Error('cancel');
  const promise = createDecisionClient({ client: make(() => new Promise(() => {})) }).decide({ state: {}, questions: {}, signal: abort.signal });
  abort.abort(error); await expect(promise).rejects.toBe(error);
 });
});
