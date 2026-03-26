/**
 * RoleGuard Middleware Factory
 * Checks if the authenticated user has one of the allowed roles.
 * @module middleware/roleGuard
 */

/**
 * Creates a middleware to guard routes by roles.
 * Must be used after an authentication middleware that sets `req.user`.
 * 
 * @param {string[]} allowedRoles - Array of roles allowed to access the route.
 * @returns {import('express').RequestHandler} Express middleware
 */
const roleGuard = (allowedRoles) => {
  return (req, res, next) => {
    // Ensure authentication middleware ran first
    if (!req.user) {
      return res.status(401).json({ error: 'User is not authenticated' });
    }

    if (!req.user.role || !allowedRoles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Forbidden: Insufficient privileges' });
    }

    next();
  };
};

module.exports = { roleGuard };
