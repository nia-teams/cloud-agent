import type { MongoCollectionLike } from '../../adapters/mongo-doc-store.js';
import { objectIdConverter, type ToObjectId } from '../../adapters/mongo-object-id.js';
import type { ScheduleStore, ScheduleSpec, ClaimedJob, } from '../types.js';
export interface FlatScheduleFields {
    nextRun?: string;
    schedule?: string;
    enabled?: string | null;
}
export interface CreateFlatScheduleStoreOpts<TDoc extends object, P> {
    collection: Pick<MongoCollectionLike<TDoc>, 'findOneAndUpdate' | 'updateOne' | 'deleteOne'>;
    toSpec: (doc: TDoc) => ScheduleSpec;
    payloadFn?: (doc: TDoc) => P;
    toObjectId?: ToObjectId;
    fields?: FlatScheduleFields;
}
export function createFlatScheduleStore<TDoc extends object, P = {
    doc: TDoc;
}>(opts: CreateFlatScheduleStoreOpts<TDoc, P>): ScheduleStore<P> {
    const col = opts.collection;
    const toOid = objectIdConverter(col, opts.toObjectId);
    const f = {
        nextRun: opts.fields?.nextRun ?? 'nextRun',
        schedule: opts.fields?.schedule ?? 'schedule',
        enabled: opts.fields?.enabled === undefined ? 'enabled' : opts.fields.enabled,
    };
    const payloadFn = opts.payloadFn ?? ((doc: TDoc) => ({ doc } as unknown as P));
    return {
        async claimDueJob(now, leaseUntil): Promise<ClaimedJob<P> | null> {
            const filter: Record<string, unknown> = {
                [f.nextRun]: { $lte: now },
            };
            if (f.enabled)
                filter[f.enabled] = true;
            const before = (await col.findOneAndUpdate(filter, { $set: { [f.nextRun]: leaseUntil } } as never, { returnDocument: 'before' })) as TDoc | null;
            if (!before)
                return null;
            const idVal = (before as unknown as {
                _id: unknown;
            })._id;
            const jobId = idVal && typeof (idVal as {
                toHexString?: unknown;
            }).toHexString === 'function'
                ? (idVal as {
                    toHexString(): string;
                }).toHexString()
                : String(idVal);
            return {
                jobId,
                schedule: opts.toSpec(before),
                payload: payloadFn(before),
            };
        },
        async advance(jobId, nextRun) {
            const id = toOid(jobId);
            if (nextRun === null) {
                await col.deleteOne({ _id: id });
                return;
            }
            await col.updateOne({ _id: id }, {
                $set: {
                    [f.nextRun]: nextRun,
                    lastRun: new Date(),
                    updatedAt: new Date(),
                },
            } as never);
        },
        async retry(jobId, retryAt) {
            const id = toOid(jobId);
            await col.updateOne({ _id: id }, { $set: { [f.nextRun]: retryAt } } as never);
        },
    };
}
