const { sanitizeValue } = require('../utils/sanitization');

/**
 * Express middleware that sanitizes common user-supplied input containers.
 *
 * The middleware mutates request references with sanitized copies so downstream
 * handlers always receive normalized values.
 *
 * @param {import('express').Request} req Express request.
 * @param {import('express').Response} _res Express response.
 * @param {import('express').NextFunction} next Express next callback.
 * @returns {void}
 */
function sanitizeInput(req, _res, next) {
  req.body = sanitizeValue(req.body);

  let sanitizedQuery = sanitizeValue(req.query);
  Object.defineProperty(req, 'query', {
    configurable: true,
    enumerable: true,
    /**
     * Gets the sanitized query object.
     *
     * @returns {object} Sanitized query object.
     */
    get() {
      return sanitizedQuery;
    },
    /**
     * Re-sanitizes the query object when Express reassigns it.
     *
     * @param {object} value New query object.
     * @returns {void}
     */
    set(value) {
      sanitizedQuery = sanitizeValue(value);
    },
  });

  let sanitizedParams = sanitizeValue(req.params);
  Object.defineProperty(req, 'params', {
    configurable: true,
    enumerable: true,
    /**
     * Gets sanitized route params.
     *
     * @returns {object} Sanitized params.
     */
    get() {
      return sanitizedParams;
    },
    /**
     * Re-sanitizes route params when Express updates them.
     *
     * @param {object} value New params object.
     * @returns {void}
     */
    set(value) {
      sanitizedParams = sanitizeValue(value);
    },
  });

  next();
}

module.exports = {
  sanitizeInput,
};
