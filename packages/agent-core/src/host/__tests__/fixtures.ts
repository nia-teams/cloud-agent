import type { DocStore, PubSub } from '../types.js';
import { isDeepStrictEqual } from 'node:util';
type Doc = Record<string, unknown>;
function getPath(obj: Doc, path: string): unknown {
    if (!path.includes('.'))
        return obj[path];
    const parts = path.split('.');
    let cur: unknown = obj;
    for (const p of parts) {
        if (cur == null || typeof cur !== 'object')
            return undefined;
        cur = (cur as Record<string, unknown>)[p];
    }
    return cur;
}
function setPath(obj: Doc, path: string, value: unknown): void {
    if (!path.includes('.')) {
        obj[path] = value;
        return;
    }
    const parts = path.split('.');
    let cur: Record<string, unknown> = obj;
    for (let i = 0; i < parts.length - 1; i++) {
        const k = parts[i];
        const next = cur[k];
        if (next == null || typeof next !== 'object') {
            cur[k] = {};
        }
        cur = cur[k] as Record<string, unknown>;
    }
    cur[parts[parts.length - 1]] = value;
}
function unsetPath(obj: Doc, path: string): void {
    if (!path.includes('.')) {
        delete obj[path];
        return;
    }
    const parts = path.split('.');
    let cur: Record<string, unknown> = obj;
    for (let i = 0; i < parts.length - 1; i++) {
        const k = parts[i];
        const next = cur[k];
        if (next == null || typeof next !== 'object')
            return;
        cur = next as Record<string, unknown>;
    }
    delete cur[parts[parts.length - 1]];
}
function matchOne(doc: Doc, filterKey: string, filterVal: unknown): boolean {
    if (/^[a-zA-Z_$][\w$]*\.\d+$/.test(filterKey)) {
        const [arrKey, idxStr] = filterKey.split('.');
        const arr = doc[arrKey];
        const idx = Number(idxStr);
        const exists = Array.isArray(arr) && arr.length > idx;
        if (filterVal &&
            typeof filterVal === 'object' &&
            '$exists' in (filterVal as Record<string, unknown>)) {
            return Boolean((filterVal as {
                $exists: boolean;
            }).$exists) === exists;
        }
        if (!exists)
            return false;
    }
    const docVal = getPath(doc, filterKey);
    if (filterVal === null) {
        return docVal == null;
    }
    if (filterVal instanceof ObjectId) {
        if (docVal instanceof ObjectId)
            return docVal.equals(filterVal);
        return false;
    }
    if (filterVal &&
        typeof filterVal === 'object' &&
        !Array.isArray(filterVal)) {
        const ops = filterVal as Record<string, unknown>;
        for (const [op, v] of Object.entries(ops)) {
            switch (op) {
                case '$eq':
                    if (!isDeepStrictEqual(docVal, v))
                        return false;
                    break;
                case '$exists':
                    if (Boolean(v) !== (docVal !== undefined))
                        return false;
                    break;
                case '$lt':
                    if (!(docVal != null && (docVal as number | Date) < (v as number | Date))) {
                        return false;
                    }
                    break;
                case '$gt':
                    if (!(docVal != null && (docVal as number | Date) > (v as number | Date))) {
                        return false;
                    }
                    break;
                case '$lte':
                    if (!(docVal != null && (docVal as number | Date) <= (v as number | Date))) {
                        return false;
                    }
                    break;
                case '$size':
                    if (!Array.isArray(docVal) || docVal.length !== v)
                        return false;
                    break;
                default:
                    throw new Error(`MemoryDocStore: unsupported op ${op}`);
            }
        }
        return true;
    }
    if (Array.isArray(filterVal))
        return isDeepStrictEqual(docVal, filterVal);
    return docVal === filterVal;
}
function matches(doc: Doc, filter: Record<string, unknown>): boolean {
    for (const [key, val] of Object.entries(filter)) {
        if (key === '$or') {
            const branches = val as Array<Record<string, unknown>>;
            if (!branches.some((b) => matches(doc, b)))
                return false;
            continue;
        }
        if (key === '$and') {
            const branches = val as Array<Record<string, unknown>>;
            if (!branches.every((b) => matches(doc, b)))
                return false;
            continue;
        }
        if (!matchOne(doc, key, val))
            return false;
    }
    return true;
}
function applyUpdate(doc: Doc, update: Record<string, unknown>): void {
    const $set = update.$set as Record<string, unknown> | undefined;
    if ($set) {
        for (const [k, v] of Object.entries($set))
            setPath(doc, k, v);
    }
    const $setOnInsert = update.$setOnInsert as Record<string, unknown> | undefined;
    if ($setOnInsert) {
        for (const [k, v] of Object.entries($setOnInsert)) {
            if (getPath(doc, k) === undefined)
                setPath(doc, k, v);
        }
    }
    const $push = update.$push as Record<string, unknown> | undefined;
    if ($push) {
        for (const [k, v] of Object.entries($push)) {
            const cur = getPath(doc, k);
            const arr = Array.isArray(cur) ? [...cur] : [];
            if (v &&
                typeof v === 'object' &&
                '$each' in (v as Record<string, unknown>)) {
                const items = (v as {
                    $each: unknown[];
                }).$each;
                if (Array.isArray(items))
                    arr.push(...items);
            }
            else {
                arr.push(v);
            }
            setPath(doc, k, arr);
        }
    }
    const $unset = update.$unset as Record<string, unknown> | undefined;
    if ($unset) {
        for (const k of Object.keys($unset))
            unsetPath(doc, k);
    }
    const $addToSet = update.$addToSet as Record<string, unknown> | undefined;
    if ($addToSet) {
        for (const [k, v] of Object.entries($addToSet)) {
            const cur = getPath(doc, k);
            const arr = Array.isArray(cur) ? [...cur] : [];
            const jv = JSON.stringify(v);
            if (!arr.some((x) => JSON.stringify(x) === jv))
                arr.push(v);
            setPath(doc, k, arr);
        }
    }
    const $pull = update.$pull as Record<string, unknown> | undefined;
    if ($pull) {
        for (const [k, v] of Object.entries($pull)) {
            const cur = getPath(doc, k);
            if (!Array.isArray(cur))
                continue;
            const jv = JSON.stringify(v);
            const next = cur.filter((x) => JSON.stringify(x) !== jv);
            setPath(doc, k, next);
        }
    }
    const $inc = update.$inc as Record<string, number> | undefined;
    if ($inc) {
        for (const [k, v] of Object.entries($inc)) {
            const cur = getPath(doc, k);
            const next = (typeof cur === 'number' ? cur : 0) + v;
            setPath(doc, k, next);
        }
    }
}
function projectDoc(doc: Doc, projection: Record<string, 0 | 1> | undefined): Doc {
    if (!projection)
        return doc;
    const incl = Object.values(projection).every((v) => v === 1);
    const out: Doc = {};
    if (incl) {
        if (doc._id !== undefined)
            out._id = doc._id;
        for (const k of Object.keys(projection)) {
            if (projection[k] === 1) {
                const v = getPath(doc, k);
                if (v !== undefined)
                    out[k] = v;
            }
        }
        return out;
    }
    const excl = new Set(Object.keys(projection).filter((k) => projection[k] === 0));
    for (const k of Object.keys(doc)) {
        if (!excl.has(k))
            out[k] = doc[k];
    }
    return out;
}
import { ObjectId } from './object-id.js';
function deepClone<T>(v: T): T {
    if (v === null || typeof v !== 'object')
        return v;
    if (v instanceof ObjectId)
        return new ObjectId(v) as unknown as T;
    if (v instanceof Date)
        return new Date(v.getTime()) as unknown as T;
    if (Array.isArray(v))
        return v.map((x) => deepClone(x)) as unknown as T;
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        out[k] = deepClone(val);
    }
    return out as T;
}
class AsyncMutex {
    private p: Promise<void> = Promise.resolve();
    async run<T>(fn: () => Promise<T> | T): Promise<T> {
        const prev = this.p;
        let release: () => void = () => { };
        this.p = new Promise((r) => (release = r));
        try {
            await prev;
            return await fn();
        }
        finally {
            release();
        }
    }
}
export interface MemoryDocStoreHooks {
    failNextFindOneAndUpdate?: number;
    failNextUpdateOne?: number;
    failNextDeleteMany?: number;
}
export interface MockMemoryDocStore extends DocStore {
    inspect(collection: string, id: string): Doc | undefined;
    seed(collection: string, doc: Doc): void;
    dump(collection: string): Doc[];
    forceNextFindOneAndUpdateMiss(): void;
    forceNextUpdateOneMiss(): void;
    forceNextDeleteManyFailure(): void;
}
export function createMemoryDocStore(): MockMemoryDocStore {
    const collections = new Map<string, Map<string, Doc>>();
    const mutex = new AsyncMutex();
    let forceFOUMiss = 0;
    let forceUOMiss = 0;
    let forceDeleteFailure = 0;
    function getCol(name: string): Map<string, Doc> {
        let c = collections.get(name);
        if (!c) {
            c = new Map();
            collections.set(name, c);
        }
        return c;
    }
    return {
        async insertOne(collection, doc) {
            await mutex.run(() => {
                const col = getCol(collection);
                const cloned = deepClone(doc as Doc);
                if (cloned._id === undefined) {
                    cloned._id = `auto-${Math.random().toString(36).slice(2, 12)}`;
                }
                const id = String(cloned._id);
                if (col.has(id)) {
                    throw new Error(`duplicate _id: ${id}`);
                }
                col.set(id, cloned);
            });
        },
        async updateOne(collection, filter, update, opts) {
            return mutex.run(() => {
                if (forceUOMiss > 0) {
                    forceUOMiss--;
                    return { matchedCount: 0, modifiedCount: 0, upserted: false };
                }
                const col = getCol(collection);
                for (const doc of col.values()) {
                    if (matches(doc, filter)) {
                        applyUpdate(doc, update);
                        return { matchedCount: 1, modifiedCount: 1, upserted: false };
                    }
                }
                if (opts?.upsert) {
                    const newDoc: Doc = {};
                    for (const [k, v] of Object.entries(filter)) {
                        if (k === '$or' || k === '$and')
                            continue;
                        if (v != null &&
                            typeof v === 'object' &&
                            !Array.isArray(v)) {
                            continue;
                        }
                        setPath(newDoc, k, v);
                    }
                    applyUpdate(newDoc, update);
                    const $soi = update.$setOnInsert as Record<string, unknown> | undefined;
                    if ($soi) {
                        for (const [k, v] of Object.entries($soi)) {
                            if (getPath(newDoc, k) === undefined)
                                setPath(newDoc, k, v);
                        }
                    }
                    if (newDoc._id === undefined) {
                        throw new Error('upsert without _id in filter');
                    }
                    col.set(String(newDoc._id), newDoc);
                    return { matchedCount: 0, modifiedCount: 0, upserted: true };
                }
                return { matchedCount: 0, modifiedCount: 0, upserted: false };
            });
        },
        async findOne(collection, filter, opts) {
            return mutex.run(() => {
                const col = getCol(collection);
                for (const doc of col.values()) {
                    if (matches(doc, filter)) {
                        return deepClone(projectDoc(doc, opts?.projection)) as never;
                    }
                }
                return null;
            });
        },
        async find(collection, filter, opts) {
            return mutex.run(() => {
                const col = getCol(collection);
                let arr: Doc[] = [];
                for (const doc of col.values()) {
                    if (matches(doc, filter))
                        arr.push(doc);
                }
                if (opts?.sort) {
                    const sortKeys = Object.entries(opts.sort);
                    arr = [...arr].sort((a, b) => {
                        for (const [k, dir] of sortKeys) {
                            const av = getPath(a, k);
                            const bv = getPath(b, k);
                            if (av == null && bv == null)
                                continue;
                            if (av == null)
                                return -1 * (dir as number);
                            if (bv == null)
                                return 1 * (dir as number);
                            if (av < bv)
                                return -1 * (dir as number);
                            if (av > bv)
                                return 1 * (dir as number);
                        }
                        return 0;
                    });
                }
                if (opts?.limit !== undefined)
                    arr = arr.slice(0, opts.limit);
                return arr.map((d) => deepClone(projectDoc(d, opts?.projection))) as never[];
            });
        },
        async findOneAndUpdate(collection, filter, update, opts) {
            return mutex.run(() => {
                if (forceFOUMiss > 0) {
                    forceFOUMiss--;
                    return null;
                }
                const col = getCol(collection);
                let target: Doc | undefined;
                for (const doc of col.values()) {
                    if (matches(doc, filter)) {
                        target = doc;
                        break;
                    }
                }
                const returnDoc = opts?.returnDocument ?? 'after';
                if (target) {
                    const before = deepClone(target);
                    applyUpdate(target, update);
                    const after = target;
                    const out = returnDoc === 'before' ? before : deepClone(after);
                    return projectDoc(out, opts?.projection) as never;
                }
                if (opts?.upsert) {
                    const newDoc: Doc = {};
                    for (const [k, v] of Object.entries(filter)) {
                        if (k === '$or' || k === '$and')
                            continue;
                        if (v != null && typeof v === 'object' && !Array.isArray(v))
                            continue;
                        setPath(newDoc, k, v);
                    }
                    applyUpdate(newDoc, update);
                    if (newDoc._id === undefined) {
                        newDoc._id = `gen-${Math.random().toString(36).slice(2, 10)}`;
                    }
                    col.set(String(newDoc._id), newDoc);
                    return projectDoc(deepClone(newDoc), opts?.projection) as never;
                }
                return null;
            });
        },
        async deleteMany(collection, filter) {
            return mutex.run(() => {
                if (forceDeleteFailure > 0) {
                    forceDeleteFailure--;
                    throw new Error('forced deleteMany failure');
                }
                const col = getCol(collection);
                const toDelete: string[] = [];
                for (const [id, doc] of col.entries()) {
                    if (matches(doc, filter))
                        toDelete.push(id);
                }
                for (const id of toDelete)
                    col.delete(id);
                return { deletedCount: toDelete.length };
            });
        },
        inspect(collection, id) {
            const col = collections.get(collection);
            const d = col?.get(id);
            return d ? deepClone(d) : undefined;
        },
        seed(collection, doc) {
            const col = getCol(collection);
            col.set(String(doc._id), deepClone(doc));
        },
        dump(collection) {
            return Array.from(getCol(collection).values()).map((d) => deepClone(d));
        },
        forceNextFindOneAndUpdateMiss() {
            forceFOUMiss++;
        },
        forceNextUpdateOneMiss() {
            forceUOMiss++;
        },
        forceNextDeleteManyFailure() {
            forceDeleteFailure++;
        },
    };
}
export interface MockPubSub extends PubSub {
    published: Array<{
        channel: string;
        payload: string;
    }>;
    subscribers: Array<{
        pattern: string;
        isPattern: boolean;
    }>;
}
export function createMemoryPubSub(): MockPubSub {
    const published: Array<{
        channel: string;
        payload: string;
    }> = [];
    const subscribers: Array<{
        pattern: string;
        isPattern: boolean;
    }> = [];
    const handlers = new Map<string, Array<(channel: string, payload: string) => void>>();
    const phandlers: Array<{
        pattern: RegExp;
        raw: string;
        fn: (channel: string, payload: string) => void;
    }> = [];
    return {
        published,
        subscribers,
        async publish(channel, payload) {
            published.push({ channel, payload });
            for (const fn of handlers.get(channel) ?? []) {
                try {
                    fn(channel, payload);
                }
                catch {
                }
            }
            for (const ph of phandlers) {
                if (ph.pattern.test(channel)) {
                    try {
                        ph.fn(channel, payload);
                    }
                    catch {
                    }
                }
            }
        },
        async subscribe(channel, handler) {
            subscribers.push({ pattern: channel, isPattern: false });
            const wrap = (_c: string, payload: string): void => handler(payload);
            const list = handlers.get(channel) ?? [];
            list.push(wrap);
            handlers.set(channel, list);
            return async () => {
                const arr = handlers.get(channel) ?? [];
                const i = arr.indexOf(wrap);
                if (i >= 0)
                    arr.splice(i, 1);
            };
        },
        async psubscribe(pattern, handler) {
            subscribers.push({ pattern, isPattern: true });
            const re = new RegExp('^' + pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
            const entry = { pattern: re, raw: pattern, fn: handler };
            phandlers.push(entry);
            return async () => {
                const i = phandlers.indexOf(entry);
                if (i >= 0)
                    phandlers.splice(i, 1);
            };
        },
    };
}
export interface MockLogger {
    info: (...a: unknown[]) => void;
    warn: (...a: unknown[]) => void;
    error: (...a: unknown[]) => void;
    debug: (...a: unknown[]) => void;
    records: Array<{
        level: string;
        args: unknown[];
    }>;
}
export function createMockLogger(): MockLogger {
    const records: Array<{
        level: string;
        args: unknown[];
    }> = [];
    const make = (level: string) => (...args: unknown[]) => records.push({ level, args });
    return {
        info: make('info'),
        warn: make('warn'),
        error: make('error'),
        debug: make('debug'),
        records,
    };
}
