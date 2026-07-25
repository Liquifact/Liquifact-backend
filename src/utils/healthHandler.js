'use strict';

const SERVICE_NAME = 'liquifact-api';

/**
 * Creates an Express handler for a readiness-style health check.
 *
 * Keeping the result validation and error mapping here ensures every health
 * handler returns the same response shape and status codes.
 *
 * @param {() => Promise<{healthy: boolean, checks: object}>} checkHealth
 *   Health-check function invoked for each request.
 * @returns {import('express').RequestHandler} Express request handler.
 */
function createHealthHandler(checkHealth) {
  return async function healthHandler(req, res) {
    try {
      const { healthy, checks } = await checkHealth();
      const status = healthy ? 200 : 503;

      return res.status(status).json({
        ready: healthy,
        service: SERVICE_NAME,
        timestamp: new Date().toISOString(),
        checks,
      });
    } catch (error) {
      return res.status(503).json({
        ready: false,
        service: SERVICE_NAME,
        timestamp: new Date().toISOString(),
        error: error.message,
      });
    }
  };
}

module.exports = { createHealthHandler };
