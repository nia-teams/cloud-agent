import { describe, it, expect, beforeEach } from 'vitest';
import { nextEventSeq, getCurrentSeq, appendEvent, fetchBufferedEvents, replayEvents, clearTurnEvents, injectEventId, } from '../events.js';
import { COL_EVENTS, eventSeqCounterId } from '../schema.js';
import { createMemoryDocStore, type MockMemoryDocStore } from './fixtures.js';
describe('host/events', () => {
    let store: MockMemoryDocStore;
    beforeEach(() => {
        store = createMemoryDocStore();
    });
    describe('nextEventSeq / getCurrentSeq · per-session', () => {
        it('first call for a session yields 1 and creates per-session counter doc', async () => {
            const n = await nextEventSeq(store, 'sess-A');
            expect(n).toBe(1);
            const counter = store.inspect(COL_EVENTS, eventSeqCounterId('sess-A')) as {
                n: number;
            };
            expect(counter.n).toBe(1);
        });
        it('returns strictly monotonic ascending ints within one session', async () => {
            const seqs: number[] = [];
            for (let i = 0; i < 5; i++)
                seqs.push(await nextEventSeq(store, 'sess-A'));
            expect(seqs).toEqual([1, 2, 3, 4, 5]);
        });
        it('parallel allocation within one session never collides', async () => {
            const all = await Promise.all(Array.from({ length: 10 }, () => nextEventSeq(store, 'sess-A')));
            const sorted = [...all].sort((a, b) => a - b);
            expect(sorted).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
        });
        it('two sessions count independently — both start at 1, no shared state', async () => {
            const a1 = await nextEventSeq(store, 'sess-A');
            const b1 = await nextEventSeq(store, 'sess-B');
            const a2 = await nextEventSeq(store, 'sess-A');
            const b2 = await nextEventSeq(store, 'sess-B');
            const b3 = await nextEventSeq(store, 'sess-B');
            const a3 = await nextEventSeq(store, 'sess-A');
            expect(a1).toBe(1);
            expect(a2).toBe(2);
            expect(a3).toBe(3);
            expect(b1).toBe(1);
            expect(b2).toBe(2);
            expect(b3).toBe(3);
            const ca = store.inspect(COL_EVENTS, eventSeqCounterId('sess-A')) as {
                n: number;
            };
            const cb = store.inspect(COL_EVENTS, eventSeqCounterId('sess-B')) as {
                n: number;
            };
            expect(ca.n).toBe(3);
            expect(cb.n).toBe(3);
        });
        it('parallel allocation across two sessions: each independently 1..N', async () => {
            const ops: Promise<{
                sid: string;
                seq: number;
            }>[] = [];
            for (let i = 0; i < 5; i++) {
                ops.push(nextEventSeq(store, 'sess-A').then((seq) => ({ sid: 'sess-A', seq })));
                ops.push(nextEventSeq(store, 'sess-B').then((seq) => ({ sid: 'sess-B', seq })));
            }
            const out = await Promise.all(ops);
            const aSeqs = out.filter((r) => r.sid === 'sess-A').map((r) => r.seq).sort((x, y) => x - y);
            const bSeqs = out.filter((r) => r.sid === 'sess-B').map((r) => r.seq).sort((x, y) => x - y);
            expect(aSeqs).toEqual([1, 2, 3, 4, 5]);
            expect(bSeqs).toEqual([1, 2, 3, 4, 5]);
        });
        it('counter doc id format is `eventseq:<sessionId>`', () => {
            expect(eventSeqCounterId('abc')).toBe('eventseq:abc');
            expect(eventSeqCounterId('sess-1')).toBe('eventseq:sess-1');
        });
        it('getCurrentSeq returns 0 when counter absent for a session', async () => {
            expect(await getCurrentSeq(store, 'sess-nope')).toBe(0);
        });
        it('getCurrentSeq returns last allocated value without incrementing, per session', async () => {
            await nextEventSeq(store, 'sess-A');
            await nextEventSeq(store, 'sess-A');
            await nextEventSeq(store, 'sess-B');
            expect(await getCurrentSeq(store, 'sess-A')).toBe(2);
            expect(await getCurrentSeq(store, 'sess-A')).toBe(2);
            expect(await getCurrentSeq(store, 'sess-B')).toBe(1);
        });
    });
    describe('appendEvent + fetchBufferedEvents + replayEvents', () => {
        beforeEach(async () => {
            const sid = 'sess-1';
            const tid = 'turn-1';
            await appendEvent(store, {
                sessionId: sid,
                turnId: tid,
                seq: 1,
                payload: '{"_eventId":1,"type":"text_delta","delta":"a"}',
            });
            await appendEvent(store, {
                sessionId: sid,
                turnId: tid,
                seq: 2,
                payload: '{"_eventId":2,"type":"text_delta","delta":"b"}',
            });
            await appendEvent(store, {
                sessionId: sid,
                turnId: tid,
                seq: 3,
                payload: '{"_eventId":3,"type":"turn_end"}',
            });
            await appendEvent(store, {
                sessionId: 'sess-other',
                turnId: 'turn-x',
                seq: 1,
                payload: '{"_eventId":1,"type":"text_delta","delta":"x"}',
            });
            await nextEventSeq(store, 'sess-1');
            await nextEventSeq(store, 'sess-other');
        });
        it('fetchBufferedEvents returns this session’s payloads ordered by seq, no counter docs leaking', async () => {
            const buf = await fetchBufferedEvents(store, 'sess-1', 5);
            expect(buf).toHaveLength(3);
            expect(buf.map((s) => JSON.parse(s)._eventId)).toEqual([1, 2, 3]);
        });
        it('fetchBufferedEvents respects upToSeq', async () => {
            const buf = await fetchBufferedEvents(store, 'sess-1', 2);
            expect(buf.map((s) => JSON.parse(s)._eventId)).toEqual([1, 2]);
        });
        it('fetchBufferedEvents returns [] when upToSeq <= 0', async () => {
            expect(await fetchBufferedEvents(store, 'sess-1', 0)).toEqual([]);
            expect(await fetchBufferedEvents(store, 'sess-1', -1)).toEqual([]);
        });
        it('fetchBufferedEvents does not bleed across sessions even when seqs collide', async () => {
            const buf = await fetchBufferedEvents(store, 'sess-1', 1);
            expect(buf.map((s) => JSON.parse(s).delta)).toEqual(['a']);
        });
        it('replayEvents returns strictly seq > sinceEventId, no counter docs leaking', async () => {
            const buf = await replayEvents(store, 'sess-1', 1);
            expect(buf.map((s) => JSON.parse(s)._eventId)).toEqual([2, 3]);
        });
        it('replayEvents with sinceEventId=0 returns everything for the session', async () => {
            const buf = await replayEvents(store, 'sess-1', 0);
            expect(buf).toHaveLength(3);
        });
    });
    describe('clearTurnEvents', () => {
        it('deletes only this turn’s rows, leaves others intact', async () => {
            const sid = 'sess-1';
            await appendEvent(store, { sessionId: sid, turnId: 'turn-1', seq: 1, payload: '{}' });
            await appendEvent(store, { sessionId: sid, turnId: 'turn-1', seq: 2, payload: '{}' });
            await appendEvent(store, { sessionId: sid, turnId: 'turn-2', seq: 3, payload: '{}' });
            await appendEvent(store, { sessionId: 'sess-other', turnId: 'turn-1', seq: 1, payload: '{}' });
            await clearTurnEvents(store, sid, 'turn-1');
            const remaining = store.dump(COL_EVENTS).filter((d) => 'sessionId' in d);
            expect(remaining).toHaveLength(2);
            const survivedKeys = remaining
                .map((d) => `${d.sessionId}:${d.turnId}`)
                .sort();
            expect(survivedKeys).toEqual(['sess-1:turn-2', 'sess-other:turn-1']);
        });
        it('preserves the per-session counter doc when clearing a turn', async () => {
            await nextEventSeq(store, 'sess-1');
            await nextEventSeq(store, 'sess-1');
            await appendEvent(store, {
                sessionId: 'sess-1',
                turnId: 'turn-1',
                seq: 1,
                payload: '{}',
            });
            await clearTurnEvents(store, 'sess-1', 'turn-1');
            const eventRows = store.dump(COL_EVENTS).filter((d) => 'sessionId' in d);
            expect(eventRows).toEqual([]);
            const counter = store.inspect(COL_EVENTS, eventSeqCounterId('sess-1')) as {
                n: number;
            };
            expect(counter.n).toBe(2);
            const next = await nextEventSeq(store, 'sess-1');
            expect(next).toBe(3);
        });
        it('is a no-op when no rows match', async () => {
            await expect(clearTurnEvents(store, 'sess-x', 'turn-x')).resolves.toBeUndefined();
        });
    });
    describe('injectEventId', () => {
        it('replaces existing _eventId field', () => {
            const out = injectEventId('{"_eventId": 42,"type":"text_delta","delta":"a"}', 99);
            expect(JSON.parse(out)._eventId).toBe(99);
        });
        it('inserts _eventId on payload that lacks one', () => {
            const out = injectEventId('{"type":"text_delta","delta":"a"}', 7);
            const parsed = JSON.parse(out);
            expect(parsed._eventId).toBe(7);
            expect(parsed.type).toBe('text_delta');
            expect(parsed.delta).toBe('a');
        });
        it('handles empty object', () => {
            const out = injectEventId('{}', 1);
            expect(JSON.parse(out)).toEqual({ _eventId: 1 });
        });
        it('handles object with leading whitespace inside braces', () => {
            const out = injectEventId('{   }', 5);
            expect(JSON.parse(out)).toEqual({ _eventId: 5 });
        });
        it('handles _eventId with arbitrary spacing after colon', () => {
            const out = injectEventId('{"_eventId":   42, "type":"a"}', 1);
            expect(JSON.parse(out)._eventId).toBe(1);
        });
        it('preserves all other fields verbatim', () => {
            const orig = JSON.stringify({
                type: 'tool_use',
                id: 'tc-abc',
                nested: { foo: 'bar', n: 5 },
                arr: [1, 2, 3],
            });
            const out = injectEventId(orig, 12);
            const parsed = JSON.parse(out);
            expect(parsed._eventId).toBe(12);
            expect(parsed.type).toBe('tool_use');
            expect(parsed.id).toBe('tc-abc');
            expect(parsed.nested).toEqual({ foo: 'bar', n: 5 });
            expect(parsed.arr).toEqual([1, 2, 3]);
        });
        it('returns input unchanged when payload lacks an opening brace', () => {
            const malformed = 'not-json';
            const out = injectEventId(malformed, 1);
            expect(out).toBe(malformed);
        });
    });
});
