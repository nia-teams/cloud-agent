import type { DocStore } from './types.js';
import { COL_SESSIONS } from './schema.js';
export interface ActiveRun {
    holder: string;
    turnId: string;
    expiresAt: Date;
    acquiredAt?: Date;
}
export interface AcquireOpts {
    sessionId: string;
    holder: string;
    turnId: string;
    ttlMs: number;
    extraFilter?: Record<string, unknown>;
}
export interface AcquireResult {
    acquired: boolean;
    currentHolder?: string;
    currentExpiresAt?: Date;
}
export async function acquireLock(store: DocStore, opts: AcquireOpts): Promise<AcquireResult> {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + opts.ttlMs);
    const result = await store.updateOne(COL_SESSIONS, {
        _id: opts.sessionId,
        $and: [
            ...(opts.extraFilter ? [opts.extraFilter] : []),
            {
                $or: [
                    { activeRun: null },
                    { 'activeRun.expiresAt': { $lt: now } },
                ],
            },
        ],
    }, {
        $set: {
            activeRun: {
                holder: opts.holder,
                turnId: opts.turnId,
                expiresAt,
                acquiredAt: now,
            },
        },
    });
    if (result.modifiedCount === 1) {
        return { acquired: true };
    }
    try {
        const doc = await store.findOne<{
            activeRun?: ActiveRun | null;
        }>(COL_SESSIONS, { _id: opts.sessionId }, { projection: { activeRun: 1 } as Record<string, 1> });
        const ar = doc?.activeRun;
        if (ar && ar.holder) {
            return {
                acquired: false,
                currentHolder: ar.holder,
                ...(ar.expiresAt ? { currentExpiresAt: ar.expiresAt } : {}),
            };
        }
    }
    catch {
    }
    return { acquired: false };
}
export async function renewLock(store: DocStore, opts: {
    sessionId: string;
    holder: string;
    ttlMs: number;
}): Promise<boolean> {
    const expiresAt = new Date(Date.now() + opts.ttlMs);
    const result = await store.updateOne(COL_SESSIONS, {
        _id: opts.sessionId,
        'activeRun.holder': opts.holder,
    }, { $set: { 'activeRun.expiresAt': expiresAt } });
    return result.modifiedCount === 1;
}
export async function releaseLock(store: DocStore, opts: {
    sessionId: string;
    holder: string;
}): Promise<boolean> {
    const result = await store.updateOne(COL_SESSIONS, {
        _id: opts.sessionId,
        'activeRun.holder': opts.holder,
    }, { $unset: { activeRun: '' } });
    return result.modifiedCount === 1;
}
export function holderFilter(sessionId: string, holder: string): Record<string, unknown> {
    return {
        _id: sessionId,
        'activeRun.holder': holder,
    };
}
