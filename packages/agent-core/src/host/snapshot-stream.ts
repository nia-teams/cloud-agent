import { createSnapshotStream } from '../protocol/snapshot-stream.js';
import type { SnapshotReply } from '../protocol/snapshot-stream.js';
import { format } from 'node:util';
import type { DocStore, OpenSnapshotStreamOptions, PubSub, InternalTimings } from './types.js';
import type { Logger } from '../types.js';
import { broadcastChannel } from './schema.js';
import { fetchBufferedEvents, getCurrentSeq } from './events.js';
export interface OpenStreamDeps {
    docStore: DocStore;
    pubSub: PubSub;
    timings: InternalTimings;
    logger: Logger;
}
export async function openSnapshotStream(deps: OpenStreamDeps, reply: SnapshotReply, opts: OpenSnapshotStreamOptions): Promise<void> {
    const { docStore, pubSub, timings, logger } = deps;
    const channel = broadcastChannel(timings.channelPrefix, opts.sessionId);
    await createSnapshotStream({
        reply,
        format: opts.format,
        subscribeChannel: async (onMessage) => {
            const unsubscribe = await pubSub.subscribe(channel, onMessage);
            return async () => {
                try {
                    await unsubscribe();
                }
                catch (err) {
                    logger.warn({ err, sessionId: opts.sessionId }, 'host.snapshotStream · unsubscribe failed');
                }
            };
        },
        buildSnapshot: opts.buildSnapshot ?? (async () => {
            const doc = await docStore.findOne('sessions', { _id: opts.sessionId }, { projection: { messages: 1, title: 1 } });
            return { type: 'snapshot', session: { _id: opts.sessionId, title: doc?.title ?? null, messages: Array.isArray(doc?.messages) ? doc.messages : [] } };
        }),
        fetchBufferedEvents: (upToSeq: number) => fetchBufferedEvents(docStore, opts.sessionId, upToSeq),
        getCurrentSeq: () => getCurrentSeq(docStore, opts.sessionId),
        ...(opts.extraHeaders ? { extraHeaders: opts.extraHeaders } : {}),
        ...(opts.onSnapshotComplete ? { onSnapshotComplete: opts.onSnapshotComplete } : {}),
        ...(opts.onClose ? { onClose: opts.onClose } : {}),
        logger: {
            info: (...a) => logger.info({ snapshotStream: true }, format(...a)),
            warn: (...a) => logger.warn({ snapshotStream: true }, format(...a)),
            debug: (...a) => logger.debug?.({ snapshotStream: true }, format(...a)),
        },
    });
}
