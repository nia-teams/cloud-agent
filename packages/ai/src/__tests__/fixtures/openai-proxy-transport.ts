import assert from 'node:assert/strict';
import { createServer, type IncomingHttpHeaders } from 'node:http';
import { connect, type Socket } from 'node:net';
import { fetch as undiciFetch, Headers as UndiciHeaders, ProxyAgent } from 'undici';
import { OpenAIClient, OpenAICompatibleHttpError } from '../../clients/openai.js';
import { createProxyDispatcher } from '../../proxy-dispatcher.js';
const models = ['google/gemini-4-argon', 'google/gemini-3.1-pro-preview', 'openai/gpt-4.1'];
const signature = { type: 'reasoning.encrypted', data: 'opaque-signature', id: 'reasoning-1', index: 0 };
const received: {
    headers: IncomingHttpHeaders;
    body: {
        model: string;
        stream?: boolean;
        usage?: unknown;
    };
    bytes: number;
}[] = [];
const sockets = new Set<Socket>();
let connects = 0;
const origin = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req)
        chunks.push(Buffer.from(chunk));
    const bytes = Buffer.concat(chunks);
    const body = JSON.parse(bytes.toString());
    received.push({ headers: req.headers, body, bytes: bytes.length });
    res.setHeader('x-request-id', 'local-transport-request');
    if (body.model === 'http-error') {
        res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '3' });
        res.end(JSON.stringify({ error: { message: 'local rate limit', code: 'rate_limit' } }));
    }
    else if (body.stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        const frame = (delta: object, finish_reason: string | null = null) => `data: ${JSON.stringify({
            id: 'cmpl-local', object: 'chat.completion.chunk', model: body.model,
            choices: [{ index: 0, delta, finish_reason }],
        })}\n\n`;
        const wire = frame({ role: 'assistant', content: 'transport-ok', reasoning_details: [signature] })
            + frame({}, 'stop') + 'data: [DONE]\n\n';
        res.write(wire.slice(0, 13));
        setImmediate(() => res.end(wire.slice(13)));
    }
    else {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: 'cmpl-local', object: 'chat.completion', model: body.model,
            choices: [{ index: 0, message: { role: 'assistant', content: 'transport-ok', reasoning_details: [signature] }, finish_reason: 'stop' }],
        }));
    }
});
const proxy = createServer();
for (const server of [origin, proxy]) {
    server.on('connection', socket => {
        sockets.add(socket);
        socket.on('close', () => sockets.delete(socket));
    });
}
proxy.on('connect', (req, downstream, head) => {
    connects++;
    const target = new URL(`http://${req.url}`);
    const upstream = connect(Number(target.port), target.hostname, () => {
        downstream.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        upstream.write(head);
        upstream.pipe(downstream);
        downstream.pipe(upstream);
    });
    sockets.add(upstream);
    upstream.on('close', () => sockets.delete(upstream));
    upstream.on('error', () => downstream.destroy());
    downstream.on('error', () => upstream.destroy());
    downstream.on('close', () => upstream.destroy());
});
await new Promise<void>(resolve => origin.listen(0, '127.0.0.1', resolve));
await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve));
const address = (server: typeof origin) => {
    const value = server.address();
    assert(value && typeof value === 'object');
    return `http://127.0.0.1:${value.port}`;
};
const proxyURL = address(proxy);
const baseURL = `${address(origin)}/v1`;
const rawAgent = new ProxyAgent(proxyURL);
const dispatcher = createProxyDispatcher(proxyURL)!;
const diagnostics: object[] = [];
try {
    for (const [label, transport, headers] of [
        ['native-headers', globalThis.fetch, new globalThis.Headers({ 'content-type': 'application/json', 'content-length': '33' })],
        ['native-record', globalThis.fetch, { 'content-type': 'application/json', 'content-length': '33' }],
        ['matching-undici', undiciFetch, new UndiciHeaders({ 'content-type': 'application/json', 'content-length': '33' })],
    ] as const) {
        const before = connects;
        let dispatchedLength: unknown;
        try {
            const response = await (transport as typeof undiciFetch)(`${baseURL}/chat/completions`, {
                method: 'POST', headers, body: JSON.stringify({ model: models[0] }),
                dispatcher: { dispatch(opts, handler) {
                        const headers = opts.headers as Record<string, unknown> | string[];
                        dispatchedLength = Array.isArray(headers) ? headers[headers.indexOf('content-length') + 1] : headers['content-length'];
                        return rawAgent.dispatch(opts, handler);
                    } } as ProxyAgent,
            });
            await response.text();
            diagnostics.push({ label, ok: true, dispatchedLength, lengthType: typeof dispatchedLength });
        }
        catch (error) {
            const failure = error as Error & {
                cause?: Error & {
                    code?: string;
                };
            };
            diagnostics.push({ label, ok: false, message: failure.message, cause: failure.cause?.message,
                code: failure.cause?.code, connects: connects - before, dispatchedLength, lengthType: typeof dispatchedLength });
        }
    }
    received.length = 0;
    let completed = 0;
    const failures: object[] = [];
    for (const model of models) {
        for (const streaming of [false, true]) {
            const deltas: unknown[] = [];
            const client = new OpenAIClient({ apiKey: 'local-test-key', baseURL, model, providerName: 'openrouter',
                dispatcher, includeUsageCost: true,
                extraHeaders: { 'X-Session-ID': 'local-session', 'HTTP-Referer': 'https://local.invalid', Authorization: 'Bearer local-override' },
            });
            const before = received.length;
            try {
                const response = await client.chat({ messages: [{ type: 'event', eventType: 'message', content: 'hello 世界', timestamp: new Date(0) }], systemPrompt: '', tools: [],
                    ...(streaming ? { onStreamDelta: delta => deltas.push(delta) } : {}),
                });
                assert.equal(response.content, 'transport-ok');
                assert.equal(response.upstreamRequestId, 'local-transport-request');
                assert.deepEqual(response.reasoningDetails, [signature]);
                if (streaming)
                    assert(deltas.length > 0);
                assert.equal(received.length, before + 1);
                const request = received.at(-1)!;
                assert.equal(request.headers['content-length'], String(request.bytes));
                assert.equal(request.headers.authorization, 'Bearer local-override');
                assert.equal(request.headers['x-session-id'], 'local-session');
                assert.equal(request.headers['http-referer'], 'https://local.invalid');
                assert.equal(request.headers['x-stainless-retry-count'], '0');
                assert.equal(request.headers['x-stainless-timeout'], '1200');
                assert.equal(request.body.model, model);
                assert.deepEqual(request.body.usage, { include: true });
                assert.equal(request.body.stream, streaming ? true : undefined);
                completed++;
            }
            catch (error) {
                const failure = error as Error & {
                    cause?: Error;
                };
                failures.push({ model, streaming, message: failure.message, cause: failure.cause?.message });
            }
        }
    }
    assert.equal(completed, 6, JSON.stringify(failures));
    for (const streaming of [false, true]) {
        const before = received.length;
        const client = new OpenAIClient({ apiKey: 'local-test-key', baseURL, model: 'http-error', dispatcher });
        await assert.rejects(client.chat({ messages: [{ type: 'event', eventType: 'message', content: 'hello', timestamp: new Date(0) }], systemPrompt: '', tools: [],
            ...(streaming ? { onStreamDelta: () => { } } : {}),
        }), error => error instanceof OpenAICompatibleHttpError && error.status === 429 && error.retryAfter === '3');
        assert.equal(received.length, before + 1);
    }
    console.log(JSON.stringify({ node: process.version, nativeUndici: process.versions.undici, diagnostics, completed, failures, connects }));
}
finally {
    await Promise.all([rawAgent.destroy(), dispatcher.destroy()]);
    for (const socket of sockets)
        socket.destroy();
    await Promise.all([new Promise<void>(resolve => origin.close(() => resolve())), new Promise<void>(resolve => proxy.close(() => resolve()))]);
}
