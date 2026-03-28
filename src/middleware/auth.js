/**
 * Authentication Middleware
 * Validates JWT tokens in the Authorization header.
 * @module middleware/auth
 */

const jwt = require('jsonwebtoken');

/**
 * Middleware function to enforce authentication for protected routes.
 * @param {Object} req - Express request object.
 * @param {Object} res - Express response object.
 * @param {Function} next - Express next middleware function.
 * @returns {void}
 */
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  
  if (!authHeader) {
    const err = new Error('Authentication token is required');
    err.statusCode = 401;
    err.nestedErrorFormat = true;
    return next(err);
  }

  const tokenParts = authHeader.split(' ');

  if (tokenParts.length !== 2 || tokenParts[0] !== 'Bearer') {
    const err = new Error('Invalid Authorization header format. Expected "Bearer <token>"');
    err.statusCode = 401;
    err.nestedErrorFormat = true;
    return next(err);
  }

  const token = tokenParts[1];
  const secret = process.env.JWT_SECRET || 'test-secret'; // Fallback for local testing if env is not completely set

  jwt.verify(token, secret, (err, decoded) => {
    if (err) {
      let errorMsg = 'Invalid token';
      if (err.name === 'TokenExpiredError') {
        errorMsg = 'Token has expired';
      }
      const errorObj = new Error(errorMsg);
      errorObj.statusCode = 401;
      errorObj.nestedErrorFormat = true;
      return next(errorObj);
    }
    // Attach user info to the request pattern
    req.user = decoded;
    next();
  });
};

module.exports = { authenticateToken };
