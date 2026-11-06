import { describe, expect, it, vi } from 'vitest';
import { createMongoDocStore, type MongoDbLike } from '../adapters/mongo-doc-store.js';
import { objectIdConverter } from '../adapters/mongo-object-id.js';
import { createDocStoreSubagentStore } from '../subagent-store.js';
import { ObjectId } from './object-id.js';
const sessionId = '0123456789abcdef01234567';
const runId = 'abcdef0123456789abcdef01';
function fixture() {
    const col = {
        insertOne: vi.fn(async () => ({})),
        updateOne: vi.fn(async () => ({ matchedCount: 1, modifiedCount: 1, upsertedCount: 0 })),
        findOne: vi.fn(async () => null),
        findOneAndUpdate: vi.fn(async () => null),
        deleteMany: vi.fn(async () => ({ deletedCount: 1 })),
    };
    const createPk = vi.fn(() => new ObjectId());
    const db = { s: { pkFactory: { createPk } }, collection: () => col };
    return { col, createPk, store: createMongoDocStore({ db: db as unknown as MongoDbLike }) };
}
describe('driver-neutral BSON boundary', () => {
    it('discovers and caches a constructor from the default primary-key factory', () => {
        const createPk = vi.fn(() => new ObjectId());
        const convert = objectIdConverter({ s: { pkFactory: { createPk } } });
        expect(convert('ordinary-id')).toBe('ordinary-id');
        expect(createPk).not.toHaveBeenCalled();
        expect(convert(runId)).toEqual(new ObjectId(runId));
        expect(convert(sessionId)).toEqual(new ObjectId(sessionId));
        expect(createPk).toHaveBeenCalledTimes(1);
    });
    it('supports explicit factories and reports unsupported wrappers clearly', () => {
        expect(objectIdConverter({}, hex => new ObjectId(hex))(runId)).toEqual(new ObjectId(runId));
        expect(() => objectIdConverter({})(runId)).toThrow('pass toObjectId');
    });
    it('encodes subagent identities but preserves arbitrary payload strings and BSON instances', async () => {
        const { store, col } = fixture();
        const now = new Date();
        const existing = new ObjectId(runId);
        const doc = { _id: runId, sessionId, messages: [{ _id: runId, text: sessionId }], now, existing };
        await store.insertOne('subagent_runs', doc);
        expect(col.insertOne.mock.calls[0]?.[0]).toEqual({ ...doc, _id: existing, sessionId: new ObjectId(sessionId) });
        expect(doc._id).toBe(runId);
        await store.insertOne('sessions', { _id: sessionId });
        expect(col.insertOne.mock.calls[1]?.[0]).toEqual({ _id: sessionId });
        await store.findOne('subagent_runs', { $or: [{ _id: { $in: [runId, existing] } }, { sessionId }] });
        expect(col.findOne.mock.calls[0]?.[0]).toEqual({ $or: [{ _id: { $in: [existing, existing] } }, { sessionId: new ObjectId(sessionId) }] });
        await store.findOne('sessions', {
            $and: [
                { 'activeSubagentTurn.runIds': { $in: [runId, existing] } },
                { activeSubagentTurn: { runIds: { $in: [runId] } } },
            ],
        });
        expect(col.findOne.mock.calls[1]?.[0]).toEqual({
            $and: [
                { 'activeSubagentTurn.runIds': { $in: [existing, existing] } },
                { activeSubagentTurn: { runIds: { $in: [existing] } } },
            ],
        });
    });
    it('keeps anchor set, append, pull and conditional cleanup operands BSON-compatible', async () => {
        const { store, col } = fixture();
        for (const update of [
            { $set: { activeSubagentTurn: { parentTurnId: runId, runIds: [runId] } } },
            { $addToSet: { 'activeSubagentTurn.runIds': { $each: [runId] } } },
            { $pull: { 'activeSubagentTurn.runIds': runId } },
        ])
            await store.updateOne('sessions', { _id: sessionId }, update);
        expect(col.updateOne.mock.calls.map(call => call[1])).toEqual([
            { $set: { activeSubagentTurn: { parentTurnId: runId, runIds: [new ObjectId(runId)] } } },
            { $addToSet: { 'activeSubagentTurn.runIds': { $each: [new ObjectId(runId)] } } },
            { $pull: { 'activeSubagentTurn.runIds': new ObjectId(runId) } },
        ]);
        await store.updateOne('sessions', { _id: sessionId, 'activeSubagentTurn.runIds': { $size: 0 } }, { $unset: { activeSubagentTurn: '' } });
        expect(col.updateOne.mock.calls[3]?.[0]).toEqual({ _id: new ObjectId(sessionId), 'activeSubagentTurn.runIds': { $size: 0 } });
    });
    it('stores generated subagent IDs as BSON and removes the same BSON ID on finalize', async () => {
        const { store, col } = fixture();
        const subagents = createDocStoreSubagentStore(store);
        const { subagentId } = await subagents.insertRun({ sessionId, parentTurnId: 'turn', parentAssistantSnapshot: { type: 'assistant', content: '' }, toolCallId: 'tool', profileName: 'worker', task: 'task', initialMessages: [] });
        expect(subagentId).toMatch(/^[a-f0-9]{24}$/);
        const row = col.insertOne.mock.calls[0]?.[0] as any;
        expect(row._id).toEqual(new ObjectId(subagentId));
        expect(row.sessionId).toEqual(new ObjectId(sessionId));
        const anchor = (col.updateOne.mock.calls[0]?.[1] as any).$set.activeSubagentTurn;
        expect(anchor.runIds).toEqual([row._id]);
        await subagents.finalize({ subagentId, sessionId, status: 'complete' });
        expect(col.updateOne.mock.calls[2]?.[1]).toEqual({ $pull: { 'activeSubagentTurn.runIds': row._id } });
    });
});
