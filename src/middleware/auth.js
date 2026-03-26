const jwt = require('jsonwebtoken');

/**
 * Authentication middleware — validates Bearer JWT tokens.
 *
 * @param {import('express').Request} req - Express request.
 * @param {import('express').Response} res - Express response.
 * @param {import('express').NextFunction} next - Express next callback.
 * @returns {void}
 */
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];

  if (!authHeader) {
    res.status(401).json({ error: 'Authentication token is required' });
    return;
  }

  const parts = authHeader.split(' ');
  if (parts.length !== 2 || parts[0] !== 'Bearer') {
    res.status(401).json({ error: 'Invalid Authorization header format. Expected "Bearer <token>"' });
    return;
  }

  const token = parts[1];
  const secret = process.env.JWT_SECRET || 'test-secret';

  try {
    const decoded = jwt.verify(token, secret);
    req.user = decoded;
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      res.status(401).json({ error: 'Token has expired' });
      return;
    }
    res.status(401).json({ error: 'Invalid token' });
  }
};

module.exports = { authenticateToken };
