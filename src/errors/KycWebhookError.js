'use strict';

/**
 * @fileoverview Structured error for KYC webhook handlers.
 *
 * Carries an HTTP status and a machine-readable error code through the
 * Express error chain so that {@link module:middleware/kycWebhookErrorHandler}
 * can produce a consistent structured response without per-handler
 * duplication.
 *
 * @module errors/KycWebhookError
 */

/**
 * Lightweight error class that pairs an HTTP status with an application
 * error code for KYC webhook ingestion and listing endpoints.
 */
class KycWebhookError extends Error {
  /**
   * @param {string} message  - Human-readable error description.
   * @param {number} status   - HTTP status code (400, 401, 403, 500, 503).
   * @param {string} code     - Machine-readable error code (e.g. 'missing_secret').
   */
  constructor(message, status, code) {
    super(message);
    this.name = 'KycWebhookError';
    this.status = status;
    this.code = code;
  }
}

module.exports = KycWebhookError;
