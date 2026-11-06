import type { DocStore } from './types.js';
import { COL_EVENTS, eventSeqCounterId } from './schema.js';
interface StoredEvent extends Record<string, unknown> {
    sessionId: string;
    turnId: string | null;
    seq: number;
    payload: string;
    createdAt: Date;
}
interface SeqCounter extends Record<string, unknown> {
    n: number;
}
export async function nextEventSeq(store: DocStore, sessionId: string): Promise<number> {
    const doc = await store.findOneAndUpdate<SeqCounter & {
        _id: string;
    }>(COL_EVENTS, { _id: eventSeqCounterId(sessionId) }, { $inc: { n: 1 } }, { upsert: true, returnDocument: 'after' });
    if (!doc || typeof doc.n !== 'number') {
        throw new Error(`event seq counter doc not returned after $inc for session ${sessionId}`);
    }
    return doc.n;
}
export async function getCurrentSeq(store: DocStore, sessionId: string): Promise<number> {
    const doc = await store.findOne<SeqCounter & {
        _id: string;
    }>(COL_EVENTS, { _id: eventSeqCounterId(sessionId) });
    return doc?.n ?? 0;
}
export interface AppendEventOpts {
    sessionId: string;
    turnId: string | null;
    payload: string;
    seq: number;
}
export async function appendEvent(store: DocStore, opts: AppendEventOpts): Promise<void> {
    await store.insertOne<StoredEvent>(COL_EVENTS, {
        sessionId: opts.sessionId,
        turnId: opts.turnId,
        seq: opts.seq,
        payload: opts.payload,
        createdAt: new Date(),
    });
}
export async function fetchBufferedEvents(store: DocStore, sessionId: string, upToSeq: number): Promise<string[]> {
    if (upToSeq <= 0)
        return [];
    const docs = await store.find<StoredEvent>(COL_EVENTS, { sessionId, seq: { $lte: upToSeq } }, { sort: { seq: 1 }, projection: { payload: 1, seq: 1 } as Record<string, 1> });
    return docs.map((d) => d.payload);
}
export async function replayEvents(store: DocStore, sessionId: string, sinceEventId: number): Promise<string[]> {
    const docs = await store.find<StoredEvent>(COL_EVENTS, { sessionId, seq: { $gt: sinceEventId } }, {
        sort: { seq: 1 },
        projection: { payload: 1, seq: 1 } as Record<string, 1>,
    });
    return docs.map((d) => d.payload);
}
export async function clearTurnEvents(store: DocStore, sessionId: string, turnId: string): Promise<void> {
    await store.deleteMany(COL_EVENTS, { sessionId, turnId });
}
const EVENT_ID_RE = /"_eventId":\s*\d+/;
export function injectEventId(payload: string, seq: number): string {
    if (EVENT_ID_RE.test(payload)) {
        return payload.replace(EVENT_ID_RE, `"_eventId":${seq}`);
    }
    const i = payload.indexOf('{');
    if (i < 0)
        return payload;
    let j = i + 1;
    while (j < payload.length && /\s/.test(payload[j]))
        j++;
    if (payload[j] === '}') {
        return `${payload.slice(0, i + 1)}"_eventId":${seq}${payload.slice(j)}`;
    }
    return `${payload.slice(0, i + 1)}"_eventId":${seq},${payload.slice(i + 1)}`;
}
