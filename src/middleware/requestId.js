const { v4: uuidv4 } = require('uuid');
const logger = require('../utils/logger');

/**
 * Middleware that generates or propagates a correlation ID for each request.
 * It injects the ID into the logger via AsyncLocalStorage and adds it to the response headers.
 */
function requestId(req, res, next) {
  // Use existing X-Request-Id if present (for cross-service tracing), otherwise generate new one.
  const correlationId = req.get('X-Request-Id') || uuidv4();

  // Expose it on the response for client-side tracing and debugging.
  res.setHeader('X-Request-Id', correlationId);
  req.id = correlationId;

  // Run the rest of the request within the context of the AsyncLocalStorage store.
  logger.storage.run(correlationId, () => {
    next();
  });
}

module.exports = requestId;
