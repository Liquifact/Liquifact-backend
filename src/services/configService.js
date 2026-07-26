'use strict';

/**
 * @fileoverview Service layer for runtime configuration management.
 *
 * Encapsulates business logic for applying runtime configuration changes,
 * including CORS configuration updates and logging. This service is
 * consumed by route handlers to keep HTTP concerns separate from business logic.
 *
 * @module services/configService
 */

const { reloadCorsOrigins, reloadCorsMaxAge } = require('../config/cors');
const logger = require('../logger');

/**
 * Applies runtime configuration changes for a given section.
 *
 * Currently handles:
 * - CORS section: updates environment variables and reloads CORS configuration
 *
 * Future sections (webhook, reconciliation, kyc, retention, fraudThresholds)
 * can be added here as their runtime application logic is implemented.
 *
 * @param {string} section - The configuration section being updated.
 * @param {object} config - The validated configuration payload for the section.
 * @param {object} context - Contextual information for logging.
 * @param {string} context.tenantId - The tenant ID for the request.
 * @param {string} context.adminClient - The admin client identifier (user or API key).
 * @returns {{ section: string, config: object, message: string }} Result object.
 * @throws {Error} If the section is not supported or application fails.
 */
function applyConfig(section, config, context) {
  const { tenantId, adminClient } = context;

  // Apply runtime configuration changes for supported sections.
  if (section === 'cors') {
    applyCorsConfig(config);
  }

  // Log the configuration update for audit purposes.
  logger.info(
    {
      tenantId,
      section,
      adminClient,
    },
    'Admin runtime config update accepted',
  );

  return {
    section,
    config,
    message: `Configuration section '${section}' validated and accepted.`,
  };
}

/**
 * Applies CORS-specific configuration changes.
 *
 * Updates environment variables and reloads the CORS configuration
 * so that changes take effect without restarting the server.
 *
 * @param {object} config - The validated CORS configuration payload.
 * @param {string[]} [config.origins] - Array of allowed origin URLs.
 * @param {number} [config.maxAge] - Preflight max-age in seconds.
 * @returns {void}
 */
function applyCorsConfig(config) {
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

/**
 * Returns the list of valid configuration section names.
 *
 * This is a thin wrapper around the CONFIG_SECTIONS constant from
 * the schemas module, provided for convenience and to keep the
 * service as the single source of truth for config-related operations.
 *
 * @returns {string[]} Array of valid section names.
 */
function getConfigSections() {
  const { CONFIG_SECTIONS } = require('../schemas/config');
  return CONFIG_SECTIONS;
}

module.exports = {
  applyConfig,
  applyCorsConfig,
  getConfigSections,
};
