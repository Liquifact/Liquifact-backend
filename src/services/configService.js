'use strict';

/**
 * @fileoverview Business logic for applying validated runtime configuration
 * writes accepted by `POST /api/admin/config`.
 *
 * Extracted from `src/routes/adminConfig.js` (issue #879) so the route
 * handler stays a thin HTTP layer (auth, validation, logging, response
 * shaping) while the actual runtime side effects live here.
 *
 * @module services/configService
 */

const { reloadCorsOrigins, reloadCorsMaxAge } = require('../config/cors');

/**
 * Applies the runtime side effects for a validated configuration section.
 *
 * Currently only the `cors` section has an apply-time effect: it updates the
 * relevant environment variable(s) and triggers the corresponding reload so
 * the change takes effect without a server restart. All other sections are
 * validated and echoed back by the route but have no runtime effect yet, so
 * they are a no-op here.
 *
 * @param {string} section - The configuration section name (e.g. 'cors').
 * @param {object} config - The validated, section-specific config payload.
 * @returns {void}
 */
function applyConfigSection(section, config) {
  if (section === 'cors') {
    if (config.origins) {
      // Update the env var so reloadCorsOrigins can re-read it.
      process.env.CORS_ALLOWED_ORIGINS = config.origins.join(',');
      reloadCorsOrigins();
    }
    if (config.maxAge !== undefined) {
      process.env.CORS_MAX_AGE = String(config.maxAge);
      reloadCorsMaxAge();
    }
  }
}

module.exports = {
  applyConfigSection,
};
