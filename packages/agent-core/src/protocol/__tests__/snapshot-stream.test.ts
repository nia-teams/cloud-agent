import { PassThrough } from 'node:stream';
import type { ServerResponse } from 'node:http';
import { constants, gunzipSync } from 'node:zlib';
import { describe, expect, it, vi } from 'vitest';
import { createSnapshotStream } from '../snapshot-stream.js';
describe('snapshot response compatibility', () => {
    it.each([false, true])('streams a compressed snapshot with wrapped=%s', async (wrapped) => {
        const raw = Object.assign(new PassThrough(), { writeHead: vi.fn(), socket: null });
        const chunks: Buffer[] = [];
        raw.on('data', chunk => chunks.push(chunk));
        const unsubscribe = vi.fn();
        const closed = new Promise<void>(resolve => raw.on('close', resolve));
        await new Promise<void>((resolve, reject) => {
            void createSnapshotStream({
                reply: wrapped ? { raw: raw as unknown as ServerResponse } : raw as unknown as ServerResponse,
                subscribeChannel: () => unsubscribe,
                buildSnapshot: () => ({ type: 'snapshot', hello: 'world' }),
                fetchBufferedEvents: () => [],
                getCurrentSeq: () => 0,
                onSnapshotComplete: () => {
                    try {
                        expect(raw.writeHead).toHaveBeenCalledWith(200, expect.objectContaining({ 'Content-Encoding': 'gzip' }));
                        const text = gunzipSync(Buffer.concat(chunks), { finishFlush: constants.Z_SYNC_FLUSH }).toString();
                        expect(text).toContain('"hello":"world"');
                        resolve();
                    }
                    catch (error) {
                        reject(error);
                    }
                    finally {
                        raw.destroy();
                    }
                },
                logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
            }).catch(reject);
        });
        await closed;
        expect(unsubscribe).toHaveBeenCalledOnce();
    });
});
