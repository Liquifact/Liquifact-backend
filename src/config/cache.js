const DEFAULT_ESCROW_TTL_SECONDS = 30;
const DEFAULT_ESCROW_MAX_ENTRIES = 500;
const DEFAULT_INDEXER_TTL_SECONDS = 10;
const DEFAULT_INDEXER_MAX_ENTRIES = 200;

/**
 * Parses the escrow cache TTL from environment variables.
 * Falls back to the default if the value is missing or not a valid number.
 *
 * @param {NodeJS.ProcessEnv} env - Environment variables to read from.
 * @returns {{ escrowTtl: number, escrowMaxEntries: number, indexerTtl: number, indexerMaxEntries: number }} Cache configuration.
 */
function parseCacheConfig(env = process.env) {
  const raw = env.ESCROW_CACHE_TTL_SECONDS;
  const parsed = parseInt(raw, 10);
  const seconds = Number.isFinite(parsed) && parsed > 0
    ? parsed
    : DEFAULT_ESCROW_TTL_SECONDS;
  const rawMaxEntries = Number.parseInt(env.ESCROW_CACHE_MAX_ENTRIES, 10);
  const maxEntries = Number.isFinite(rawMaxEntries) && rawMaxEntries > 0
    ? rawMaxEntries
    : DEFAULT_ESCROW_MAX_ENTRIES;

  const rawIndexerTtl = parseInt(env.INDEXER_CACHE_TTL_SECONDS, 10);
  const indexerTtl = Number.isFinite(rawIndexerTtl) && rawIndexerTtl > 0
    ? rawIndexerTtl
    : DEFAULT_INDEXER_TTL_SECONDS;

  const rawIndexerMax = parseInt(env.INDEXER_CACHE_MAX_ENTRIES, 10);
  const indexerMaxEntries = Number.isFinite(rawIndexerMax) && rawIndexerMax > 0
    ? rawIndexerMax
    : DEFAULT_INDEXER_MAX_ENTRIES;

  return {
    escrowTtl: seconds * 1000,
    escrowMaxEntries: maxEntries,
    indexerTtl: indexerTtl * 1000,
    indexerMaxEntries,
  };
}

const cacheConfig = parseCacheConfig();

module.exports = {
  cacheConfig,
  parseCacheConfig,
};
