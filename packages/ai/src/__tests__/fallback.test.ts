import { describe, it, expect, vi } from 'vitest';
import { withFallback, type FallbackTarget } from '../fallback.js';
import { OpenAICompatibleHttpError } from '../clients/openai.js';
import type { ILLMClient, LLMChatResponse, LLMChatRequest, StreamDelta } from '../protocol/index.js';
const ok: LLMChatResponse = { content: 'ok', stopReason: 'end_turn' };
const request: LLMChatRequest = { messages: [] };
function client(name: string, chat: ILLMClient['chat'] = async () => ok): ILLMClient {
 return { getModelName: () => name, getProviderName: () => 'test', chat: vi.fn(chat) };
}
function fail(error: unknown): ILLMClient { return client('primary', async () => { throw error; }); }
const transient = Object.assign(new Error('unavailable'), { status: 503 });
const policy = () => new OpenAICompatibleHttpError({ status: 400, message: 'Prompt flagged for usage policy violation', providerCode: 'invalid_prompt', responseBody: JSON.stringify({ error: { code: 'invalid_prompt', message: 'Prompt flagged for usage policy violation' } }) });
describe('composable fallback', () => {
 it.each([429, 500, 503, 599])('retries HTTP %i lazily and preserves client identity', async status => {
  const backup = client('backup'); const lazy = vi.fn(() => backup);
  const wrapped = withFallback(fail({ status }), { network: [lazy] });
  expect(lazy).not.toHaveBeenCalled();
  expect(wrapped.getModelName()).toBe('primary');
  expect(wrapped.getProviderName()).toBe('test');
  expect(await wrapped.chat(request)).toMatchObject({ content: 'ok', usedFallbackModel: 'backup' });
  expect(lazy).toHaveBeenCalledOnce();
 });
 it.each(['ECONNRESET','ECONNREFUSED','ETIMEDOUT','EAI_AGAIN','UND_ERR_CONNECT_TIMEOUT','UND_ERR_HEADERS_TIMEOUT','UND_ERR_BODY_TIMEOUT','UND_ERR_SOCKET'])('recognizes transport code %s through causes', async code => {
  expect(await withFallback(fail({ cause: { code } }), { network: [client('backup')] }).chat(request)).toMatchObject({ usedFallbackModel: 'backup' });
 });
 it.each(['TimeoutError','ConnectTimeoutError','HeadersTimeoutError','BodyTimeoutError'])('retries transport %s', async name => {
  expect(await withFallback(fail({ name }), { network: [client('backup')] }).chat(request)).toMatchObject({ usedFallbackModel: 'backup' });
 });
 it.each([400,401,403,404,422])('does not retry HTTP %i', async status => {
  const target = vi.fn(() => client('unused')); const error = { status };
  await expect(withFallback(fail(error), { network: [target] }).chat(request)).rejects.toBe(error);
  expect(target).not.toHaveBeenCalled();
 });
 it.each(['text','thinking','tool_input_start','tool_input_delta'] as const)('never retries after a %s delta', async type => {
  const primary = client('primary', async req => { req.onStreamDelta?.({ type, content: 'partial' }); throw transient; });
  const backup = client('backup');
  await expect(withFallback(primary, { network: [backup] }).chat({ ...request, onStreamDelta() {} })).rejects.toBe(transient);
  expect(backup.chat).not.toHaveBeenCalled();
 });
 it('does not splice a failed backup stream with the next model', async () => {
  const first = client('first', async req => { req.onStreamDelta?.({ type: 'text', content: 'partial' }); throw transient; });
  const second = client('second');
  await expect(withFallback(fail(transient), { network: [first, second] }).chat({ ...request, onStreamDelta() {} })).rejects.toBe(transient);
  expect(second.chat).not.toHaveBeenCalled();
 });
 it('aggregates construction and request failures with primary cause', async () => {
  const error = new Error('construction failed');
  const wrapped = withFallback(fail(transient), { network: [() => { throw error; }, fail('other')] });
  await expect(wrapped.chat(request)).rejects.toMatchObject({ cause: transient, errors: [transient, error, 'other'] });
 });
 it('tries later targets even when an earlier backup fails non-transiently', async () => {
  expect(await withFallback(fail(transient), { network: [fail({ status: 400 }), async () => client('last')] }).chat(request)).toMatchObject({ usedFallbackModel: 'last' });
 });
 it('retains nested fallback provenance', async () => {
  expect(await withFallback(fail(transient), { network: [client('outer', async () => ({ ...ok, usedFallbackModel: 'inner' }))] }).chat(request)).toMatchObject({ usedFallbackModel: 'inner' });
 });
 it('does not allocate fallback for a successful primary', async () => {
  const lazy = vi.fn(() => client('unused'));
  expect(await withFallback(client('primary'), { network: [lazy], policyViolation: lazy, refusal: lazy }).chat(request)).toEqual(ok);
  expect(lazy).not.toHaveBeenCalled();
 });
 it.each(['network','policyViolation','refusal'] as const)('never retries caller cancellation at %s tier', async tier => {
  const controller = new AbortController(); const lazy = vi.fn(() => client('unused'));
  const primary = client('primary', async () => { controller.abort(); if(tier === 'refusal') return { ...ok, stopReason: 'refusal' }; throw tier === 'network' ? transient : policy(); });
  const options = tier === 'network' ? { network: [lazy] } : { [tier]: lazy };
  await withFallback(primary, options).chat({ ...request, signal: controller.signal }).catch(() => {});
  expect(lazy).not.toHaveBeenCalled();
 });
 it('does not retry AbortError even with a misleading HTTP status', async () => {
  const target = client('unused'); const error = { name: 'AbortError', status: 503 };
  await expect(withFallback(fail(error), { network: [target] }).chat(request)).rejects.toBe(error);
  expect(target.chat).not.toHaveBeenCalled();
 });
 it('retries a structured policy rejection exactly once', async () => {
  expect(await withFallback(fail(policy()), { policyViolation: client('policy') }).chat(request)).toMatchObject({ usedFallbackModel: 'policy' });
 });
 it('does not match a policy rejection using only error message text', async () => {
  const error = new Error('invalid_prompt prompt flagged for usage policy'); const target = client('unused');
  await expect(withFallback(fail(error), { policyViolation: target }).chat(request)).rejects.toBe(error);
  expect(target.chat).not.toHaveBeenCalled();
 });
 it('rethrows the original policy error if the policy fallback fails', async () => {
  const error = policy();
  await expect(withFallback(fail(error), { policyViolation: fail(transient) }).chat(request)).rejects.toBe(error);
 });
 it('retries a completed refusal and keeps the original refusal if backup fails', async () => {
  const refusal: LLMChatResponse = { content: 'no', stopReason: 'refusal' };
  expect(await withFallback(client('primary', async () => refusal), { refusal: client('backup') }).chat(request)).toMatchObject({ usedFallbackModel: 'backup' });
  expect(await withFallback(client('primary', async () => refusal), { refusal: fail(transient) }).chat(request)).toEqual(refusal);
 });
 it('composes network then policy then refusal', async () => {
  const primary = fail(transient); const network = fail(policy()); const policyClient = client('policy', async () => ({ content: 'no', stopReason: 'refusal' })); const refusal = client('refusal');
  // A failed network chain aggregates all attempts, so a policy error in a backup does not masquerade as the primary policy rejection.
  await expect(withFallback(primary, { network: [network], policyViolation: policyClient, refusal }).chat(request)).rejects.toBeInstanceOf(AggregateError);
  const wrapped = withFallback(fail(policy()), { network: [client('unused')], policyViolation: policyClient, refusal });
  expect(await wrapped.chat(request)).toMatchObject({ usedFallbackModel: 'refusal' });
 });
});
