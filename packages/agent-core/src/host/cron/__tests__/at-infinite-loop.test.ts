import { describe, it, expect, beforeEach, afterEach, vi, } from 'vitest';
import { startCron } from '../cron-scanner.js';
import { calcNextRun } from '../calc-next-run.js';
import type { ScheduleStore, ClaimedJob, ScheduleSpec } from '../types.js';
describe('calcNextRun · at always one-shot (regression)', () => {
    const now = new Date('2026-06-25T03:00:00Z');
    it('future at → null (one-shot semantic, lib contract)', () => {
        const at = new Date('2026-06-25T03:00:00.500Z');
        expect(calcNextRun({ type: 'at', at }, now)).toBeNull();
    });
    it('past at → null (unchanged)', () => {
        const at = new Date('2026-06-25T02:00:00Z');
        expect(calcNextRun({ type: 'at', at }, now)).toBeNull();
    });
    it('same-instant at → null (boundary)', () => {
        expect(calcNextRun({ type: 'at', at: now }, now)).toBeNull();
    });
});
class StubbornAtStore implements ScheduleStore {
    fired = 0;
    due = true;
    advanced: Array<{
        jobId: string;
        nextRun: Date | null;
    }> = [];
    async claimDueJob(_now: Date, leaseUntil: Date): Promise<ClaimedJob | null> {
        if (!this.due)
            return null;
        return {
            jobId: 'stuck',
            schedule: { type: 'at', at: leaseUntil } as ScheduleSpec,
            payload: { id: 'stuck' },
        };
    }
    async advance(jobId: string, nextRun: Date | null): Promise<void> {
        this.advanced.push({ jobId, nextRun });
        if (nextRun === null) {
        }
        else {
        }
    }
    async retry(_jobId: string, _retryAt: Date): Promise<void> {
    }
    drop(): void {
        this.due = false;
    }
}
describe('startCron · per-tick seenJobs guard (defense in depth)', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });
    afterEach(() => {
        vi.useRealTimers();
    });
    it('same jobId claimed twice in one tick → break loop, force-drop, no infinite fire', async () => {
        const store = new StubbornAtStore();
        const onFire = vi.fn(async () => {
            store.fired++;
        });
        const handle = startCron({
            scheduleStore: store,
            onFire,
            intervalMs: 10000,
        });
        await vi.runOnlyPendingTimersAsync();
        await vi.advanceTimersByTimeAsync(50);
        expect(onFire.mock.calls.length).toBeLessThanOrEqual(2);
        const nullAdvances = store.advanced.filter((a) => a.nextRun === null);
        expect(nullAdvances.length).toBeGreaterThanOrEqual(1);
        await handle.stop();
    });
});
class FlatLikeStore implements ScheduleStore {
    jobs = new Map<string, {
        schedule: ScheduleSpec;
        nextRun: Date | null;
    }>();
    seed(id: string, j: {
        schedule: ScheduleSpec;
        nextRun: Date | null;
    }): void {
        this.jobs.set(id, j);
    }
    async claimDueJob(now: Date, leaseUntil: Date): Promise<ClaimedJob | null> {
        for (const [id, j] of this.jobs) {
            if (j.nextRun && j.nextRun.getTime() <= now.getTime()) {
                j.nextRun = leaseUntil;
                return { jobId: id, schedule: j.schedule, payload: { id } };
            }
        }
        return null;
    }
    async advance(jobId: string, nextRun: Date | null): Promise<void> {
        if (nextRun === null) {
            this.jobs.delete(jobId);
            return;
        }
        const j = this.jobs.get(jobId);
        if (j)
            j.nextRun = nextRun;
    }
    async retry(jobId: string, retryAt: Date): Promise<void> {
        const j = this.jobs.get(jobId);
        if (j)
            j.nextRun = retryAt;
    }
}
describe('startCron · at-type fire-once end-to-end', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });
    afterEach(() => {
        vi.useRealTimers();
    });
    it('past at: fire once, doc deleted, never re-claimed', async () => {
        const store = new FlatLikeStore();
        store.seed('oneshot', {
            schedule: { type: 'at', at: new Date(0) },
            nextRun: new Date(0),
        });
        const onFire = vi.fn(async () => { });
        const handle = startCron({
            scheduleStore: store,
            onFire,
            intervalMs: 1000,
        });
        await vi.runOnlyPendingTimersAsync();
        await vi.advanceTimersByTimeAsync(50);
        expect(onFire).toHaveBeenCalledTimes(1);
        expect(store.jobs.has('oneshot')).toBe(false);
        await vi.advanceTimersByTimeAsync(60000);
        expect(onFire).toHaveBeenCalledTimes(1);
        await handle.stop();
    });
    it('future at (toSpec captured fresh, simulating alpha.5 nia-teams toSpec bug): still fires once + dropped', async () => {
        const store = new FlatLikeStore();
        const initialAt = new Date(Date.now() + 5);
        store.seed('drifty', {
            schedule: { type: 'at', at: initialAt },
            nextRun: new Date(0),
        });
        const onFire = vi.fn(async () => { });
        const handle = startCron({
            scheduleStore: store,
            onFire,
            intervalMs: 1000,
        });
        await vi.runOnlyPendingTimersAsync();
        await vi.advanceTimersByTimeAsync(50);
        expect(onFire).toHaveBeenCalledTimes(1);
        expect(store.jobs.has('drifty')).toBe(false);
        await handle.stop();
    });
});
