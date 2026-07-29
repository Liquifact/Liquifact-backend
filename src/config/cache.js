const DEFAULT_ESCROW_TTL_SECONDS = 30;
const DEFAULT_ESCROW_MAX_ENTRIES = 500;

const DEFAULT_INVOICE_STATE_TTL_SECONDS = 30;
const DEFAULT_INVOICE_STATE_MAX_ENTRIES = 500;

/**
 * Parses cache configuration from environment variables.
 * Falls back to defaults when values are missing or invalid.
 *
 * @param {NodeJS.ProcessEnv} env - Environment variables to read from.
 * @returns {{ escrowTtl: number, escrowMaxEntries: number, invoiceStateTtl: number, invoiceStateMaxEntries: number }} Cache configuration.
 */
function parseCacheConfig(env = process.env) {
  const escrowRaw = env.ESCROW_CACHE_TTL_SECONDS;
  const escrowParsed = parseInt(escrowRaw, 10);
  const escrowSeconds = Number.isFinite(escrowParsed) && escrowParsed > 0
    ? escrowParsed
    : DEFAULT_ESCROW_TTL_SECONDS;
  const escrowRawMaxEntries = Number.parseInt(env.ESCROW_CACHE_MAX_ENTRIES, 10);
  const escrowMaxEntries = Number.isFinite(escrowRawMaxEntries) && escrowRawMaxEntries > 0
    ? escrowRawMaxEntries
    : DEFAULT_ESCROW_MAX_ENTRIES;

  const invoiceStateRaw = env.INVOICE_STATE_CACHE_TTL_SECONDS;
  const invoiceStateParsed = parseInt(invoiceStateRaw, 10);
  const invoiceStateSeconds = Number.isFinite(invoiceStateParsed) && invoiceStateParsed > 0
    ? invoiceStateParsed
    : DEFAULT_INVOICE_STATE_TTL_SECONDS;
  const invoiceStateRawMaxEntries = Number.parseInt(env.INVOICE_STATE_CACHE_MAX_ENTRIES, 10);
  const invoiceStateMaxEntries = Number.isFinite(invoiceStateRawMaxEntries) && invoiceStateRawMaxEntries > 0
    ? invoiceStateRawMaxEntries
    : DEFAULT_INVOICE_STATE_MAX_ENTRIES;

  return {
    escrowTtl: escrowSeconds * 1000,
    escrowMaxEntries,
    invoiceStateTtl: invoiceStateSeconds * 1000,
    invoiceStateMaxEntries,
  };
}

const cacheConfig = parseCacheConfig();

module.exports = {
  cacheConfig,
  parseCacheConfig,
};
