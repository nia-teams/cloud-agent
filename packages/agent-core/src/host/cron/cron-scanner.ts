import { calcNextRun } from './calc-next-run.js';
import type { CronConfig, CronHandle, ClaimedJob, CronMetrics } from './types.js';
import { NOOP_LOGGER, type Logger } from '../../types.js';
const DEFAULT_INTERVAL_MS = 20000;
const DEFAULT_LEASE_MS = 10 * 60000;
const DEFAULT_RETRY_MS = 60000;
export function startCron<P = unknown>(config: CronConfig<P>): CronHandle {
    const intervalMs = config.intervalMs ?? DEFAULT_INTERVAL_MS;
    const leaseMs = config.leaseMs ?? DEFAULT_LEASE_MS;
    const retryMs = config.retryMs ?? DEFAULT_RETRY_MS;
    const fireTimeoutMs = config.fireTimeoutMs ?? leaseMs;
    const logger: Logger = config.logger ?? NOOP_LOGGER;
    const label = config.label ?? 'cron';
    let timer: ReturnType<typeof setInterval> | null = null;
    let running = false;
    let stopped = false;
    let inflight: Promise<void> = Promise.resolve();
    async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
        if (!Number.isFinite(ms) || ms <= 0)
            return p;
        let h: ReturnType<typeof setTimeout> | null = null;
        const timeout = new Promise<never>((_, reject) => {
            h = setTimeout(() => reject(new Error('onFire timeout')), ms);
        });
        try {
            return await Promise.race([p, timeout]);
        }
        finally {
            if (h)
                clearTimeout(h);
        }
    }
    async function fireOne(job: ClaimedJob<P>, now: Date): Promise<'ok' | 'err'> {
        try {
            await withTimeout(config.onFire(job), fireTimeoutMs);
            const next = calcNextRun(job.schedule, now);
            try {
                await config.scheduleStore.advance(job.jobId, next);
            }
            catch (err) {
                logger.warn({ err, label, jobId: job.jobId }, 'cron.advance failed');
            }
            return 'ok';
        }
        catch (err) {
            logger.warn({ err, label, jobId: job.jobId }, 'cron.onFire failed · rewinding for retry');
            const retryAt = new Date(now.getTime() + retryMs);
            try {
                await config.scheduleStore.retry(job.jobId, retryAt);
            }
            catch (err2) {
                logger.warn({ err: err2, label, jobId: job.jobId }, 'cron.retry rewind failed');
            }
            return 'err';
        }
    }
    async function tick(): Promise<void> {
        if (running || stopped)
            return;
        running = true;
        const start = Date.now();
        let scanned = 0;
        let triggered = 0;
        let errors = 0;
        const seenJobs = new Set<string>();
        try {
            while (!stopped) {
                const now = new Date();
                const leaseUntil = new Date(now.getTime() + leaseMs);
                let job: ClaimedJob<P> | null;
                try {
                    job = await config.scheduleStore.claimDueJob(now, leaseUntil);
                }
                catch (err) {
                    logger.warn({ err, label }, 'cron.claimDueJob threw');
                    break;
                }
                if (!job)
                    break;
                if (seenJobs.has(job.jobId)) {
                    logger.warn({ label, jobId: job.jobId, scanned, scheduleType: job.schedule.type }, 'cron · same jobId claimed twice within one tick · force-drop · check calcNextRun/toSpec');
                    try {
                        await config.scheduleStore.advance(job.jobId, null);
                    }
                    catch (err) {
                        logger.warn({ err, label, jobId: job.jobId }, 'cron · force-drop advance(null) failed');
                    }
                    errors++;
                    break;
                }
                seenJobs.add(job.jobId);
                scanned++;
                const res = await fireOne(job, now);
                if (res === 'ok')
                    triggered++;
                else
                    errors++;
            }
        }
        finally {
            running = false;
            const durationMs = Date.now() - start;
            if (config.onMetrics && (scanned > 0 || triggered > 0 || errors > 0)) {
                try {
                    config.onMetrics({ scanned, triggered, errors, durationMs } satisfies CronMetrics);
                }
                catch (err) {
                    logger.warn({ err, label }, 'cron.onMetrics threw');
                }
            }
            if (scanned > 0 || triggered > 0 || errors > 0) {
                logger.info({ label, scanned, triggered, errors, durationMs }, 'cron · tick done');
            }
        }
    }
    function schedule(): void {
        timer = setInterval(() => {
            const p = tick().catch((err) => {
                logger.warn({ err, label }, 'cron.tick threw');
            });
            inflight = p;
        }, intervalMs);
    }
    setTimeout(() => {
        if (stopped)
            return;
        void tick().catch((err) => {
            logger.warn({ err, label }, 'cron.tick threw (initial)');
        });
        schedule();
    }, 0);
    return {
        async stop() {
            stopped = true;
            if (timer) {
                clearInterval(timer);
                timer = null;
            }
            try {
                await inflight;
            }
            catch {
            }
        },
    };
}
