import { describe, it, expect } from 'vitest';
import { ObjectId } from '../../__tests__/object-id.js';
import { createFlatScheduleStore } from '../stores/flat.js';
import type { ScheduleSpec } from '../types.js';
interface MockDoc {
    _id: ObjectId;
    schedule: {
        type: string;
        value?: string;
    };
    nextRun: Date | null;
    enabled?: boolean;
    lastRun?: Date;
    updatedAt?: Date;
}
class MockCollection {
    docs: MockDoc[] = [];
    seed(d: Partial<MockDoc> & {
        _id: ObjectId;
        nextRun: Date | null;
    }) {
        this.docs.push({
            schedule: { type: 'every', value: '60s' },
            enabled: true,
            ...d,
        } as MockDoc);
    }
    async findOneAndUpdate(filter: any, update: any, opts: any): Promise<MockDoc | null> {
        for (const d of this.docs) {
            if (filter.enabled !== undefined && d.enabled !== filter.enabled)
                continue;
            const nr = filter.nextRun;
            if (nr && nr.$lte) {
                if (d.nextRun == null)
                    continue;
                if (d.nextRun.getTime() > nr.$lte.getTime())
                    continue;
            }
            const before = { ...d };
            Object.assign(d, update.$set);
            return opts?.returnDocument === 'before' ? before : d;
        }
        return null;
    }
    async updateOne(filter: any, update: any): Promise<{
        modifiedCount: number;
    }> {
        for (const d of this.docs) {
            if (filter._id && !filter._id.equals(d._id))
                continue;
            Object.assign(d, update.$set);
            return { modifiedCount: 1 };
        }
        return { modifiedCount: 0 };
    }
    async deleteOne(filter: any): Promise<{
        deletedCount: number;
    }> {
        const idx = this.docs.findIndex((d) => filter._id && filter._id.equals(d._id));
        if (idx === -1)
            return { deletedCount: 0 };
        this.docs.splice(idx, 1);
        return { deletedCount: 1 };
    }
}
const SPEC: ScheduleSpec = { type: 'every', value: 60000 };
function makeStore(col: MockCollection, fields?: any) {
    return createFlatScheduleStore<MockDoc, {
        doc: MockDoc;
    }>({
        collection: col as any,
        toObjectId: hex => new ObjectId(hex),
        toSpec: () => SPEC,
        payloadFn: (doc) => ({ doc }),
        fields,
    });
}
describe('createFlatScheduleStore', () => {
    it('claim mutual exclusion · second concurrent claimer sees lease in the future and gets nothing', async () => {
        const col = new MockCollection();
        const id = new ObjectId();
        col.seed({ _id: id, nextRun: new Date(0) });
        const store = makeStore(col);
        const now = new Date(1000000);
        const lease = new Date(now.getTime() + 60000);
        const a = await store.claimDueJob(now, lease);
        const b = await store.claimDueJob(now, lease);
        expect(a).not.toBeNull();
        expect(b).toBeNull();
        expect(col.docs[0].nextRun!.getTime()).toBe(lease.getTime());
    });
    it('lease expiration · after leaseUntil passes, a peer can re-claim', async () => {
        const col = new MockCollection();
        col.seed({ _id: new ObjectId(), nextRun: new Date(0) });
        const store = makeStore(col);
        const t0 = new Date(1000000);
        const lease1 = new Date(t0.getTime() + 5000);
        await store.claimDueJob(t0, lease1);
        const mid = await store.claimDueJob(new Date(t0.getTime() + 2000), lease1);
        expect(mid).toBeNull();
        const t2 = new Date(t0.getTime() + 6000);
        const lease2 = new Date(t2.getTime() + 5000);
        const claim = await store.claimDueJob(t2, lease2);
        expect(claim).not.toBeNull();
    });
    it('advance(null) · drops the doc', async () => {
        const col = new MockCollection();
        const id = new ObjectId();
        col.seed({ _id: id, nextRun: new Date(0) });
        const store = makeStore(col);
        const claim = await store.claimDueJob(new Date(1000000), new Date(1060000));
        await store.advance(claim!.jobId, null);
        expect(col.docs).toHaveLength(0);
    });
    it('advance(date) · updates nextRun and lastRun', async () => {
        const col = new MockCollection();
        const id = new ObjectId();
        col.seed({ _id: id, nextRun: new Date(0) });
        const store = makeStore(col);
        const claim = await store.claimDueJob(new Date(1000000), new Date(1060000));
        const future = new Date(2000000);
        await store.advance(claim!.jobId, future);
        expect(col.docs[0].nextRun!.getTime()).toBe(future.getTime());
        expect(col.docs[0].lastRun).toBeInstanceOf(Date);
    });
    it('retry · rewinds nextRun without dropping', async () => {
        const col = new MockCollection();
        const id = new ObjectId();
        col.seed({ _id: id, nextRun: new Date(0) });
        const store = makeStore(col);
        const claim = await store.claimDueJob(new Date(1000000), new Date(1060000));
        const retryAt = new Date(1500000);
        await store.retry(claim!.jobId, retryAt);
        expect(col.docs).toHaveLength(1);
        expect(col.docs[0].nextRun!.getTime()).toBe(retryAt.getTime());
    });
    it('nextRun:null docs are NOT claimed (filter $lte excludes null)', async () => {
        const col = new MockCollection();
        col.seed({ _id: new ObjectId(), nextRun: null });
        const store = makeStore(col);
        const claim = await store.claimDueJob(new Date(1000000), new Date(1060000));
        expect(claim).toBeNull();
    });
    it('enabled:false docs are NOT claimed', async () => {
        const col = new MockCollection();
        col.seed({ _id: new ObjectId(), nextRun: new Date(0), enabled: false });
        const store = makeStore(col);
        const claim = await store.claimDueJob(new Date(1000000), new Date(1060000));
        expect(claim).toBeNull();
    });
    it('fields remap · custom nextRun field name still drives the CAS filter', async () => {
        class C2 extends MockCollection {
            async findOneAndUpdate(filter: any, update: any, opts: any) {
                const f2 = { ...filter };
                if (f2.nextRunAt) {
                    f2.nextRun = f2.nextRunAt;
                    delete f2.nextRunAt;
                }
                const u2 = { ...update, $set: { ...update.$set } };
                if (u2.$set.nextRunAt) {
                    u2.$set.nextRun = u2.$set.nextRunAt;
                    delete u2.$set.nextRunAt;
                }
                return super.findOneAndUpdate(f2, u2, opts);
            }
        }
        const col = new C2();
        col.seed({ _id: new ObjectId(), nextRun: new Date(0) });
        const store = makeStore(col, { nextRun: 'nextRunAt' });
        const claim = await store.claimDueJob(new Date(1000000), new Date(1060000));
        expect(claim).not.toBeNull();
    });
    it('disabled-guard off · fields.enabled=null skips the enabled filter', async () => {
        const col = new MockCollection();
        col.seed({ _id: new ObjectId(), nextRun: new Date(0), enabled: false });
        const store = makeStore(col, { enabled: null });
        const claim = await store.claimDueJob(new Date(1000000), new Date(1060000));
        expect(claim).not.toBeNull();
    });
});
