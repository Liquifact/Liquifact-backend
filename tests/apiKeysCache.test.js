'use strict';

const mockLoadApiKeyRegistry = jest.fn();
jest.mock('../src/config/apiKeys', () => ({
  loadApiKeyRegistry: (...args) => mockLoadApiKeyRegistry(...args),
}));

const { ApiKeysCache } = require('../src/cache/apiKeysCache');

function makeRegistry(key) {
  return new Map([[key, { key, clientId: 'test-client' }]]);
}

describe('API keys cache failure recovery', () => {
  let cache;

  beforeEach(() => {
    mockLoadApiKeyRegistry.mockReset();
    cache = new ApiKeysCache({ ttlMs: 1_000, maxEntries: 1 });
  });

  it('preserves existing entries on load failure and retries successfully', () => {
    mockLoadApiKeyRegistry.mockReturnValueOnce(makeRegistry('first-key'));
    expect(cache.getOrLoad('first')).toHaveProperty('size', 1);

    mockLoadApiKeyRegistry.mockImplementationOnce(() => {
      throw new Error('temporary registry failure');
    });
    expect(() => cache.getOrLoad('second')).toThrow('temporary registry failure');
    expect(cache.size).toBe(1);
    expect(cache.getOrLoad('first').has('first-key')).toBe(true);

    mockLoadApiKeyRegistry.mockReturnValueOnce(makeRegistry('second-key'));
    expect(cache.getOrLoad('second').has('second-key')).toBe(true);
    expect(cache.size).toBe(1);
  });

  it('does not publish a partially iterated registry', () => {
    const partialRegistry = new Map();
    partialRegistry[Symbol.iterator] = function* iteratePartially() {
      yield ['partial-key', { key: 'partial-key' }];
      throw new Error('registry iteration failed');
    };
    mockLoadApiKeyRegistry.mockReturnValueOnce(partialRegistry);

    expect(() => cache.getOrLoad()).toThrow('registry iteration failed');
    expect(cache.size).toBe(0);

    mockLoadApiKeyRegistry.mockReturnValueOnce(makeRegistry('recovered-key'));
    expect(cache.getOrLoad().has('recovered-key')).toBe(true);
  });

  it('rejects invalid loader results without changing cache state', () => {
    mockLoadApiKeyRegistry.mockReturnValueOnce({ key: 'not-a-map' });

    expect(() => cache.getOrLoad()).toThrow('loader must return a Map');
    expect(cache.size).toBe(0);
  });

  it('replaces an expired entry only after a successful reload', () => {
    mockLoadApiKeyRegistry.mockReturnValueOnce(makeRegistry('expired-key'));
    expect(cache.getOrLoad('default', 0).has('expired-key')).toBe(true);

    mockLoadApiKeyRegistry.mockImplementationOnce(() => {
      throw new Error('reload failed');
    });
    expect(() => cache.getOrLoad('default', 1_000)).toThrow('reload failed');
    expect(cache.size).toBe(1);

    mockLoadApiKeyRegistry.mockReturnValueOnce(makeRegistry('fresh-key'));
    expect(cache.getOrLoad('default', 1_000).has('fresh-key')).toBe(true);
    expect(cache.size).toBe(1);
  });
});