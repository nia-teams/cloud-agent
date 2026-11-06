import type { MongoCollectionLike } from '../../adapters/mongo-doc-store.js';
import { objectIdConverter, type ToObjectId } from '../../adapters/mongo-object-id.js';
import type { ScheduleStore, ScheduleSpec, ClaimedJob, } from '../types.js';
export interface NestedScheduleFields {
    schedule?: string;
    nextRun?: string;
}
export interface CreateNestedScheduleStoreOpts<TDoc extends object, TItem, P> {
    collection: Pick<MongoCollectionLike<TDoc>, 'findOne' | 'updateOne'>;
    arrayField: string;
    idField: string;
    toSpec: (item: TItem) => ScheduleSpec;
    payloadFn: (doc: TDoc, item: TItem) => P;
    toObjectId?: ToObjectId;
    fields?: NestedScheduleFields;
}
export function createNestedScheduleStore<TDoc extends object, TItem = unknown, P = unknown>(opts: CreateNestedScheduleStoreOpts<TDoc, TItem, P>): ScheduleStore<P> {
    const col = opts.collection;
    const toOid = objectIdConverter(col, opts.toObjectId);
    const arr = opts.arrayField;
    const idField = opts.idField;
    const nextRunField = opts.fields?.nextRun ?? 'nextRun';
    function splitJobId(jobId: string): {
        docIdStr: string;
        innerId: string;
    } {
        const idx = jobId.indexOf(':');
        if (idx < 0)
            return { docIdStr: jobId, innerId: '' };
        return { docIdStr: jobId.slice(0, idx), innerId: jobId.slice(idx + 1) };
    }
    return {
        async claimDueJob(now, leaseUntil): Promise<ClaimedJob<P> | null> {
            const dueDotted = `${arr}.${nextRunField}`;
            const doc = (await col.findOne({
                [dueDotted]: { $lte: now, $ne: null },
            })) as TDoc | null;
            if (!doc)
                return null;
            const items = (doc as Record<string, unknown>)[arr] as TItem[] | undefined;
            if (!Array.isArray(items))
                return null;
            const due = items.find((j) => {
                const t = (j as Record<string, unknown>)[nextRunField] as Date | string | number | null | undefined;
                if (t == null)
                    return false;
                return new Date(t).getTime() <= now.getTime();
            });
            if (!due)
                return null;
            const innerId = (due as Record<string, unknown>)[idField] as string;
            const res = await col.updateOne({
                _id: (doc as unknown as {
                    _id: unknown;
                })._id,
                [arr]: {
                    $elemMatch: {
                        [idField]: innerId,
                        [nextRunField]: { $lte: now },
                    },
                },
            }, {
                $set: {
                    [`${arr}.$.${nextRunField}`]: leaseUntil,
                    updatedAt: new Date(),
                },
            } as never);
            if (res.modifiedCount === 0)
                return null;
            const docId = (doc as unknown as {
                _id: unknown;
            })._id;
            const docIdHex = docId && typeof (docId as {
                toHexString?: unknown;
            }).toHexString === 'function'
                ? (docId as {
                    toHexString(): string;
                }).toHexString()
                : String(docId);
            return {
                jobId: `${docIdHex}:${innerId}`,
                schedule: opts.toSpec(due),
                payload: opts.payloadFn(doc, due),
            };
        },
        async advance(jobId, nextRun) {
            const { docIdStr, innerId } = splitJobId(jobId);
            const docId = toOid(docIdStr);
            if (nextRun === null) {
                await col.updateOne({ _id: docId }, {
                    $pull: { [arr]: { [idField]: innerId } },
                    $set: { updatedAt: new Date() },
                } as never);
                return;
            }
            await col.updateOne({ _id: docId }, {
                $set: {
                    [`${arr}.$[elem].${nextRunField}`]: nextRun,
                    updatedAt: new Date(),
                },
            } as never, { arrayFilters: [{ [`elem.${idField}`]: innerId }] });
        },
        async retry(jobId, retryAt) {
            const { docIdStr, innerId } = splitJobId(jobId);
            const docId = toOid(docIdStr);
            await col.updateOne({ _id: docId }, {
                $set: {
                    [`${arr}.$[elem].${nextRunField}`]: retryAt,
                    updatedAt: new Date(),
                },
            } as never, { arrayFilters: [{ [`elem.${idField}`]: innerId }] });
        },
    };
}
