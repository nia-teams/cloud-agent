import type { ServerResponse } from 'node:http';
export type SnapshotReply = ServerResponse | {
    raw: ServerResponse;
};
import { createGzip, constants as zlibConstants } from 'node:zlib';
export interface SnapshotStreamLogger {
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    debug?: (...args: unknown[]) => void;
}
export interface SnapshotStreamStats {
    rawBytes: number;
    gzipBytes: number;
    snapshotMs: number;
}
export type SubscribeChannel = (onMessage: (payload: string) => void) => Promise<() => Promise<void> | void> | (() => Promise<void> | void);
export interface CreateSnapshotStreamOpts {
    reply: SnapshotReply;
    format?: 'ndjson' | 'sse';
    subscribeChannel: SubscribeChannel;
    buildSnapshot: () => Promise<unknown> | unknown;
    fetchBufferedEvents: (upToSeq: number) => Promise<string[]> | string[];
    getCurrentSeq: () => Promise<number> | number;
    extraHeaders?: Record<string, string>;
    onSnapshotComplete?: (stats: SnapshotStreamStats) => Promise<void> | void;
    onClose?: () => Promise<void> | void;
    logger?: SnapshotStreamLogger;
}
export const HEARTBEAT_FIRST_MS = 300;
export const HEARTBEAT_STEADY_MS = 15000;
const GZIP_OPTS = { flush: zlibConstants.Z_SYNC_FLUSH } as const;
const BASE_HEADERS: Record<string, string> = {
    'Content-Type': 'application/x-ndjson',
    'Content-Encoding': 'gzip',
    'Cache-Control': 'no-cache, no-transform',
    'X-Accel-Buffering': 'no',
    'Connection': 'keep-alive',
};
export async function createSnapshotStream(opts: CreateSnapshotStreamOpts): Promise<void> {
    const { reply, subscribeChannel, buildSnapshot, fetchBufferedEvents, getCurrentSeq, extraHeaders, onSnapshotComplete, onClose, } = opts;
    const log: SnapshotStreamLogger = opts.logger ?? {
        info: (...a) => console.log(...a),
        warn: (...a) => console.warn(...a),
        debug: (...a) => console.debug(...a),
    };
    const frame = (json: string): string => opts.format === 'sse' ? `data: ${json}\n\n` : `${json}\n`;
    let resolveClosed: () => void = () => {};
    const closed = new Promise<void>(resolve => { resolveClosed = resolve; });
    const t0 = Date.now();
    const raw = 'raw' in reply ? reply.raw : reply;
    const gzip = createGzip(GZIP_OPTS);
    gzip.pipe(raw);
    gzip.on('error', (err) => {
        log.warn({ err }, 'gzip stream error');
        try {
            gzip.destroy();
        }
        catch { }
    });
    let snapshotRawBytes = 0;
    let snapshotGzipBytes = 0;
    const countGzipChunk = (chunk: Buffer): void => {
        snapshotGzipBytes += chunk.byteLength;
    };
    gzip.on('data', countGzipChunk);
    raw.writeHead(200, { ...BASE_HEADERS, ...(opts.format === 'sse' ? { 'Content-Type': 'text/event-stream' } : {}), ...(extraHeaders ?? {}) });
    raw.socket?.setKeepAlive(true, 30000);
    const preSnapQueue: string[] = [];
    let snapshotDone = false;
    const writer = (message: string): void => {
        if (!snapshotDone) {
            preSnapQueue.push(message);
            return;
        }
        if (!raw.destroyed && !gzip.destroyed) {
            try {
                gzip.write(frame(message));
            }
            catch (e) {
                log.warn({ err: e }, 'stream write failed');
            }
        }
    };
    const writeLine = (data: unknown): void => {
        if (raw.destroyed || gzip.destroyed)
            return;
        const line = frame(JSON.stringify(data));
        try {
            gzip.write(line);
            snapshotRawBytes += Buffer.byteLength(line);
        }
        catch (e) {
            log.warn({ err: e }, 'snapshot writeLine failed');
        }
    };
    let heartbeatFirst: ReturnType<typeof setTimeout> | null = null;
    let heartbeatSteady: ReturnType<typeof setInterval> | null = null;
    const unsubscribe = await subscribeChannel(writer);
    let cleaned = false;
    const cleanup = async (): Promise<void> => {
        if (cleaned)
            return;
        cleaned = true;
        resolveClosed();
        if (heartbeatFirst) {
            clearTimeout(heartbeatFirst);
            heartbeatFirst = null;
        }
        if (heartbeatSteady) {
            clearInterval(heartbeatSteady);
            heartbeatSteady = null;
        }
        try {
            gzip.destroy();
        }
        catch { }
        try {
            await unsubscribe();
        }
        catch (e) {
            log.debug?.({ err: e }, 'cleanup unsubscribe failed');
        }
        if (onClose) {
            try {
                await onClose();
            }
            catch (e) {
                log.warn({ err: e }, 'onClose hook failed');
            }
        }
    };
    raw.on('close', () => void cleanup());
    raw.on('error', () => void cleanup());
    let envelope: unknown;
    try {
        envelope = await buildSnapshot();
    }
    catch (e) {
        log.warn({ err: e }, 'buildSnapshot threw — closing stream');
        await cleanup();
        return;
    }
    writeLine(envelope);
    let replayUpTo: number | undefined;
    for (const msg of preSnapQueue) {
        const m = msg.match(/"_eventId":"(\d+)"/);
        if (m) {
            const s = Number(m[1]);
            if (Number.isFinite(s) && (replayUpTo === undefined || s - 1 < replayUpTo)) {
                replayUpTo = s - 1;
            }
        }
    }
    if (replayUpTo === undefined) {
        replayUpTo = await getCurrentSeq();
    }
    let buffered: string[] = [];
    try {
        buffered = await fetchBufferedEvents(replayUpTo);
    }
    catch (e) {
        log.warn({ err: e }, 'fetchBufferedEvents failed — skipping replay');
    }
    for (const serialized of buffered) {
        if (raw.destroyed || gzip.destroyed)
            break;
        const line = frame(serialized);
        try {
            gzip.write(line);
            snapshotRawBytes += Buffer.byteLength(line);
        }
        catch (e) {
            log.warn({ err: e }, 'replay write failed');
            break;
        }
    }
    for (const msg of preSnapQueue) {
        if (raw.destroyed || gzip.destroyed)
            break;
        const line = frame(msg);
        try {
            gzip.write(line);
            snapshotRawBytes += Buffer.byteLength(line);
        }
        catch (e) {
            log.warn({ err: e }, 'drain write failed');
            break;
        }
    }
    preSnapQueue.length = 0;
    snapshotDone = true;
    await new Promise<void>((resolve) => gzip.flush(zlibConstants.Z_SYNC_FLUSH, resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));
    gzip.off('data', countGzipChunk);
    if (!raw.destroyed && !gzip.destroyed) {
        try {
            gzip.write(opts.format === 'sse' ? ': heartbeat\n\n' : '\n');
            await new Promise<void>((resolve) => gzip.flush(zlibConstants.Z_SYNC_FLUSH, resolve));
        }
        catch (e) {
            log.warn({ err: e }, 'icebreaker flush failed');
        }
    }
    const tSnapshot = Date.now();
    if (onSnapshotComplete) {
        try {
            await onSnapshotComplete({
                rawBytes: snapshotRawBytes,
                gzipBytes: snapshotGzipBytes,
                snapshotMs: tSnapshot - t0,
            });
        }
        catch (e) {
            log.warn({ err: e }, 'onSnapshotComplete hook failed');
        }
    }
    // Flush proxy and client stream buffers shortly after the snapshot, then keep the connection alive.
    const writeHeartbeat = (): boolean => {
        if (raw.destroyed || gzip.destroyed)
            return false;
        try {
            gzip.write(opts.format === 'sse' ? ': heartbeat\n\n' : '\n');
            return true;
        }
        catch {
            return false;
        }
    };
    heartbeatFirst = setTimeout(() => {
        heartbeatFirst = null;
        if (!writeHeartbeat())
            return;
        heartbeatSteady = setInterval(() => {
            if (!writeHeartbeat()) {
                if (heartbeatSteady) {
                    clearInterval(heartbeatSteady);
                    heartbeatSteady = null;
                }
            }
        }, HEARTBEAT_STEADY_MS);
        heartbeatSteady.unref();
    }, HEARTBEAT_FIRST_MS);
    heartbeatFirst.unref();
    return closed;
}
