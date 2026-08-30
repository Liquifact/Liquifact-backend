'use strict';

const crypto = require('crypto');
const db = require('../db/knex');
const logger = require('../logger');
const metrics = require('../metrics');

/**
 * Asynchronously records the last-used timestamp for an API key.
 * Fires and forgets – any error is logged but does not affect the request.
 * @param {string} key - The raw API key string (already validated).
 * @param {string} clientId - The client identifier.
 * @param {string} [tenantId] - Tenant scoped identifier (may be undefined).
 */
function recordApiKeyUsage(key, clientId, tenantId) {
  // Hash the key using SHA-256 to match key_hash in the database.
  // We use hex format as standard, but let's double check if we need to encode it differently.
  // The system uses timingSafeStringEqual comparing sha256 digests in apiKeyAuth.js.
  // wait, in apiKeyAuth.js: `crypto.createHash('sha256').update(a).digest()`
  // So the digest is a buffer. If stored in DB as text, it's typically hex. 
  // Let's use hex.
  const keyHash = crypto.createHash('sha256').update(key).digest('hex');

  const query = db('api_keys')
    .where('key_hash', keyHash)
    .update({ last_used_at: db.fn.now() });
    
  if (tenantId) {
    query.andWhere('tenant_id', tenantId);
  }

  query
    .then(() => {
      // Optional metrics can be added here if defined in metrics.js
      if (metrics.apiKeyUsageSuccess && typeof metrics.apiKeyUsageSuccess.inc === 'function') {
        metrics.apiKeyUsageSuccess.inc({ clientId, tenantId: tenantId || 'none' });
      }
    })
    .catch((err) => {
      logger.error({ err, clientId, tenantId }, 'Failed to record API key usage');
      if (metrics.apiKeyUsageErrors && typeof metrics.apiKeyUsageErrors.inc === 'function') {
        metrics.apiKeyUsageErrors.inc({ clientId, tenantId: tenantId || 'none' });
      }
    });
}

module.exports = { recordApiKeyUsage };
