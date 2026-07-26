const DEFAULT_ESCROW_TTL_SECONDS = 30;
const DEFAULT_ESCROW_MAX_ENTRIES = 100;

/**
 * Parses the escrow cache TTL from environment variables.
 * Falls back to the default if the value is missing or not a valid number.
 *
 * @param {NodeJS.ProcessEnv} env - Environment variables to read from.
 * @returns {{ escrowTtl: number, escrowMaxEntries: number }} Cache configuration.
 */
function parseCacheConfig(env = process.env) {
  const raw = env.ESCROW_CACHE_TTL_SECONDS;
  const parsed = parseInt(raw, 10);
  const seconds = Number.isFinite(parsed) && parsed > 0
    ? parsed
    : DEFAULT_ESCROW_TTL_SECONDS;
  const rawMaxEntries = env.ESCROW_CACHE_MAX_ENTRIES;
  const parsedMaxEntries = parseInt(rawMaxEntries, 10);
  const maxEntries = Number.isFinite(parsedMaxEntries) && parsedMaxEntries > 0
    ? parsedMaxEntries
    : DEFAULT_ESCROW_MAX_ENTRIES;

  return {
    escrowTtl: seconds * 1000,
    escrowCacheMaxEntries: maxEntries,
  };
}

const cacheConfig = parseCacheConfig();

module.exports = {
  cacheConfig,
  parseCacheConfig,
  DEFAULT_ESCROW_MAX_ENTRIES,
};
