import { describe, it, expect, beforeEach, afterEach, vi, } from 'vitest';
import { startCron } from '../cron-scanner.js';
import type { ScheduleStore, ClaimedJob, ScheduleSpec, } from '../types.js';
interface Job {
    id: string;
    schedule: ScheduleSpec;
    nextRun: Date | null;
}
class MemStore implements ScheduleStore {
    jobs = new Map<string, Job>();
    private claimMutex = Promise.resolve();
    seed(j: Job): void {
        this.jobs.set(j.id, { ...j });
    }
    async claimDueJob(now: Date, leaseUntil: Date): Promise<ClaimedJob | null> {
        let release: () => void = () => { };
        const prior = this.claimMutex;
        this.claimMutex = new Promise((r) => (release = r));
        try {
            await prior;
            for (const job of this.jobs.values()) {
                if (job.nextRun != null && job.nextRun.getTime() <= now.getTime()) {
                    job.nextRun = leaseUntil;
                    return {
                        jobId: job.id,
                        schedule: job.schedule,
                        payload: { id: job.id },
                    };
                }
            }
            return null;
        }
        finally {
            release();
        }
    }
    async advance(jobId: string, nextRun: Date | null): Promise<void> {
        const job = this.jobs.get(jobId);
        if (!job)
            return;
        if (nextRun === null) {
            this.jobs.delete(jobId);
            return;
        }
        job.nextRun = nextRun;
    }
    async retry(jobId: string, retryAt: Date): Promise<void> {
        const job = this.jobs.get(jobId);
        if (!job)
            return;
        job.nextRun = retryAt;
    }
}
describe('startCron', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });
    afterEach(() => {
        vi.useRealTimers();
    });
    it('claim mutual exclusion · two scanners share a store · each job fires once', async () => {
        const store = new MemStore();
        for (let i = 0; i < 5; i++) {
            store.seed({
                id: `j${i}`,
                schedule: { type: 'every', value: 3600000 },
                nextRun: new Date(0),
            });
        }
        const fired: string[] = [];
        const onFire = vi.fn(async (job: ClaimedJob) => {
            fired.push(job.jobId);
        });
        const a = startCron({ scheduleStore: store, onFire, intervalMs: 1000 });
        const b = startCron({ scheduleStore: store, onFire, intervalMs: 1000 });
        await vi.runOnlyPendingTimersAsync();
        await vi.advanceTimersByTimeAsync(50);
        expect(fired.sort()).toEqual(['j0', 'j1', 'j2', 'j3', 'j4']);
        expect(new Set(fired).size).toBe(5);
        await a.stop();
        await b.stop();
    });
    it('lease expiration · crashed holder · peer re-acquires after lease passes', async () => {
        const store = new MemStore();
        store.seed({
            id: 'crash',
            schedule: { type: 'every', value: 3600000 },
            nextRun: new Date(0),
        });
        const crashFire = vi.fn(async () => new Promise<void>(() => { }));
        const okFire = vi.fn(async () => { });
        const crashed = startCron({
            scheduleStore: store,
            onFire: crashFire,
            intervalMs: 1000,
            leaseMs: 5000,
            fireTimeoutMs: 1000000,
        });
        await vi.advanceTimersByTimeAsync(50);
        expect(crashFire).toHaveBeenCalledTimes(1);
        expect(store.jobs.get('crash')!.nextRun!.getTime()).toBeGreaterThan(0);
        const peer = startCron({
            scheduleStore: store,
            onFire: okFire,
            intervalMs: 1000,
            leaseMs: 5000,
            fireTimeoutMs: 1000000,
        });
        await vi.advanceTimersByTimeAsync(2000);
        expect(okFire).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(5000);
        expect(okFire).toHaveBeenCalledTimes(1);
        await crashed.stop();
        await peer.stop();
    });
    it('onFire success · advance to calcNextRun', async () => {
        const store = new MemStore();
        store.seed({
            id: 'recurring',
            schedule: { type: 'every', value: 60000 },
            nextRun: new Date(0),
        });
        const onFire = vi.fn(async () => { });
        const handle = startCron({
            scheduleStore: store,
            onFire,
            intervalMs: 60000,
        });
        await vi.runOnlyPendingTimersAsync();
        await vi.advanceTimersByTimeAsync(50);
        const j = store.jobs.get('recurring')!;
        expect(j.nextRun!.getTime()).toBeGreaterThan(Date.now() + 30000);
        await handle.stop();
    });
    it('onFire throw · retry rewind to now+retryMs (idempotent on multiple errors)', async () => {
        const store = new MemStore();
        store.seed({
            id: 'flaky',
            schedule: { type: 'every', value: 600000 },
            nextRun: new Date(0),
        });
        let count = 0;
        const onFire = vi.fn(async () => {
            count++;
            if (count < 3)
                throw new Error('flaky');
        });
        const handle = startCron({
            scheduleStore: store,
            onFire,
            intervalMs: 1000,
            retryMs: 60000,
            leaseMs: 600000,
        });
        await vi.runOnlyPendingTimersAsync();
        await vi.advanceTimersByTimeAsync(50);
        expect(onFire).toHaveBeenCalledTimes(1);
        let nr = store.jobs.get('flaky')!.nextRun!.getTime();
        expect(nr).toBeGreaterThan(Date.now() + 30000);
        expect(nr).toBeLessThan(Date.now() + 120000);
        await vi.advanceTimersByTimeAsync(70000);
        await vi.runOnlyPendingTimersAsync();
        expect(onFire).toHaveBeenCalledTimes(2);
        nr = store.jobs.get('flaky')!.nextRun!.getTime();
        expect(nr).toBeGreaterThan(Date.now() + 30000);
        await vi.advanceTimersByTimeAsync(70000);
        await vi.runOnlyPendingTimersAsync();
        expect(onFire).toHaveBeenCalledTimes(3);
        nr = store.jobs.get('flaky')!.nextRun!.getTime();
        expect(nr).toBeGreaterThan(Date.now() + 500000);
        await handle.stop();
    });
    it('one-shot · advance(null) deletes the job', async () => {
        const store = new MemStore();
        store.seed({
            id: 'oneshot',
            schedule: { type: 'at', at: new Date(0) },
            nextRun: new Date(0),
        });
        const handle = startCron({
            scheduleStore: store,
            onFire: vi.fn(async () => { }),
            intervalMs: 1000,
        });
        await vi.runOnlyPendingTimersAsync();
        await vi.advanceTimersByTimeAsync(50);
        expect(store.jobs.has('oneshot')).toBe(false);
        await handle.stop();
    });
    it('stop · awaits in-flight tick', async () => {
        const store = new MemStore();
        store.seed({
            id: 'pending',
            schedule: { type: 'every', value: 60000 },
            nextRun: new Date(0),
        });
        let resolveFire: () => void = () => { };
        const onFire = vi.fn(() => new Promise<void>((r) => (resolveFire = r)));
        const handle = startCron({
            scheduleStore: store,
            onFire,
            intervalMs: 60000,
            fireTimeoutMs: 60000,
        });
        await vi.runOnlyPendingTimersAsync();
        expect(onFire).toHaveBeenCalledTimes(1);
        const stopPromise = handle.stop();
        await vi.advanceTimersByTimeAsync(0);
        resolveFire();
        await stopPromise;
        expect(store.jobs.get('pending')!.nextRun!.getTime()).toBeGreaterThan(0);
    });
});
