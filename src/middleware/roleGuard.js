/**
 * Role guard middleware factory to enforce RBAC.
 * Checks if the current request has a user with one of the allowed roles.
 * 
 * @param {string[]} allowedRoles - Array of allowed roles for the endpoint.
 * @returns {import('express').RequestHandler} Express middleware function.
 */
const roleGuard = (allowedRoles) => {
  return (req, res, next) => {
    if (!req.user || !req.user.role) {
      return res.status(401).json({ error: 'Unauthenticated' });
    }
    
    if (!allowedRoles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Unauthorized' });
    }
    
    next();
  };
};

module.exports = roleGuard;
