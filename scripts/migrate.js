#!/usr/bin/env node

/**
 * Deprecation stub for the retired legacy SQLite API key migration script.
 *
 * The SQLite-backed API key store and its `API_KEYS_DB_PATH` configuration
 * have been retired in favour of the env-backed registry implemented by
 * `src/middleware/apiKeyAuth.js` (see issue #590). No SQLite connection is
 * opened per request, and this script no longer performs any migration.
 *
 * This stub is intentionally non-destructive: it prints a clear deprecation
 * notice and exits 0 so any external CI/deploy pipeline that still invokes
 * the original filename fails gracefully instead of throwing on a missing
 * file. To configure API keys, use the `API_KEYS` environment variable.
 *
 * @see docs/configuration.md
 * @see src/middleware/apiKeyAuth.js
 */

process.stderr.write(
  
  '[liquifact] scripts/migrate.js is deprecated and no longer performs any ' +
    'work. The SQLite API key store has been retired (issue #590); configure ' +
    'API keys via the API_KEYS environment variable. Exiting cleanly.\n'
);
process.exit(0);
