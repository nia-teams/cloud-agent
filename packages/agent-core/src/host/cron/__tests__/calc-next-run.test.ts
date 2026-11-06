import { describe, it, expect } from 'vitest';
import { calcNextRun } from '../calc-next-run.js';
describe('calcNextRun', () => {
    const now = new Date('2026-06-25T03:00:00Z');
    describe('at', () => {
        it('future Date → null (one-shot semantic · alpha.6+)', () => {
            const at = new Date('2026-06-25T04:00:00Z');
            expect(calcNextRun({ type: 'at', at }, now)).toBeNull();
        });
        it('past Date → null (unchanged)', () => {
            const at = new Date('2026-06-25T02:00:00Z');
            expect(calcNextRun({ type: 'at', at }, now)).toBeNull();
        });
        it('ISO string in future → null (one-shot semantic)', () => {
            expect(calcNextRun({ type: 'at', at: '2026-06-25T05:00:00Z' }, now))
                .toBeNull();
        });
        it('invalid string → null', () => {
            expect(calcNextRun({ type: 'at', at: 'not-a-date' }, now)).toBeNull();
        });
    });
    describe('cron', () => {
        it('5-field expr · default Asia/Shanghai', () => {
            const next = calcNextRun({ type: 'cron', expr: '0 4 * * *' }, now);
            expect(next).not.toBeNull();
            expect(next!.toISOString()).toBe('2026-06-25T20:00:00.000Z');
        });
        it('tz override', () => {
            const next = calcNextRun({ type: 'cron', expr: '0 4 * * *', tz: 'UTC' }, now);
            expect(next!.toISOString()).toBe('2026-06-25T04:00:00.000Z');
        });
        it('invalid expr → null', () => {
            expect(calcNextRun({ type: 'cron', expr: 'not a cron' }, now)).toBeNull();
        });
    });
    describe('every', () => {
        it('numeric ms', () => {
            expect(calcNextRun({ type: 'every', value: 30 * 60000 }, now))
                .toEqual(new Date(now.getTime() + 30 * 60000));
        });
        it('string "30m"', () => {
            expect(calcNextRun({ type: 'every', value: '30m' }, now))
                .toEqual(new Date(now.getTime() + 30 * 60000));
        });
        it('"1h", "2d", "45s"', () => {
            expect(calcNextRun({ type: 'every', value: '1h' }, now)?.getTime())
                .toBe(now.getTime() + 3600000);
            expect(calcNextRun({ type: 'every', value: '2d' }, now)?.getTime())
                .toBe(now.getTime() + 2 * 86400000);
            expect(calcNextRun({ type: 'every', value: '45s' }, now)?.getTime())
                .toBe(now.getTime() + 45000);
        });
        it('non-positive numeric → null', () => {
            expect(calcNextRun({ type: 'every', value: 0 }, now)).toBeNull();
            expect(calcNextRun({ type: 'every', value: -1 }, now)).toBeNull();
        });
        it('bad string → null', () => {
            expect(calcNextRun({ type: 'every', value: 'tomorrow' }, now)).toBeNull();
        });
    });
    describe('webhook', () => {
        it('always null', () => {
            expect(calcNextRun({ type: 'webhook' }, now)).toBeNull();
        });
    });
});
