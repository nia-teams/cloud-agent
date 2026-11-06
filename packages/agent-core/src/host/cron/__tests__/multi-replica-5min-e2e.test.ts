import { describe, it, expect, beforeEach, afterEach, vi, } from 'vitest';
import { startCron } from '../cron-scanner.js';
import type { ScheduleStore, ClaimedJob, ScheduleSpec } from '../types.js';
interface JobRow {
    id: string;
    schedule: ScheduleSpec;
    nextRun: Date | null;
}
class SharedStore implements ScheduleStore {
    jobs = new Map<string, JobRow>();
    private mu = Promise.resolve();
    seed(j: JobRow): void {
        this.jobs.set(j.id, { ...j });
    }
    async claimDueJob(now: Date, leaseUntil: Date): Promise<ClaimedJob | null> {
        let release: () => void = () => { };
        const prior = this.mu;
        this.mu = new Promise((r) => (release = r));
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
        const j = this.jobs.get(jobId);
        if (!j)
            return;
        if (nextRun === null) {
            this.jobs.delete(jobId);
            return;
        }
        j.nextRun = nextRun;
    }
    async retry(jobId: string, retryAt: Date): Promise<void> {
        const j = this.jobs.get(jobId);
        if (j)
            j.nextRun = retryAt;
    }
}
describe('cron · 5-min multi-replica e2e (alpha.6 regression)', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-06-25T20:00:00Z'));
    });
    afterEach(() => {
        vi.useRealTimers();
    });
    it('mixed at + every workload across 2 replicas / 5 minutes · all at-jobs fire exactly once', async () => {
        const store = new SharedStore();
        const now0 = new Date();
        for (let i = 0; i < 10; i++) {
            const fireAt = new Date(now0.getTime() + (10 + i * 25) * 1000);
            store.seed({
                id: `at-${i}`,
                schedule: { type: 'at', at: fireAt },
                nextRun: fireAt,
            });
        }
        for (let i = 0; i < 3; i++) {
            store.seed({
                id: `every-${i}`,
                schedule: { type: 'every', value: 60000 },
                nextRun: new Date(now0.getTime() + 30000),
            });
        }
        const fireCounts = new Map<string, number>();
        const onFire = vi.fn(async (job: ClaimedJob) => {
            fireCounts.set(job.jobId, (fireCounts.get(job.jobId) ?? 0) + 1);
        });
        const a = startCron({ scheduleStore: store, onFire, intervalMs: 20000, label: 'rep-a' });
        const b = startCron({ scheduleStore: store, onFire, intervalMs: 20000, label: 'rep-b' });
        await vi.advanceTimersByTimeAsync(5 * 60000);
        await a.stop();
        await b.stop();
        for (let i = 0; i < 10; i++) {
            expect(fireCounts.get(`at-${i}`)).toBe(1);
            expect(store.jobs.has(`at-${i}`)).toBe(false);
        }
        for (let i = 0; i < 3; i++) {
            const n = fireCounts.get(`every-${i}`) ?? 0;
            expect(n).toBeGreaterThanOrEqual(4);
            expect(n).toBeLessThanOrEqual(6);
        }
    });
    it('storm scenario · 20 simultaneous at-jobs · still fire-once · no per-tick re-claim', async () => {
        const store = new SharedStore();
        for (let i = 0; i < 20; i++) {
            const fireAt = new Date(Date.now() + 1000);
            store.seed({
                id: `burst-${i}`,
                schedule: { type: 'at', at: fireAt },
                nextRun: fireAt,
            });
        }
        const fireCounts = new Map<string, number>();
        const onFire = vi.fn(async (job: ClaimedJob) => {
            fireCounts.set(job.jobId, (fireCounts.get(job.jobId) ?? 0) + 1);
        });
        const a = startCron({ scheduleStore: store, onFire, intervalMs: 20000 });
        const b = startCron({ scheduleStore: store, onFire, intervalMs: 20000 });
        await vi.advanceTimersByTimeAsync(60000);
        expect(onFire.mock.calls.length).toBe(20);
        for (let i = 0; i < 20; i++) {
            expect(fireCounts.get(`burst-${i}`)).toBe(1);
        }
        expect(store.jobs.size).toBe(0);
        await a.stop();
        await b.stop();
    });
});
