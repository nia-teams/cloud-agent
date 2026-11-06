import { describe, expect, it } from 'vitest';
import { COL_EVENTS, COL_SESSIONS, REQUIRED_INDEXES } from '../schema.js';
describe('host/schema · required indexes', () => {
    it('declares the event turn cleanup index without custom options or a name', () => {
        expect(REQUIRED_INDEXES).toContainEqual({
            collection: COL_EVENTS,
            spec: { sessionId: 1, turnId: 1 },
        });
    });
    it('declares the production-proven partial index for durable wake recovery', () => {
        expect(REQUIRED_INDEXES).toContainEqual({
            collection: COL_SESSIONS,
            spec: { runtimeWakeRequestedAt: 1, 'activeRun.expiresAt': 1 },
            opts: { partialFilter: { runtimeWakeRequestedAt: { $exists: true } } },
        });
    });
});
