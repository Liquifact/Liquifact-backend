'use strict';

const {
  escrowReadCacheHitsTotal,
  escrowReadCacheMissesTotal,
  escrowReadCacheEvictionsTotal,
} = require('../metrics');
const { EscrowReadCache } = require('./escrowReadCache');

describe('EscrowReadCache', () => {
  let clock;
  let cache;

  beforeEach(() => {
    clock = 1000;
    cache = new EscrowReadCache({
      ttlMs: 100,
      maxEntries: 2,
      now: () => clock,
    });
    jest.spyOn(escrowReadCacheHitsTotal, 'inc').mockImplementation(() => {});
    jest.spyOn(escrowReadCacheMissesTotal, 'inc').mockImplementation(() => {});
    jest.spyOn(escrowReadCacheEvictionsTotal, 'labels').mockReturnValue({ inc: jest.fn() });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('records a cold miss and then serves a hit', () => {
    expect(cache.get('inv-1')).toBeUndefined();
    cache.set('inv-1', { status: 'funded' });
    expect(cache.get('inv-1')).toEqual({ status: 'funded' });
    expect(escrowReadCacheMissesTotal.inc).toHaveBeenCalledTimes(1);
    expect(escrowReadCacheHitsTotal.inc).toHaveBeenCalledTimes(1);
  });

  it('expires entries at the configured TTL', () => {
    cache.set('inv-1', { status: 'funded' });
    clock += 100;
    expect(cache.get('inv-1')).toBeUndefined();
    expect(escrowReadCacheEvictionsTotal.labels).toHaveBeenCalledWith('expired');
  });

  it('evicts the least recently used entry at capacity', () => {
    cache.set('inv-1', 1);
    cache.set('inv-2', 2);
    expect(cache.get('inv-1')).toBe(1);
    cache.set('inv-3', 3);
    expect(cache.get('inv-2')).toBeUndefined();
    expect(cache.get('inv-1')).toBe(1);
    expect(cache.get('inv-3')).toBe(3);
    expect(escrowReadCacheEvictionsTotal.labels).toHaveBeenCalledWith('capacity');
  });

  it('invalidates only the affected invoice', () => {
    cache.set('inv-1', 1);
    cache.set('inv-2', 2);
    expect(cache.invalidate('inv-1')).toBe(true);
    expect(cache.get('inv-1')).toBeUndefined();
    expect(cache.get('inv-2')).toBe(2);
  });
});
