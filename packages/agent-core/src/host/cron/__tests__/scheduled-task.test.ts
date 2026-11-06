import { describe, it, expect, beforeEach, afterEach, vi, } from 'vitest';
import { startScheduledTask } from '../scheduled-task.js';
import type { LockStore } from '../types.js';
class MemLockStore implements LockStore {
    private locks = new Map<string, {
        expiresAt: number;
    }>();
    public wins = new Map<string, number>();
    public renews = new Map<string, number[]>();
    async acquire(id: string, leaseUntil: Date): Promise<boolean> {
        const existing = this.locks.get(id);
        const now = Date.now();
        if (existing && existing.expiresAt > now)
            return false;
        this.locks.set(id, { expiresAt: leaseUntil.getTime() });
        this.wins.set(id, (this.wins.get(id) ?? 0) + 1);
        return true;
    }
    async renew(id: string, leaseUntil: Date): Promise<boolean> {
        if (!this.locks.has(id))
            return false;
        this.locks.set(id, { expiresAt: leaseUntil.getTime() });
        const arr = this.renews.get(id) ?? [];
        arr.push(Date.now());
        this.renews.set(id, arr);
        return true;
    }
    async release(id: string): Promise<void> {
        this.locks.delete(id);
    }
}
describe('startScheduledTask', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-06-25T19:00:00Z'));
    });
    afterEach(() => {
        vi.useRealTimers();
    });
    it('leader election · N replicas race · exactly one onFire', async () => {
        const lockStore = new MemLockStore();
        let fired = 0;
        const onFire = async (): Promise<void> => {
            fired++;
        };
        const handles = [0, 1, 2].map(() => startScheduledTask({
            taskKey: 'nightly-compact',
            schedule: { type: 'cron', expr: '0 4 * * *', tz: 'Asia/Shanghai' },
            onFire,
            leaseMs: 60000,
            lockStore,
        }));
        await vi.advanceTimersByTimeAsync(60 * 60000 + 1000);
        expect(fired).toBe(1);
        expect(Array.from(lockStore.wins.values()).reduce((a, b) => a + b, 0)).toBe(1);
        for (const h of handles)
            await h.stop();
    });
    it('renew · long-running onFire keeps the lock alive', async () => {
        const lockStore = new MemLockStore();
        const onFire = vi.fn(async () => {
            await new Promise<void>((r) => setTimeout(r, 10000));
        });
        const handle = startScheduledTask({
            taskKey: 'long-task',
            schedule: { type: 'cron', expr: '0 4 * * *', tz: 'Asia/Shanghai' },
            onFire,
            leaseMs: 4000,
            lockStore,
        });
        await vi.advanceTimersByTimeAsync(60 * 60000 + 11000);
        const renews = Array.from(lockStore.renews.values()).flat();
        expect(renews.length).toBeGreaterThanOrEqual(3);
        await handle.stop();
    });
    it('split-brain recovery · winner crashes · next bucket re-elects', async () => {
        const lockStore = new MemLockStore();
        let calls = 0;
        const onFire = async (): Promise<void> => {
            calls++;
            if (calls === 1) {
                await new Promise<void>(() => { });
            }
        };
        const handle = startScheduledTask({
            taskKey: 'flaky-nightly',
            schedule: { type: 'cron', expr: '0 4 * * *', tz: 'Asia/Shanghai' },
            onFire,
            leaseMs: 2000,
            lockStore,
        });
        await vi.advanceTimersByTimeAsync(60 * 60000 + 1000);
        expect(calls).toBe(1);
        lockStore['locks'] = new Map();
        await vi.advanceTimersByTimeAsync(24 * 60 * 60000);
        expect(calls).toBeGreaterThanOrEqual(2);
        await handle.stop();
    });
    it('stop · cancels pending timer cleanly', async () => {
        const lockStore = new MemLockStore();
        const onFire = vi.fn(async () => { });
        const handle = startScheduledTask({
            taskKey: 'never-runs',
            schedule: { type: 'cron', expr: '0 4 * * *', tz: 'Asia/Shanghai' },
            onFire,
            lockStore,
        });
        await vi.advanceTimersByTimeAsync(0);
        await handle.stop();
        await vi.advanceTimersByTimeAsync(24 * 60 * 60000);
        expect(onFire).not.toHaveBeenCalled();
    });
});
