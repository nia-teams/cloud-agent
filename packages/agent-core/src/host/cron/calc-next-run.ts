import { CronExpressionParser } from 'cron-parser';
import type { ScheduleSpec } from './types.js';
const DEFAULT_TZ = 'Asia/Shanghai';
const DURATION_RE = /^(\d+)(ms|s|m|h|d)$/;
function parseDurationMs(v: string | number): number | null {
    if (typeof v === 'number') {
        return Number.isFinite(v) && v > 0 ? v : null;
    }
    const m = DURATION_RE.exec(v);
    if (!m)
        return null;
    const n = Number(m[1]);
    if (!Number.isFinite(n) || n <= 0)
        return null;
    switch (m[2]) {
        case 'ms': return n;
        case 's': return n * 1000;
        case 'm': return n * 60000;
        case 'h': return n * 3600000;
        case 'd': return n * 86400000;
        default: return null;
    }
}
export function calcNextRun(schedule: ScheduleSpec, now: Date): Date | null {
    switch (schedule.type) {
        case 'at': {
            return null;
        }
        case 'cron': {
            try {
                const it = CronExpressionParser.parse(schedule.expr, {
                    currentDate: now,
                    tz: schedule.tz ?? DEFAULT_TZ,
                });
                return it.next().toDate();
            }
            catch {
                return null;
            }
        }
        case 'every': {
            const ms = parseDurationMs(schedule.value);
            if (ms == null)
                return null;
            return new Date(now.getTime() + ms);
        }
        case 'webhook':
        default:
            return null;
    }
}
