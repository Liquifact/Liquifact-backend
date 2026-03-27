const { MemoryCacheStore, createCacheStore } = require('./cacheStore');

describe('MemoryCacheStore', () => {
  let store;

  beforeEach(() => {
    store = new MemoryCacheStore();
  });

  it('returns undefined for missing keys', () => {
    expect(store.get('nonexistent')).toBeUndefined();
  });

  it('round-trips a value with set and get', () => {
    store.set('key1', { data: 'hello' }, 5000);
    expect(store.get('key1')).toEqual({ data: 'hello' });
  });

  it('returns undefined and evicts expired entries', () => {
    const now = Date.now();
    jest.spyOn(Date, 'now')
      .mockReturnValueOnce(now)       // set call
      .mockReturnValueOnce(now + 6000); // get call (after TTL)

    store.set('key1', 'value', 5000);
    expect(store.get('key1')).toBeUndefined();

    Date.now.mockRestore();
  });

  it('del removes a specific entry', () => {
    store.set('key1', 'value1', 5000);
    store.set('key2', 'value2', 5000);
    store.del('key1');
    expect(store.get('key1')).toBeUndefined();
    expect(store.get('key2')).toBe('value2');
  });

  it('clear removes all entries', () => {
    store.set('key1', 'value1', 5000);
    store.set('key2', 'value2', 5000);
    store.clear();
    expect(store.get('key1')).toBeUndefined();
    expect(store.get('key2')).toBeUndefined();
  });

  it('set overwrites existing entries', () => {
    store.set('key1', 'old', 5000);
    store.set('key1', 'new', 5000);
    expect(store.get('key1')).toBe('new');
  });
});

describe('createCacheStore', () => {
  it('returns a MemoryCacheStore instance', () => {
    const store = createCacheStore();
    expect(store).toBeInstanceOf(MemoryCacheStore);
  });
});
