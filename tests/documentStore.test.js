'use strict';

const { createDocumentStore } = require('../src/data/documentStore');

describe('DocumentStore', () => {
  let store;

  const createMeta = (id) => ({
    sha256Hex: `sha-${id}`,
    sizeBytes: 100,
    uploadedAt: new Date().toISOString(),
    originalName: `invoice-${id}.pdf`,
  });

  const createBuffer = (id) => Buffer.from(`pdf-content-${id}`);

  beforeEach(() => {
    store = createDocumentStore({ maxDocs: 3 });
  });

  describe('LRU eviction order', () => {
    test('evicts least-recently-used entry when capacity is reached', () => {
      // Fill store to capacity
      store.save('inv-1', createMeta('1'), createBuffer('1'));
      store.save('inv-2', createMeta('2'), createBuffer('2'));
      store.save('inv-3', createMeta('3'), createBuffer('3'));

      expect(store.size()).toBe(3);

      // Add a fourth entry, should evict inv-1 (least recently used)
      const evicted = store.save('inv-4', createMeta('4'), createBuffer('4'));
      expect(evicted).toBe(true);
      expect(store.size()).toBe(3);
      expect(store.has('inv-1')).toBe(false);
      expect(store.has('inv-2')).toBe(true);
      expect(store.has('inv-3')).toBe(true);
      expect(store.has('inv-4')).toBe(true);
    });

    test('evicts correct entry with maxDocs=2', () => {
      const smallStore = createDocumentStore({ maxDocs: 2 });

      smallStore.save('inv-1', createMeta('1'), createBuffer('1'));
      smallStore.save('inv-2', createMeta('2'), createBuffer('2'));

      expect(smallStore.size()).toBe(2);

      // Add third entry, should evict inv-1
      smallStore.save('inv-3', createMeta('3'), createBuffer('3'));
      expect(smallStore.size()).toBe(2);
      expect(smallStore.has('inv-1')).toBe(false);
      expect(smallStore.has('inv-2')).toBe(true);
      expect(smallStore.has('inv-3')).toBe(true);
    });

    test('evicts in LRU order when multiple saves occur', () => {
      store.save('inv-1', createMeta('1'), createBuffer('1'));
      store.save('inv-2', createMeta('2'), createBuffer('2'));
      store.save('inv-3', createMeta('3'), createBuffer('3'));

      // Access inv-1 to make it most recently used
      store.getMeta('inv-1');

      // Add new entry, should evict inv-2 (now LRU)
      store.save('inv-4', createMeta('4'), createBuffer('4'));
      expect(store.size()).toBe(3);
      expect(store.has('inv-1')).toBe(true);
      expect(store.has('inv-2')).toBe(false);
      expect(store.has('inv-3')).toBe(true);
      expect(store.has('inv-4')).toBe(true);
    });
  });

  describe('read operations promote recency', () => {
    test('getMeta refreshes recency and prevents eviction', () => {
      store.save('inv-1', createMeta('1'), createBuffer('1'));
      store.save('inv-2', createMeta('2'), createBuffer('2'));
      store.save('inv-3', createMeta('3'), createBuffer('3'));

      // Read inv-1 to promote it
      const meta = store.getMeta('inv-1');
      expect(meta).toBeDefined();

      // Add new entry, should evict inv-2 (not inv-1)
      store.save('inv-4', createMeta('4'), createBuffer('4'));
      expect(store.has('inv-1')).toBe(true);
      expect(store.has('inv-2')).toBe(false);
      expect(store.has('inv-3')).toBe(true);
      expect(store.has('inv-4')).toBe(true);
    });

    test('getBuffer refreshes recency and prevents eviction', () => {
      store.save('inv-1', createMeta('1'), createBuffer('1'));
      store.save('inv-2', createMeta('2'), createBuffer('2'));
      store.save('inv-3', createMeta('3'), createBuffer('3'));

      // Read inv-1 buffer to promote it
      const buffer = store.getBuffer('inv-1');
      expect(buffer).toBeDefined();

      // Add new entry, should evict inv-2 (not inv-1)
      store.save('inv-4', createMeta('4'), createBuffer('4'));
      expect(store.has('inv-1')).toBe(true);
      expect(store.has('inv-2')).toBe(false);
      expect(store.has('inv-3')).toBe(true);
      expect(store.has('inv-4')).toBe(true);
    });

    test('multiple reads maintain correct LRU order', () => {
      store.save('inv-1', createMeta('1'), createBuffer('1'));
      store.save('inv-2', createMeta('2'), createBuffer('2'));
      store.save('inv-3', createMeta('3'), createBuffer('3'));

      // Read inv-2 and inv-3 to promote them
      store.getMeta('inv-2');
      store.getBuffer('inv-3');

      // inv-1 is now LRU
      store.save('inv-4', createMeta('4'), createBuffer('4'));
      expect(store.has('inv-1')).toBe(false);
      expect(store.has('inv-2')).toBe(true);
      expect(store.has('inv-3')).toBe(true);
      expect(store.has('inv-4')).toBe(true);
    });
  });

  describe('save() with existing id', () => {
    test('save of existing id does not evict another entry', () => {
      store.save('inv-1', createMeta('1'), createBuffer('1'));
      store.save('inv-2', createMeta('2'), createBuffer('2'));
      store.save('inv-3', createMeta('3'), createBuffer('3'));

      expect(store.size()).toBe(3);

      // Update existing entry - should not evict
      const evicted = store.save('inv-2', createMeta('2-updated'), createBuffer('2-updated'));
      expect(evicted).toBe(false);
      expect(store.size()).toBe(3);

      // All entries should still exist
      expect(store.has('inv-1')).toBe(true);
      expect(store.has('inv-2')).toBe(true);
      expect(store.has('inv-3')).toBe(true);

      // Verify the entry was updated
      const meta = store.getMeta('inv-2');
      expect(meta.originalName).toBe('invoice-2-updated.pdf');
    });

    test('save of existing id promotes it to most-recently-used', () => {
      store.save('inv-1', createMeta('1'), createBuffer('1'));
      store.save('inv-2', createMeta('2'), createBuffer('2'));
      store.save('inv-3', createMeta('3'), createBuffer('3'));

      // Update inv-1 to promote it
      store.save('inv-1', createMeta('1-updated'), createBuffer('1-updated'));

      // Add new entry, should evict inv-2 (not inv-1)
      store.save('inv-4', createMeta('4'), createBuffer('4'));
      expect(store.has('inv-1')).toBe(true);
      expect(store.has('inv-2')).toBe(false);
      expect(store.has('inv-3')).toBe(true);
      expect(store.has('inv-4')).toBe(true);
    });
  });

  describe('clear and size', () => {
    test('size returns correct count', () => {
      expect(store.size()).toBe(0);

      store.save('inv-1', createMeta('1'), createBuffer('1'));
      expect(store.size()).toBe(1);

      store.save('inv-2', createMeta('2'), createBuffer('2'));
      expect(store.size()).toBe(2);

      store.save('inv-3', createMeta('3'), createBuffer('3'));
      expect(store.size()).toBe(3);
    });

    test('clear removes all entries', () => {
      store.save('inv-1', createMeta('1'), createBuffer('1'));
      store.save('inv-2', createMeta('2'), createBuffer('2'));
      store.save('inv-3', createMeta('3'), createBuffer('3'));

      expect(store.size()).toBe(3);

      store.clear();
      expect(store.size()).toBe(0);
      expect(store.has('inv-1')).toBe(false);
      expect(store.has('inv-2')).toBe(false);
      expect(store.has('inv-3')).toBe(false);
    });

    test('clear allows new saves after eviction capacity', () => {
      store.save('inv-1', createMeta('1'), createBuffer('1'));
      store.save('inv-2', createMeta('2'), createBuffer('2'));
      store.save('inv-3', createMeta('3'), createBuffer('3'));

      store.clear();

      // Should be able to add new entries without eviction
      const evicted = store.save('inv-4', createMeta('4'), createBuffer('4'));
      expect(evicted).toBe(false);
      expect(store.size()).toBe(1);
    });
  });

  describe('remove operation', () => {
    test('remove deletes specific entry', () => {
      store.save('inv-1', createMeta('1'), createBuffer('1'));
      store.save('inv-2', createMeta('2'), createBuffer('2'));
      store.save('inv-3', createMeta('3'), createBuffer('3'));

      store.remove('inv-2');
      expect(store.size()).toBe(2);
      expect(store.has('inv-1')).toBe(true);
      expect(store.has('inv-2')).toBe(false);
      expect(store.has('inv-3')).toBe(true);
    });

    test('remove of non-existent entry is safe', () => {
      store.save('inv-1', createMeta('1'), createBuffer('1'));
      expect(store.size()).toBe(1);

      store.remove('inv-nonexistent');
      expect(store.size()).toBe(1);
    });
  });

  describe('has operation', () => {
    test('has returns true for existing entries', () => {
      store.save('inv-1', createMeta('1'), createBuffer('1'));
      expect(store.has('inv-1')).toBe(true);
      expect(store.has('inv-nonexistent')).toBe(false);
    });
  });

  describe('getMeta and getBuffer return null for missing entries', () => {
    test('getMeta returns null for missing entry', () => {
      expect(store.getMeta('inv-nonexistent')).toBeNull();
    });

    test('getBuffer returns null for missing entry', () => {
      expect(store.getBuffer('inv-nonexistent')).toBeNull();
    });
  });
});
