const { cacheResponse } = require('./cache');
const { MemoryCacheStore } = require('../services/cacheStore');

/**
 * Creates a minimal mock response object for testing.
 *
 * @returns {object} Mock Express response.
 */
function createMockRes() {
  const res = {
    statusCode: 200,
    headers: {},
    body: null,
    status(code) {
      res.statusCode = code;
      return res;
    },
    json(data) {
      res.body = data;
      return res;
    },
    set(name, value) {
      res.headers[name] = value;
      return res;
    },
  };
  return res;
}

describe('cacheResponse', () => {
  let store;

  beforeEach(() => {
    store = new MemoryCacheStore();
  });

  it('calls next on cache miss and caches the 2xx response', (done) => {
    const middleware = cacheResponse({ ttl: 5000, store });
    const req = { originalUrl: '/api/escrow/123' };
    const res = createMockRes();

    middleware(req, res, () => {
      // Simulate handler sending response
      res.json({ data: 'from handler' });

      expect(res.body).toEqual({ data: 'from handler' });
      expect(res.headers['X-Cache']).toBe('MISS');
      expect(store.get('/api/escrow/123')).toEqual({ data: 'from handler' });
      done();
    });
  });

  it('returns cached response on cache hit without calling next', () => {
    const middleware = cacheResponse({ ttl: 5000, store });
    const req = { originalUrl: '/api/escrow/123' };
    const res = createMockRes();

    store.set('/api/escrow/123', { data: 'cached' }, 5000);

    let nextCalled = false;
    middleware(req, res, () => { nextCalled = true; });

    expect(nextCalled).toBe(false);
    expect(res.body).toEqual({ data: 'cached' });
    expect(res.headers['X-Cache']).toBe('HIT');
  });

  it('does not cache non-2xx responses', (done) => {
    const middleware = cacheResponse({ ttl: 5000, store });
    const req = { originalUrl: '/api/escrow/bad' };
    const res = createMockRes();

    middleware(req, res, () => {
      res.status(500).json({ error: 'fail' });

      expect(res.body).toEqual({ error: 'fail' });
      expect(store.get('/api/escrow/bad')).toBeUndefined();
      done();
    });
  });

  it('uses custom keyFn to generate cache key', (done) => {
    const keyFn = (r) => `custom:${r.params.id}`;
    const middleware = cacheResponse({ ttl: 5000, store, keyFn });
    const req = { originalUrl: '/api/escrow/456', params: { id: '456' } };
    const res = createMockRes();

    middleware(req, res, () => {
      res.json({ data: 'keyed' });
      expect(store.get('custom:456')).toEqual({ data: 'keyed' });
      done();
    });
  });

  it('falls through to handler when cache store throws', (done) => {
    const brokenStore = {
      get() { throw new Error('store broken'); },
      set() { throw new Error('store broken'); },
    };
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const middleware = cacheResponse({ ttl: 5000, store: brokenStore });
    const req = { originalUrl: '/api/escrow/123' };
    const res = createMockRes();

    middleware(req, res, () => {
      res.json({ data: 'fallthrough' });
      expect(res.body).toEqual({ data: 'fallthrough' });
      expect(warnSpy).toHaveBeenCalled();
      warnSpy.mockRestore();
      done();
    });
  });

  it('logs warning but still sends response when cache store set throws', (done) => {
    const setErrorStore = {
      get() { return undefined; },
      set() { throw new Error('set broken'); },
    };
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const middleware = cacheResponse({ ttl: 5000, store: setErrorStore });
    const req = { originalUrl: '/api/escrow/789' };
    const res = createMockRes();

    middleware(req, res, () => {
      res.json({ data: 'still works' });
      expect(res.body).toEqual({ data: 'still works' });
      expect(warnSpy).toHaveBeenCalledWith('Cache store set error:', 'set broken');
      warnSpy.mockRestore();
      done();
    });
  });
});
