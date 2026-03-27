const DEFAULT_ESCROW_TTL_SECONDS = 30;

/**
 * Parses the escrow cache TTL from environment variables.
 * Falls back to the default if the value is missing or not a valid number.
 *
 * @param {NodeJS.ProcessEnv} env - Environment variables to read from.
 * @returns {{ escrowTtl: number }} Cache configuration with TTL in milliseconds.
 */
function parseCacheConfig(env = process.env) {
  const raw = env.ESCROW_CACHE_TTL_SECONDS;
  const parsed = parseInt(raw, 10);
  const seconds = Number.isFinite(parsed) && parsed > 0
    ? parsed
    : DEFAULT_ESCROW_TTL_SECONDS;

  return {
    escrowTtl: seconds * 1000,
  };
}

const cacheConfig = parseCacheConfig();

module.exports = {
  cacheConfig,
  parseCacheConfig,
};
