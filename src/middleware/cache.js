/**
 * Creates an Express middleware that caches JSON responses with a TTL.
 *
 * On cache hit, returns the cached JSON and sets X-Cache: HIT header.
 * On cache miss, intercepts res.json() to capture and cache 2xx responses,
 * then sets X-Cache: MISS header.
 *
 * Cache store errors are caught and logged — the request falls through
 * to the route handler so the cache never blocks a request.
 *
 * @param {object} options - Middleware configuration.
 * @param {number} options.ttl - Cache TTL in milliseconds.
 * @param {object} options.store - Cache store instance with get/set methods.
 * @param {Function} [options.keyFn] - Function to derive cache key from request. Defaults to req.originalUrl.
 * @returns {Function} Express middleware function.
 */
function cacheResponse({ ttl, store, keyFn }) {
  /**
   * Resolves the cache key for a given request.
   *
   * @param {import('express').Request} req - The Express request.
   * @returns {string} The cache key.
   */
  const resolveKey = keyFn || ((req) => req.originalUrl);

  return (req, res, next) => {
    let cached;
    const key = resolveKey(req);

    try {
      cached = store.get(key);
    } catch (err) {
      console.warn('Cache store get error, falling through:', err.message);
      return next();
    }

    if (cached !== undefined) {
      res.set('X-Cache', 'HIT');
      return res.json(cached);
    }

    res.set('X-Cache', 'MISS');

    const originalJson = res.json.bind(res);

    /**
     * Patched res.json that caches 2xx responses before sending.
     *
     * @param {*} body - The response body to send.
     * @returns {object} The Express response.
     */
    res.json = (body) => {
      if (res.statusCode >= 200 && res.statusCode < 300) {
        try {
          store.set(key, body, ttl);
        } catch (err) {
          console.warn('Cache store set error:', err.message);
        }
      }
      return originalJson(body);
    };

    return next();
  };
}

module.exports = {
  cacheResponse,
};
