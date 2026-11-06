import type { Logger } from '../../types.js';
export type ScheduleSpec = {
    type: 'at';
    at: Date | string;
} | {
    type: 'cron';
    expr: string;
    tz?: string;
} | {
    type: 'every';
    value: number | string;
} | {
    type: 'webhook';
};
export interface ClaimedJob<P = unknown> {
    jobId: string;
    schedule: ScheduleSpec;
    payload: P;
}
export interface ScheduleStore<P = unknown> {
    claimDueJob(now: Date, leaseUntil: Date): Promise<ClaimedJob<P> | null>;
    advance(jobId: string, nextRun: Date | null): Promise<void>;
    retry(jobId: string, retryAt: Date): Promise<void>;
}
export interface CronMetrics {
    scanned: number;
    triggered: number;
    errors: number;
    durationMs: number;
}
export interface CronConfig<P = unknown> {
    scheduleStore: ScheduleStore<P>;
    onFire: (job: ClaimedJob<P>) => Promise<void>;
    intervalMs?: number;
    leaseMs?: number;
    retryMs?: number;
    fireTimeoutMs?: number;
    onMetrics?: (m: CronMetrics) => void;
    logger?: Logger;
    label?: string;
}
export interface ScheduledTaskConfig {
    taskKey: string;
    schedule: ScheduleSpec;
    onFire: () => Promise<void>;
    leaseMs?: number;
    logger?: Logger;
    label?: string;
    lockStore: LockStore;
}
export interface LockStore {
    acquire(id: string, leaseUntil: Date): Promise<boolean>;
    renew(id: string, leaseUntil: Date): Promise<boolean>;
    release(id: string): Promise<void>;
}
export interface CronHandle {
    stop(): Promise<void>;
}
