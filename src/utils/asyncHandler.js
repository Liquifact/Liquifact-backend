/**
 * Wrap async route handlers to forward errors to Express middleware.
 * Eliminates need for try/catch in every controller.
 *
 * @param {Function} fn - Async route handler
 * @returns {Function} Express middleware
 */
const asyncHandler = (fn) => {
  return function (req, res, next) {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
};

module.exports = asyncHandler;