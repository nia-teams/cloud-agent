import { describe, expect, it, vi } from 'vitest';
import { createAgentHost, REQUIRED_INDEXES } from '../host/index.js';
import { REQUIRED_INDEXES as schemaIndexes } from '../host/schema.js';
import { createMemoryDocStore, createMemoryPubSub, createMockLogger, } from '../host/__tests__/fixtures.js';
describe('host/schema · out-of-band index convergence', () => {
    it('exports the declarative schema for host index scripts', () => {
        expect(REQUIRED_INDEXES).toBe(schemaIndexes);
    });
    it.each([false, true])('starts without DDL APIs (guard forbidden index access: %s)', async (guardDdl) => {
        const store = createMemoryDocStore();
        expect(store).not.toHaveProperty('ensureIndex');
        expect(store).not.toHaveProperty('createIndex');
        const ddlAccess = vi.fn();
        const guardedStore = new Proxy(store, {
            get(target, property, receiver) {
                if (property === 'ensureIndex' || property === 'createIndex') {
                    ddlAccess(property);
                    throw new Error('Runtime must not access index creation APIs');
                }
                return Reflect.get(target, property, receiver);
            },
        });
        const find = vi.spyOn(store, 'find');
        const pubSub = createMemoryPubSub();
        const subscribe = vi.spyOn(pubSub, 'psubscribe');
        const runtime = createAgentHost({
            docStore: guardDdl ? guardedStore : store,
            pubSub,
            logger: createMockLogger(),
            resolveAgentConfig: async () => {
                throw new Error('not used — no work injected');
            },
        });
        try {
            await expect(runtime.start()).resolves.toBeUndefined();
            expect(subscribe).toHaveBeenCalled();
            expect(find).toHaveBeenCalled();
            expect(ddlAccess).not.toHaveBeenCalled();
        }
        finally {
            await runtime.stop();
        }
    });
});
