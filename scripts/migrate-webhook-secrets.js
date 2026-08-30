'use strict';

/**
 * @fileoverview One-off CLI runner for the legacy webhook-secret migration.
 *
 * Usage:
 *   node scripts/migrate-webhook-secrets.js
 *
 * Idempotent and safe to re-run: already-hashed and invalid records are
 * skipped, and each tenant's change is transactional, so an interrupted run
 * simply continues on the next invocation. Prints the counts-only summary.
 */

const { runMigration } = require('../src/services/webhookSecretMigration');

runMigration()
  .then((summary) => {
    console.log('webhook-secret-migration completed', JSON.stringify(summary));
    process.exitCode = 0;
  })
  .catch((err) => {
    console.error('webhook-secret-migration failed:', err && err.message ? err.message : String(err));
    process.exitCode = 1;
  });