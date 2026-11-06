import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createAgentHost, createMemoryDocStore, createMemoryPubSub } from '@nia-teams/agent-core/host';
import { NOOP_LOGGER } from '@nia-teams/agent-core';
import { client } from './scripted-client.mjs';
const docStore = createMemoryDocStore();
const pubSub = createMemoryPubSub();
const config = { docStore, pubSub, logger: NOOP_LOGGER, contextPruning: false,
 resolveAgentConfig: () => ({ client, systemPrompt: 'Be helpful.', tools: [] }),
};
const writer = createAgentHost(config);
const observer = createAgentHost(config);
const server = createServer((request, response) => {
 void (async () => {
  if (request.method === 'GET' && request.url === '/sessions/demo/stream') {
   await observer.openSnapshotStream(response, { sessionId: 'demo', format: 'sse' });
  } else if (request.method === 'POST' && request.url === '/sessions/demo/messages') {
   let body = '';
   for await (const chunk of request) body += chunk;
   const payload = JSON.parse(body);
   const result = await writer.injectMessage({ sessionId: 'demo', eventType: 'user_message', content: String(payload.content), userId: 'demo-user', userName: 'Demo' });
   response.writeHead(202, { 'Content-Type': 'application/json' });
   response.end(JSON.stringify(result));
  } else { response.writeHead(404); response.end(); }
 })().catch(error => { response.destroy(error); });
});
const controller = new AbortController();
const timeout = setTimeout(() => controller.abort(new Error('Example timed out')), 10000);
try {
 await Promise.all([writer.start(), observer.start()]);
 server.listen(0, '127.0.0.1');
 await once(server, 'listening');
 const address = server.address();
 assert(address && typeof address !== 'string');
 const base = `http://127.0.0.1:${address.port}`;
 const response = await fetch(`${base}/sessions/demo/stream`, { signal: controller.signal });
 assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/);
 assert(response.body);
 const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
 /** @type {Array<Record<string, unknown>>} */
 const events = [];
 let buffer = '';
 let posted = false;
 while (!events.some(event => event.type === 'turn_end')) {
  const { value, done } = await reader.read();
  assert(!done, 'Stream ended before turn_end');
  buffer += value;
  let boundary;
  while ((boundary = buffer.indexOf('\n\n')) !== -1) {
   const frame = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
   if (frame.startsWith('data: ')) events.push(JSON.parse(frame.slice(6)));
  }
  if (!posted && events.some(event => event.type === 'snapshot')) {
   posted = true;
   const sent = await fetch(`${base}/sessions/demo/messages`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: 'Hello' }), signal: controller.signal });
   assert.equal(sent.status, 202); await sent.json();
  }
 }
 assert.equal(events[0].type, 'snapshot');
 assert.deepEqual(events[0].session, { _id: 'demo', title: null, messages: [] });
 assert.equal(events.filter(event => event.type === 'text_delta').length, 1);
 assert(events.some(event => event.type === 'text_delta' && event.delta === 'Hello from cloud-agent!'));
 await reader.cancel();
 console.log('multi-replica-http: snapshot + text_delta + turn_end over SSE: PASS');
} finally {
 clearTimeout(timeout); controller.abort();
 server.closeAllConnections();
 await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve(undefined)));
 await Promise.all([writer.stop(), observer.stop()]);
}
