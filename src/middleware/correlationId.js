const { randomUUID } = require('crypto');

const CORRELATION_HEADER = 'x-correlation-id';
const CORRELATION_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

/**
 * Attach a validated correlation ID to the request and response.
 *
 * @param {import('express').Request} req Request object.
 * @param {import('express').Response} res Response object.
 * @param {import('express').NextFunction} next Next middleware.
 * @returns {void}
 */
function correlationIdMiddleware(req, res, next) {
  const candidate = req.header(CORRELATION_HEADER);
  const correlationId =
    typeof candidate === 'string' && CORRELATION_ID_PATTERN.test(candidate)
      ? candidate
      : `req_${randomUUID().replace(/-/g, '').slice(0, 24)}`;

  req.correlationId = correlationId;
  res.setHeader('X-Correlation-Id', correlationId);
  next();
}

module.exports = {
  CORRELATION_HEADER,
  correlationIdMiddleware,
};
