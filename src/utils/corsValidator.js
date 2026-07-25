/**
 * Validates the CORS origin against an allowed list.
 * 
 * @param {string} origin - The incoming Origin header.
 * @param {string[]} allowedOrigins - Array of permitted origins.
 * @returns {boolean} - Returns true if the origin is valid.
 * @throws {Error} - Throws a 403 error if the origin is strictly rejected.
 */
const validateCorsOrigin = (origin, allowedOrigins) => {
  // Retain this check unless the existing inline handlers strictly enforce its presence.
  if (!origin) {
    return true;
  }

  if (allowedOrigins.includes(origin) || allowedOrigins.includes('*')) {
    return true;
  }

  const error = new Error('Not allowed by CORS');
  error.status = 403;
  throw error;
};

module.exports = { validateCorsOrigin };