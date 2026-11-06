import { objectIdConverter, type ToObjectId } from './mongo-object-id.js';
import type { DocStore } from '../types.js';
export interface MongoCursorLike<T> {
    project(projection: Record<string, unknown>): MongoCursorLike<T>;
    sort(sort: Record<string, 1 | -1>): MongoCursorLike<T>;
    limit(limit: number): MongoCursorLike<T>;
    toArray(): Promise<T[]>;
}
export interface MongoCollectionLike<T = Record<string, unknown>> {
    insertOne(doc: any): Promise<unknown>;
    updateOne(filter: any, update: any, options?: any): Promise<{
        matchedCount: number;
        modifiedCount: number;
        upsertedCount: number;
    }>;
    findOne(filter: any, options?: any): Promise<T | null>;
    find(filter: any): MongoCursorLike<T>;
    findOneAndUpdate(filter: any, update: any, options?: any): Promise<unknown>;
    deleteMany(filter: any): Promise<{
        deletedCount: number;
    }>;
    deleteOne(filter: any): Promise<{
        deletedCount: number;
    }>;
}
export interface MongoDbLike {
    collection(name: string): MongoCollectionLike;
}
export interface CreateMongoDocStoreOpts {
    db: MongoDbLike;
    toObjectId?: ToObjectId;
}
export function createMongoDocStore(opts: CreateMongoDocStoreOpts): DocStore {
    const { db } = opts;
    const toObjectId = objectIdConverter(db, opts.toObjectId);
    const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype;
    const IDENTITY_OPS = new Set(['$eq', '$ne', '$in', '$nin', '$each']);
    function identity(value: unknown): unknown {
        if (typeof value === 'string')
            return toObjectId(value);
        if (Array.isArray(value))
            return value.map(identity);
        if (isRecord(value))
            return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, IDENTITY_OPS.has(key) ? identity(item) : item]));
        return value;
    }
    function fields(value: Record<string, unknown>, collection: string): Record<string, unknown> {
        return Object.fromEntries(Object.entries(value).map(([key, item]) => {
            if (key === '_id' || (collection === 'subagent_runs' && key === 'sessionId') ||
                key === 'activeSubagentTurn.runIds')
                return [key, identity(item)];
            if (key === 'activeSubagentTurn' && isRecord(item) && 'runIds' in item)
                return [key, { ...item, runIds: identity(item.runIds) }];
            if (['$and', '$or', '$nor'].includes(key) && Array.isArray(item))
                return [key, item.map(part => isRecord(part) ? fields(part, collection) : part)];
            return [key, item];
        }));
    }
    function coerceFilter(collection: string, filter: Record<string, unknown>) {
        return fields(filter, collection);
    }
    function coerceUpdate(collection: string, update: Record<string, unknown>) {
        return Object.fromEntries(Object.entries(update).map(([key, value]) => [key, isRecord(value) && ['$set', '$setOnInsert', '$addToSet', '$push', '$pull', '$pullAll'].includes(key)
                ? fields(value, collection) : value]));
    }
    return {
        async insertOne(collection, doc) {
            const col = db.collection(collection);
            await col.insertOne(collection === 'subagent_runs' ? fields(doc, collection) : doc);
        },
        async updateOne(collection, filter, update, opts2) {
            const col = db.collection(collection);
            const result = await col.updateOne(coerceFilter(collection, filter), coerceUpdate(collection, update), opts2?.upsert ? { upsert: true } : {});
            return {
                matchedCount: result.matchedCount,
                modifiedCount: result.modifiedCount,
                upserted: result.upsertedCount > 0,
            };
        },
        async findOne(collection, filter, opts2) {
            const col = db.collection(collection);
            const findOpts: Record<string, unknown> = {};
            if (opts2?.projection)
                findOpts.projection = opts2.projection;
            const doc = await col.findOne(coerceFilter(collection, filter), findOpts);
            return (doc ?? null) as never;
        },
        async find(collection, filter, opts2) {
            const col = db.collection(collection);
            let cursor = col.find(coerceFilter(collection, filter));
            if (opts2?.projection)
                cursor = cursor.project(opts2.projection);
            if (opts2?.sort)
                cursor = cursor.sort(opts2.sort);
            if (opts2?.limit !== undefined)
                cursor = cursor.limit(opts2.limit);
            const docs = await cursor.toArray();
            return docs as never[];
        },
        async findOneAndUpdate(collection, filter, update, opts2) {
            const col = db.collection(collection);
            const driverOpts: Record<string, unknown> = {
                returnDocument: opts2?.returnDocument ?? 'after',
            };
            if (opts2?.upsert)
                driverOpts.upsert = true;
            if (opts2?.projection)
                driverOpts.projection = opts2.projection;
            const result: unknown = await col.findOneAndUpdate(coerceFilter(collection, filter), coerceUpdate(collection, update), driverOpts);
            if (result == null)
                return null;
            if (typeof result === 'object' &&
                result !== null &&
                'value' in (result as Record<string, unknown>) &&
                ((result as Record<string, unknown>).value !== undefined ||
                    'lastErrorObject' in (result as Record<string, unknown>))) {
                return ((result as Record<string, unknown>).value ?? null) as never;
            }
            return result as never;
        },
        async deleteMany(collection, filter) {
            const col = db.collection(collection);
            const result = await col.deleteMany(coerceFilter(collection, filter));
            return { deletedCount: result.deletedCount };
        },
    };
}
