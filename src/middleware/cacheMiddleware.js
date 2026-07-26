
const createCacheMiddleware = (cacheStore, keyGenerator) => {
  return (req, res, next) => {
    // Respect client no-cache bypass
    if (req.headers['cache-control'] === 'no-cache') {
      res.setHeader('X-Cache', 'MISS');
      return next();
    }

    const key = keyGenerator(req);
    const cachedBody = cacheStore.get(key, req.path);

    if (cachedBody) {
      res.setHeader('X-Cache', 'HIT');
      return res.json(cachedBody);
    }

    res.setHeader('X-Cache', 'MISS');
    const originalJson = res.json.bind(res);

    res.json = (body) => {
      if (res.statusCode >= 200 && res.statusCode < 300) {
        cacheStore.set(key, body);
      }
      return originalJson(body);
    };

    next();
  };
};

module.exports = createCacheMiddleware;
