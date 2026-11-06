import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
process.chdir(root);
const readmes = ['README.md', 'README_CN.md', 'packages/agent-core/README.md', 'packages/agent-core/README_CN.md', 'packages/ai/README.md', 'packages/ai/README_CN.md'];
const blocks = (text) => [...text.matchAll(/^```ts\r?\n([\s\S]*?)^```/gm)].map(m => m[1]);
function launch(args, env = {}) {
  const child = spawn('npx', args, { cwd: root, detached: true, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  const done = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('exit', (code, signal) => resolve({ code, signal, output }));
  });
  return { child, done };
}
async function command(args, env) {
  const { child, done } = launch(args, env);
  const timer = setTimeout(() => process.kill(-child.pid, 'SIGKILL'), 60_000);
  try { const result = await done; assert.equal(result.code, 0, result.output); return result.output; }
  finally { clearTimeout(timer); }
}
const quickstarts = blocks(await readFile('README.md', 'utf8'));
for (const [i, name] of ['single', 'http'].entries()) {
  assert.equal(await readFile(`examples/quickstart-${name}.ts`, 'utf8'), quickstarts[i], `quickstart-${name} must match README bytes`);
}
const temp = await mkdtemp(`${root}.readme-check-`);
try {
  let count = 0;
  for (const path of readmes) {
    for (const code of blocks(await readFile(path, 'utf8'))) {
      await writeFile(`${temp}/snippet-${count++}.ts`, code);
    }
  }
  await writeFile(`${temp}/tsconfig.json`, JSON.stringify({ compilerOptions: {
    strict: true, noEmit: true, target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', esModuleInterop: true, skipLibCheck: true,
  }, include: ['*.ts'] }));
  await command(['tsc', '--strict', '-p', `${temp}/tsconfig.json`]);
  console.log(`README verbatim + strict compilation: PASS (${count} blocks across ${readmes.length} READMEs)`);
} finally { await rm(temp, { recursive: true, force: true }); }

// Quick Starts pass an explicit DeepSeek baseURL. Redirect only that origin to the local
// wire server; unrelated OpenAI environment settings must not affect endpoint or headers.
const requests = [];
const wire = createServer(async (req, res) => {
  try {
    assert.equal(req.method, 'POST');
    assert.equal(req.url, '/chat/completions');
    assert.equal(req.headers['authorization'], 'Bearer readme-test-key');
    assert.equal(req.headers['openai-organization'], undefined);
    assert.equal(req.headers['openai-project'], undefined);
    let body = '';
    for await (const chunk of req) body += chunk;
    const data = JSON.parse(body);
    assert.equal(data.stream, true);
    assert.equal(data.model, 'deepseek-v4-pro');
    requests.push(data);
    const tool = data.tools?.some(t => t.function?.name === 'get_order');
    const result = data.messages.some(m => m.role === 'tool');
    const useTool = tool && !result;
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const emit = (delta, finishReason = null) => res.write(`data: ${JSON.stringify({
      id: `chatcmpl_${requests.length}`, object: 'chat.completion.chunk', created: 0, model: data.model,
      choices: [{ index: 0, delta, finish_reason: finishReason }],
    })}\n\n`);
    if (useTool) {
      emit({ role: 'assistant', tool_calls: [{ index: 0, id: 'tool_order', type: 'function', function: { name: 'get_order', arguments: '{"orderId":"1024"}' } }] });
      emit({}, 'tool_calls');
    } else {
      emit({ role: 'assistant', content: 'Order 1024 is in transit.' });
      emit({}, 'stop');
    }
    res.write('data: [DONE]\n\n');
    res.end();
  } catch (error) { res.writeHead(500); res.end(String(error)); }
});
wire.listen(0, '127.0.0.1');
await once(wire, 'listening');
const wireOrigin = `http://127.0.0.1:${wire.address().port}`;
const preloadDir = await mkdtemp(`${root}.wire-preload-`);
const preloadFile = `${preloadDir}/redirect.mjs`;
await writeFile(preloadFile, `
const origFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
  if (url.startsWith('https://api.deepseek.com')) {
    const rewritten = url.replace('https://api.deepseek.com', process.env.WIRE_ORIGIN);
    return origFetch(rewritten, init);
  }
  return origFetch(input, init);
};
`);
const env = {
  DEEPSEEK_API_KEY: 'readme-test-key',
  OPENAI_BASE_URL: 'https://should-be-ignored.invalid/v1',
  OPENAI_ORG_ID: 'should-be-ignored-org',
  OPENAI_PROJECT_ID: 'should-be-ignored-proj',
  WIRE_ORIGIN: wireOrigin,
  NODE_OPTIONS: `--import=${preloadFile}`,
};
let http;
try {
  const output = await command(['tsx', 'examples/quickstart-single.ts'], env);
  assert.match(output, /Order 1024 is in transit\./);
  assert.equal(requests.length, 2);
  const toolResult = requests[1].messages.find(m => m.role === 'tool');
  assert.match(JSON.stringify(toolResult), /in_transit/);
  console.log('quickstart-single: real SDK SSE + tool execution + final answer (OPENAI_BASE_URL / organization / project ignored): PASS');
  http = launch(['tsx', 'examples/quickstart-http.ts'], env);
  const signal = AbortSignal.timeout(20_000);
  // Connect before POST: the initial snapshot proves there was no pre-seeded Session.
  let response;
  while (!response) {
    signal.throwIfAborted();
    try { response = await fetch('http://127.0.0.1:3000/sessions/readme-cold/stream', { signal }); }
    catch (error) { if (signal.aborted) throw error; await new Promise(resolve => setTimeout(resolve, 40)); }
  }
  assert.equal(response.status, 200);
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  const events = [];
  let buffer = '';
  let posted = false;
  while (!events.some(e => e.type === 'turn_end')) {
    const { value, done } = await reader.read();
    assert(!done, 'SSE ended early');
    buffer += value;
    let end;
    while ((end = buffer.indexOf('\n\n')) !== -1) {
      const frame = buffer.slice(0, end); buffer = buffer.slice(end + 2);
      if (frame.startsWith('data: ')) events.push(JSON.parse(frame.slice(6)));
    }
    if (!posted && events.some(e => e.type === 'snapshot')) {
      assert.deepEqual(events[0].session, { _id: 'readme-cold', title: null, messages: [] });
      const accepted = await fetch('http://127.0.0.1:3000/sessions/readme-cold/messages', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: 'Hello' }), signal });
      assert.equal(accepted.status, 202);
      await accepted.json();
      posted = true;
    }
  }
  assert(events.some(e => e.type === 'text_delta' && e.delta === 'Order 1024 is in transit.'));
  assert(!events.some(e => e.type === 'error'));
  assert.equal(requests.length, 3);
  await reader.cancel();
  console.log('quickstart-http: cold-start injectMessage upsert + Snapshot Stream + real SDK SSE: PASS');
} finally {
  if (http) { process.kill(-http.child.pid, 'SIGTERM'); await http.done; }
  wire.closeAllConnections();
  await new Promise(resolve => wire.close(resolve));
  await rm(preloadDir, { recursive: true, force: true });
}
