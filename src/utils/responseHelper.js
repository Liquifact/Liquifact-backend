/**
 * Response Helper Utilities
 * Standardizes API responses with data, meta, and error fields.
 */

const API_VERSION = '0.1.0';

/**
 * Creates a standard success response envelope.
 *
 * @param {any} data - The primary data payload.
 * @param {Object} [meta={}] - Additional metadata (e.g., pagination, status).
 * @returns {Object} Standardized Response Envelope
 */
const success = (data, meta = {}) => ({
  data,
  meta: {
    ...meta,
    timestamp: new Date().toISOString(),
    version: API_VERSION,
  },
  error: null,
});

/**
 * Creates a standard error response envelope.
 *
 * @param {string} message - A human-readable error description.
 * @param {string} code - A unique error code for clients to handle.
 * @param {any} [details=null] - Optional additional error context.
 * @returns {Object} Standardized Error Response Envelope
 */
const error = (message, code = 'INTERNAL_ERROR', details = null) => ({
  data: null,
  meta: {
    timestamp: new Date().toISOString(),
    version: API_VERSION,
  },
  error: {
    message,
    code,
    details,
  },
});

module.exports = {
  success,
  error,
};
