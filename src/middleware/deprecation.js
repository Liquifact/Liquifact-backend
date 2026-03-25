/**
 * Middleware to signal API deprecation via HTTP headers (RFC 8594).
 * * @param {Object} options - Configuration for the deprecation headers.
 * @param {string} [options.sunset] - ISO 8601 date string (e.g., '2026-12-31T23:59:59Z').
 * @param {string} [options.link] - URL pointing to migration documentation or new endpoint.
 * @returns {Function} Express middleware function.
 */
const deprecate = (options = {}) => {
  return (req, res, next) => {
    // Standard Deprecation header
    res.setHeader('Deprecation', 'true');

    if (options.sunset) {
      const sunsetDate = new Date(options.sunset);
      // Ensure the date is valid before setting header
      if (!isNaN(sunsetDate.getTime())) {
        res.setHeader('Sunset', sunsetDate.toUTCString());
      }
    }

    if (options.link) {
      // rel="deprecation" is the RFC-standard link relation
      res.setHeader('Link', `<${options.link}>; rel="deprecation"`);
    }

    next();
  };
};

module.exports = { deprecate };
