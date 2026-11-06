import { afterEach, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { generateImage } from '../image.js';
let server: Server | undefined;
async function serve(reply: (body: string, url: string, headers: import('node:http').IncomingHttpHeaders) => unknown): Promise<string> {
 server = createServer((req, res) => {
  void (async () => {
   let body = ''; for await(const chunk of req) body += chunk;
   const result = reply(body, req.url ?? '', req.headers);
   res.writeHead(200, { 'Content-Type': 'application/json', 'x-request-id': 'image-request' }); res.end(JSON.stringify(result));
  })().catch(error => res.destroy(error));
 });
 server.listen(0, '127.0.0.1'); await once(server, 'listening');
 const address = server.address(); if(!address || typeof address === 'string') throw new Error('Missing server port');
 return `http://127.0.0.1:${address.port}/v1`;
}
afterEach(async () => { if(server) { server.closeAllConnections(); await new Promise<void>(resolve => server!.close(() => resolve())); server = undefined; } });
it('generates images through the standard JSON endpoint and forwards headers', async () => {
 const baseURL = await serve((body, url, headers) => {
  expect(url).toBe('/v1/images/generations'); expect(JSON.parse(body)).toEqual({ model: 'image-model', prompt: 'draw' });
  expect(headers.authorization).toBe('Bearer key'); expect(headers['x-extra']).toBe('value');
  return { data: [{ b64_json: Buffer.from('image').toString('base64') }], usage: { input_tokens: 4, output_tokens: 5 }, output_format: 'jpeg' };
 });
 const result = await generateImage({ protocol: 'openai-images', model: 'image-model', apiKey: 'key', baseURL, prompt: 'draw', extraHeaders: { 'X-Extra': 'value' } });
 expect(result).toMatchObject({ imageBuffer: Buffer.from('image'), mime: 'image/jpeg', upstreamRequestId: 'image-request', usage: { inputTokens: 4, outputTokens: 5 } });
});
it('edits using valid multipart form data with a reference image', async () => {
 const baseURL = await serve((body, url, headers) => {
  expect(url).toBe('/v1/images/edits'); expect(headers['content-type']).toMatch(/multipart\/form-data; boundary=/);
  expect(body).toContain('name="model"'); expect(body).toContain('name="prompt"'); expect(body).toContain('name="image"; filename="reference.png"'); expect(body).toContain('image/png');
  return { data: [{ b64_json: 'aW1hZ2U=' }] };
 });
 expect((await generateImage({ protocol: 'openai-images', model: 'image-model', apiKey: 'key', baseURL, prompt: 'edit', referenceImage: { buffer: Buffer.from('image'), mime: 'image/png' } })).imageBuffer.toString()).toBe('image');
});
it.each([false,true])('supports chat-multimodal with reference=%s', async reference => {
 const baseURL = await serve((body, url) => {
  expect(url).toBe('/v1/chat/completions'); const json = JSON.parse(body);
  expect(json.modalities).toEqual(['image','text']); expect(json.image_config).toEqual({ aspect_ratio: '1:1', image_size: '1K' });
  if(reference) expect(json.messages[0].content[1].image_url.url).toBe('data:image/png;base64,aW1hZ2U=');
  else expect(json.messages[0].content).toBe('draw');
  return { choices: [{ message: { images: [{ image_url: { url: 'data:image/png;base64,aW1hZ2U=' } }] } }], usage: { prompt_tokens: 4, completion_tokens: 5, cost: 0.01 } };
 });
 expect(await generateImage({ protocol: 'chat-multimodal', apiKey: 'key', model: 'image-model', baseURL, prompt: 'draw', aspectRatio: '1:1', imageSize: '1K', ...(reference ? { referenceImage: { buffer: Buffer.from('image'), mime: 'image/png' } } : {}) })).toMatchObject({ imageBuffer: Buffer.from('image'), mime: 'image/png', usage: { usdCost: 0.01 } });
});
it('does not invent image aspect ratio or size defaults', async () => {
 const baseURL = await serve(body => { expect(JSON.parse(body)).not.toHaveProperty('image_config'); return { choices: [{ message: { images: [{ image_url: { url: 'data:image/webp;base64,aW1hZ2U=' } }] } }] }; });
 expect((await generateImage({ protocol: 'chat-multimodal', apiKey: 'key', model: 'model', prompt: 'draw', baseURL })).mime).toBe('image/webp');
});
it('preserves caller cancellation before allocating transport', async () => {
 const controller = new AbortController(); const reason = new Error('cancelled'); controller.abort(reason);
 await expect(generateImage({ protocol: 'openai-images', model: 'model', apiKey: 'key', prompt: 'draw', signal: controller.signal })).rejects.toBe(reason);
});
