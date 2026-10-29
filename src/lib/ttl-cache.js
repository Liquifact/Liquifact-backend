/*
 * In-process TTA cache with single-flight, stale-while-revalidate,
 * bounded LRU size and negative caching of failures.
 *
 * Usage:
 *   const cache = createTtlCache();
 *   const { value, status, ageMs, fetchedAt } =
 *     await cache.getOrLoad('key', () => fetchValue(), { ttlMs: 5000, staleMs: 60000 });
 *
 * Semantics:
 *   - Fresh hit (age <= ttlMs): returns cached value, status 'hit'.
 *   - Stale hit (ttlMs < age <= ttlMs + staleMs): returns cached value
 *     with status 'stale' and kicks off a single background refresh.
 *   - Miss: awaits the loader (single-flighted per key), status 'miss'.
 *   - Failure: negative-cached for errorTtlMs (no loader recall during that
 *     window), then rejected to the caller.
 *
 * The cache is bounded to `maxEntries` (default 500) with LRU eviction.
 */

'use strict';

const DEFAULT_MAX_ENTRIES = 500;
const DEFAULT_ERROR_TTL_MS = 2000;

class TtlCache {
  constructor(options = {}) {
    this.maxEntries = Number.isFinite(options.maxEntries) && options.maxEntries > 0
      ? Math.floor(options.maxEntries)
      : DEFAULT_MAX_ENTRIES;
    this.errorTtlMs = Number.isFinite(options.errorTtlMs) && options.errorTtlMs >= 0
      ? options.errorTtlMs
      : DEFAULT_ERROR_TTL_MS;
    // Map preserves insertion order; we re-insert on access to approximate LRU.
    this.entries = new Map();
    // key -> Promise representing the in-flight load.
    this.inflight = new Map();
  }

  /** Number of cached entries (including negative entries). */
  size() {
    return this.entries.size;
  }

  /** Number of in-flight loads. */
  inflightCount() {
    return this.inflight.size;
  }

  /** Remove a single key from the cache. */
  delete(key) {
    return this.entries.delete(key);
  }

  /** Clear all cached entries (in-flight loads continue). */
  clear() {
    this.entries.clear();
  }

  /**
   * Return the cached value for `key` or load it via `loader`.
   *
   * Options:
   *   - ttlMs:      how long a value is considered fresh (required)
   *   - staleMs:    how long beyond ttlMs a value may be served stale (default 0)
   *   - errorTtlMs: optional override of the instance negative TTL
   *   - fresh:      bypass the cache and force a load (still single-flighted)
   *
   * Resolves to `{ value, status, ageMs, fetchedAt }`.
   *   - status: 'hit' | 'miss' | 'stale'
   *   - ageMs: ms since the value was fetched
   *   - fetchedAt: Epoch ms of the load that produced the value
   */
  async getOrLoad(key, loader, options = {}) {
    if (typeof loader !== 'function') {
      throw new TypeError('ttl-cache: loader must be a function');
    }

    const ttlMs = Number.isFinite(options.ttlMs) ? options.ttlMs : 0;
    const staleMs = Number.isFinite(options.staleMs) ? options.staleMs : 0;
    const errorTtlMs = Number.isFinite(options.errorTtlMs)
      ? options.errorTtlMs
      : this.errorTtlMs;
    const forceFresh = options.fresh === true;

    const now = Date.now();
    const entry = this.entries.get(key);

    if (entry && !entry.isError) {
      const ageMs = now - entry.fetchedAt;
      if (!forceFresh && ageMs <= ttlMs) {
        this.touch(key, entry);
        return {
          value: entry.value,
          status: 'hit',
          ageMs,
          fetchedAt: entry.fetchedAt,
        };
      }
      if (!forceFresh && ageMs <= ttlMs + staleMs) {
        // Stale: serve immediately and refresh in the background.
        this.touch(key, entry);
        this.startBackgroundRefresh(key, loader, errorTtlMs);
        return {
          value: entry.value,
          status: 'stale',
          ageMs,
          fetchedAt: entry.fetchedAt,
        };
      }
    }

    if (entry && entry.isError && !forceFresh) {
      const ageMs = now - entry.fetchedAt;
      if (ageMs <= entry.errorTtlMs) {
        // Negative cache: reject without calling the loader again.
        this.touch(key, entry);
        throw entry.error;
      }
    }

    // Miss (or forced refresh): coalesce through the in-flight map.
    const result = await this.loadSingleFlight(key, loader, errorTtlMs);
    return {
      value: result.value,
      status: 'miss',
      ageMs: 0,
      fetchedAt: result.fetchedAt,
    };
  }

  /**
   * Synchronous peek at the cache without triggering loads. Returns null
   * when nothing useable is cached. Useful for fallback paths.
   */
  peek(key) {
    const entry = this.entries.get(key);
    if (!entry || entry.isError) {
      return null;
    }
    return {
      value: entry.value,
      ageMs: Date.now() - entry.fetchedAt,
      fetchedAt: entry.fetchedAt,
    };
  }

  // -- internals --

  touch(key, entry) {
    // Move to the end of the Map to mark as most-recently used.
    this.entries.delete(key);
    this.entries.set(key, entry);
  }

  setEntry(key, entry) {
    if (this.entries.has(key)) {
      this.entries.delete(key);
    }
    this.entries.set(key, entry);
    this.evictIfOver();
  }

  evictIfOver() {
    while (this.entries.size > this.maxEntries) {
      const oldestKey = this.entries.keys().next().value;
      if (oldestKey === undefined) {
        break;
      }
      this.entries.delete(oldestKey);
    }
  }

  loadSingleFlight(key, loader, errorTtlMs) {
    const existing = this.inflight.get(key);
    if (existing) {
      return existing;
    }

    const promise = (async () => {
      try {
        const value = await loader();
        const fetchedAt = Date.now();
        this.setEntry(key, {
          value,
          fetchedAt,
          isError: false,
          error: null,
          errorTtlMs: 0,
        });
        return { value, fetchedAt };
      } catch (err) {
        const fetchedAt = Date.now();
        // Negative cache the failure. Do not overwrite a good value that may
        // still be servable as stale -- the caller decides what to do with it.
        const current = this.entries.get(key);
        if (!current || current.isError) {
          this.setEntry(key, {
            value: undefined,
            fetchedAt,
            isError: true,
            error: err,
            errorTtlMs,
          });
        }
        throw err;
      } finally {
        this.inflight.delete(key);
      }
    })();

    this.inflight.set(key, promise);
    return promise;
  }

  startBackgroundRefresh(key, loader, errorTtlMs) {
    if (this.inflight.has(key)) {
      return;
    }
    // Fire-and-forget; errors are negative-cached by loadSingleFlight.
    this.loadSingleFlight(key, loader, errorTtlMs).catch(() => {});
  }
}

function createTtlCache(options) {
  return new TtlCache(options);
}

module.exports = {
  TtlCache,
  createTtlCache,
  DEFAULT_MAX_ENTRIES,
  DEFAULT_ERROR_TTL_MS,
};
