import { calcNextRun } from './calc-next-run.js';
import type { ScheduledTaskConfig, CronHandle, ScheduleSpec, } from './types.js';
import { NOOP_LOGGER, type Logger } from '../../types.js';
const DEFAULT_LEASE_MS = 5 * 60000;
const MIN_SLEEP_MS = 1000;
const NULL_RETRY_MS = 60 * 60000;
function bucketKey(schedule: ScheduleSpec, fireAt: Date): string {
    switch (schedule.type) {
        case 'cron': {
            const d = fireAt;
            const pad = (n: number, w = 2): string => String(n).padStart(w, '0');
            return [
                d.getUTCFullYear(),
                pad(d.getUTCMonth() + 1),
                pad(d.getUTCDate()),
                pad(d.getUTCHours()),
                pad(d.getUTCMinutes()),
            ].join('-');
        }
        case 'every':
        case 'at':
        default:
            return String(Math.floor(fireAt.getTime() / 60000));
    }
}
export function startScheduledTask(config: ScheduledTaskConfig): CronHandle {
    const leaseMs = config.leaseMs ?? DEFAULT_LEASE_MS;
    const renewMs = Math.max(1000, Math.floor(leaseMs / 2));
    const logger: Logger = config.logger ?? NOOP_LOGGER;
    const label = config.label ?? config.taskKey;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let firing: Promise<void> = Promise.resolve();
    function planNext(): {
        sleepMs: number;
        fireAt: Date | null;
    } {
        const now = new Date();
        const next = calcNextRun(config.schedule, now);
        if (!next) {
            return { sleepMs: NULL_RETRY_MS, fireAt: null };
        }
        const sleepMs = Math.max(MIN_SLEEP_MS, next.getTime() - now.getTime());
        return { sleepMs, fireAt: next };
    }
    async function runOnce(fireAt: Date): Promise<void> {
        const bucket = bucketKey(config.schedule, fireAt);
        const lockId = `${config.taskKey}:${bucket}`;
        const leaseUntil = new Date(Date.now() + leaseMs);
        let won = false;
        try {
            won = await config.lockStore.acquire(lockId, leaseUntil);
        }
        catch (err) {
            logger.warn({ err, label, lockId }, 'scheduledTask.acquire threw · skipping this fire');
            return;
        }
        if (!won) {
            logger.info({ label, lockId }, 'scheduledTask · peer holds lock · skip');
            return;
        }
        logger.info({ label, lockId }, 'scheduledTask · acquired lock');
        let renewTimer: ReturnType<typeof setInterval> | null = null;
        let alive = true;
        renewTimer = setInterval(() => {
            if (!alive)
                return;
            const until = new Date(Date.now() + leaseMs);
            config.lockStore.renew(lockId, until).catch((err) => {
                logger.warn({ err, label, lockId }, 'scheduledTask.renew failed');
            });
        }, renewMs);
        try {
            await config.onFire();
            logger.info({ label, lockId }, 'scheduledTask · onFire done');
        }
        catch (err) {
            logger.warn({ err, label, lockId }, 'scheduledTask.onFire threw');
        }
        finally {
            alive = false;
            if (renewTimer)
                clearInterval(renewTimer);
        }
    }
    function schedule(): void {
        if (stopped)
            return;
        const { sleepMs, fireAt } = planNext();
        timer = setTimeout(() => {
            timer = null;
            if (stopped)
                return;
            if (fireAt) {
                firing = runOnce(fireAt).catch((err) => {
                    logger.warn({ err, label }, 'scheduledTask.runOnce threw');
                });
                schedule();
            }
            else {
                schedule();
            }
        }, sleepMs);
    }
    setTimeout(() => {
        if (!stopped)
            schedule();
    }, 0);
    return {
        async stop() {
            stopped = true;
            if (timer) {
                clearTimeout(timer);
                timer = null;
            }
            try {
                await firing;
            }
            catch {
            }
        },
    };
}
