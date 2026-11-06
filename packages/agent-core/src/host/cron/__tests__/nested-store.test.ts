import { describe, it, expect } from 'vitest';
import { ObjectId } from '../../__tests__/object-id.js';
import { createNestedScheduleStore } from '../stores/nested.js';
import type { ScheduleSpec } from '../types.js';
interface MockItem {
    id: string;
    schedule: {
        type: string;
        value?: string;
    };
    nextRunAt: Date | null;
    prompt?: string;
}
interface MockDoc {
    _id: ObjectId;
    uid?: ObjectId;
    jobs: MockItem[];
    updatedAt?: Date;
}
class MockCollection {
    docs: MockDoc[] = [];
    seed(d: MockDoc) {
        this.docs.push(d);
    }
    async findOne(filter: any): Promise<MockDoc | null> {
        const dueDotted = filter['jobs.nextRunAt'];
        for (const d of this.docs) {
            if (filter._id && !filter._id.equals(d._id))
                continue;
            if (dueDotted) {
                const lte = dueDotted.$lte as Date | undefined;
                const ne = dueDotted.$ne;
                const hasMatch = d.jobs.some((j) => {
                    if (ne === null && j.nextRunAt == null)
                        return false;
                    if (lte && (j.nextRunAt == null || j.nextRunAt.getTime() > lte.getTime()))
                        return false;
                    return j.nextRunAt != null;
                });
                if (!hasMatch)
                    continue;
            }
            return d;
        }
        return null;
    }
    async updateOne(filter: any, update: any, opts?: any): Promise<{
        modifiedCount: number;
    }> {
        const doc = this.docs.find((d) => filter._id ? filter._id.equals(d._id) : true);
        if (!doc)
            return { modifiedCount: 0 };
        if (filter.jobs && filter.jobs.$elemMatch) {
            const em = filter.jobs.$elemMatch;
            const target = doc.jobs.find((j) => {
                if (j.id !== em.id)
                    return false;
                if (em.nextRunAt?.$lte) {
                    if (j.nextRunAt == null)
                        return false;
                    if (j.nextRunAt.getTime() > em.nextRunAt.$lte.getTime())
                        return false;
                }
                return true;
            });
            if (!target)
                return { modifiedCount: 0 };
            for (const k of Object.keys(update.$set ?? {})) {
                if (k.startsWith('jobs.$.')) {
                    const innerKey = k.slice('jobs.$.'.length);
                    (target as any)[innerKey] = update.$set[k];
                }
                else {
                    (doc as any)[k] = update.$set[k];
                }
            }
            return { modifiedCount: 1 };
        }
        if (update.$pull?.jobs) {
            const cond = update.$pull.jobs;
            doc.jobs = doc.jobs.filter((j) => {
                for (const k of Object.keys(cond)) {
                    if ((j as any)[k] !== cond[k])
                        return true;
                }
                return false;
            });
            if (update.$set)
                Object.assign(doc, update.$set);
            return { modifiedCount: 1 };
        }
        if (opts?.arrayFilters && update.$set) {
            const innerId = opts.arrayFilters[0]['elem.id'];
            const item = doc.jobs.find((j) => j.id === innerId);
            if (!item)
                return { modifiedCount: 0 };
            for (const k of Object.keys(update.$set)) {
                if (k.startsWith('jobs.$[elem].')) {
                    const innerKey = k.slice('jobs.$[elem].'.length);
                    (item as any)[innerKey] = update.$set[k];
                }
                else {
                    (doc as any)[k] = update.$set[k];
                }
            }
            return { modifiedCount: 1 };
        }
        return { modifiedCount: 0 };
    }
}
const SPEC: ScheduleSpec = { type: 'every', value: 60000 };
function makeStore(col: MockCollection) {
    return createNestedScheduleStore<MockDoc, MockItem, {
        uid?: ObjectId;
        prompt: string;
        innerId: string;
    }>({
        collection: col as any,
        toObjectId: hex => new ObjectId(hex),
        arrayField: 'jobs',
        idField: 'id',
        fields: { schedule: 'schedule', nextRun: 'nextRunAt' },
        toSpec: () => SPEC,
        payloadFn: (doc, item) => ({
            uid: doc.uid,
            prompt: item.prompt ?? '',
            innerId: item.id,
        }),
    });
}
describe('createNestedScheduleStore', () => {
    it('claim mutual exclusion · two claimers race same inner item · only one wins', async () => {
        const col = new MockCollection();
        col.seed({
            _id: new ObjectId(),
            jobs: [{ id: 'a', schedule: { type: 'every', value: '60s' }, nextRunAt: new Date(0), prompt: 'hi' }],
        });
        const store = makeStore(col);
        const now = new Date(1000000);
        const lease = new Date(now.getTime() + 60000);
        const a = await store.claimDueJob(now, lease);
        const b = await store.claimDueJob(now, lease);
        expect(a).not.toBeNull();
        expect(b).toBeNull();
        expect(col.docs[0].jobs[0].nextRunAt!.getTime()).toBe(lease.getTime());
    });
    it('lease expiration · after leaseUntil passes, peer re-claims', async () => {
        const col = new MockCollection();
        col.seed({
            _id: new ObjectId(),
            jobs: [{ id: 'a', schedule: { type: 'every', value: '60s' }, nextRunAt: new Date(0) }],
        });
        const store = makeStore(col);
        const t0 = new Date(1000000);
        await store.claimDueJob(t0, new Date(t0.getTime() + 5000));
        const mid = await store.claimDueJob(new Date(t0.getTime() + 2000), new Date(t0.getTime() + 7000));
        expect(mid).toBeNull();
        const t2 = new Date(t0.getTime() + 6000);
        const claim = await store.claimDueJob(t2, new Date(t2.getTime() + 5000));
        expect(claim).not.toBeNull();
    });
    it('advance(null) · $pulls the inner item from jobs[]', async () => {
        const col = new MockCollection();
        col.seed({
            _id: new ObjectId(),
            jobs: [
                { id: 'a', schedule: { type: 'at' }, nextRunAt: new Date(0) },
                { id: 'b', schedule: { type: 'every', value: '60s' }, nextRunAt: null },
            ],
        });
        const store = makeStore(col);
        const claim = await store.claimDueJob(new Date(1000000), new Date(1060000));
        await store.advance(claim!.jobId, null);
        expect(col.docs[0].jobs).toHaveLength(1);
        expect(col.docs[0].jobs[0].id).toBe('b');
    });
    it('advance(date) · arrayFilters $set updates inner nextRunAt', async () => {
        const col = new MockCollection();
        col.seed({
            _id: new ObjectId(),
            jobs: [{ id: 'a', schedule: { type: 'every', value: '60s' }, nextRunAt: new Date(0) }],
        });
        const store = makeStore(col);
        const claim = await store.claimDueJob(new Date(1000000), new Date(1060000));
        const future = new Date(2000000);
        await store.advance(claim!.jobId, future);
        expect(col.docs[0].jobs[0].nextRunAt!.getTime()).toBe(future.getTime());
    });
    it('retry · rewinds inner nextRunAt without removing the item', async () => {
        const col = new MockCollection();
        col.seed({
            _id: new ObjectId(),
            jobs: [{ id: 'a', schedule: { type: 'every', value: '60s' }, nextRunAt: new Date(0) }],
        });
        const store = makeStore(col);
        const claim = await store.claimDueJob(new Date(1000000), new Date(1060000));
        const retryAt = new Date(1500000);
        await store.retry(claim!.jobId, retryAt);
        expect(col.docs[0].jobs).toHaveLength(1);
        expect(col.docs[0].jobs[0].nextRunAt!.getTime()).toBe(retryAt.getTime());
    });
    it('nextRunAt:null items are NOT claimed even when sibling is due', async () => {
        const col = new MockCollection();
        col.seed({
            _id: new ObjectId(),
            jobs: [{ id: 'paused', schedule: { type: 'every', value: '60s' }, nextRunAt: null }],
        });
        const store = makeStore(col);
        const claim = await store.claimDueJob(new Date(1000000), new Date(1060000));
        expect(claim).toBeNull();
    });
    it('payload + jobId encoding · `${docId}:${innerId}` and payloadFn output flow through', async () => {
        const docId = new ObjectId();
        const uid = new ObjectId();
        const col = new MockCollection();
        col.seed({
            _id: docId,
            uid,
            jobs: [{ id: 'inner-x', schedule: { type: 'every', value: '60s' }, nextRunAt: new Date(0), prompt: 'hello' }],
        });
        const store = makeStore(col);
        const claim = await store.claimDueJob(new Date(1000000), new Date(1060000));
        expect(claim).not.toBeNull();
        expect(claim!.jobId).toBe(`${docId.toHexString()}:inner-x`);
        expect(claim!.payload).toEqual({ uid, prompt: 'hello', innerId: 'inner-x' });
    });
});
