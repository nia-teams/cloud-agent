import { describe, it, expect } from 'vitest';
import { InMemoryConversationStore } from '../in-memory-store.js';
import { MemoryDocStore, MemoryPubSub, createMemoryDocStore, createMemoryPubSub } from '../host/adapters/memory.js';
import type { AgentMessage } from '../types.js';
const user = (content: string): AgentMessage => ({ type: 'event', eventType: 'user', content, timestamp: new Date() });
describe('public memory stores', () => {
 it('detaches constructor, queue, load, fetch, and persisted snapshots', async () => {
  const initial = user('initial'); const store = new InMemoryConversationStore([initial]); initial.content = 'changed';
  const loaded = await store.loadAll(); loaded[0].content = 'changed';
  expect(store.getMessages()[0].content).toBe('initial');
  const added = user('queued'); store.enqueue(added); added.content = 'changed';
  expect(await store.hasNew()).toBe(true);
  const fetched = await store.fetchNew(); fetched[0].content = 'changed';
  expect(await store.hasNew()).toBe(false); expect(await store.fetchNew()).toEqual([]);
  expect(store.getMessages()[1].content).toBe('queued');
  const persisted = user('persisted'); await store.persist([persisted]); persisted.content = 'changed';
  expect(store.getMessages()[2].content).toBe('persisted');
  const snapshot = store.getMessages(); snapshot.splice(0); expect(store.getMessages()).toHaveLength(3);
 });
 it('offers an ergonomic user-message constructor and consumes queued messages on load', async () => {
  const store = InMemoryConversationStore.fromUserMessage('hello'); store.enqueue(user('new'));
  expect((await store.loadAll()).map(message => message.content)).toEqual(['hello', 'new']);
  expect(await store.hasNew()).toBe(false);
 });
 it('public factories produce directly constructible adapters', () => {
  expect(createMemoryDocStore()).toBeInstanceOf(MemoryDocStore);
  expect(createMemoryPubSub()).toBeInstanceOf(MemoryPubSub);
 });
 it('detaches document inserts, updates and reads', async () => {
  const store = createMemoryDocStore(); const doc = { _id: 's', nested: { value: 1 } };
  await store.insertOne('sessions', doc); doc.nested.value = 100;
  const update = { value: 2 }; await store.updateOne('sessions', { _id: 's' }, { $set: { nested: update } }); update.value = 100;
  const first = await store.findOne<typeof doc>('sessions', { _id: 's' }); expect(first?.nested.value).toBe(2);
  first!.nested.value = 100;
  expect((await store.findOne<typeof doc>('sessions', { _id: 's' }))?.nested.value).toBe(2);
 });
 it('serializes competing compare-and-set writes', async () => {
  const store = createMemoryDocStore(); await store.insertOne('sessions', { _id: 's', holder: null });
  const results = await Promise.all(['a','b'].map(holder => store.findOneAndUpdate('sessions', { _id: 's', holder: null }, { $set: { holder } })));
  expect(results.filter(Boolean)).toHaveLength(1);
 });
 it('broadcasts exact and wildcard subscriptions and unsubscribes cleanly', async () => {
  const bus = new MemoryPubSub(); const seen: string[] = [];
  const off = await bus.subscribe('session:a', payload => seen.push(payload));
  const offPattern = await bus.psubscribe('session:*', (channel, payload) => seen.push(channel + payload));
  await bus.publish('session:a', '1'); expect(seen).toEqual(['1','session:a1']);
  await off(); await offPattern(); await bus.publish('session:a', '2'); expect(seen).toHaveLength(2);
 });
});
