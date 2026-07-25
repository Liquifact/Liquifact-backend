/**
 * Authentication Middleware
 * Validates JWT tokens in the Authorization header.
 * @module middleware/auth
 */

'use strict';

const jwt = require('jsonwebtoken');
const AppError = require('../errors/AppError');
const configModule = require('../config');

/**
 * Resolve JWT verification configuration from the validated app config.
 * A weak literal fallback is only allowed in test mode so isolated middleware
 * tests can run before boot validation. Non-test environments must never
 * authenticate with an unvalidated or missing secret.
 *
 * @param {string} instance - Request path for RFC 7807 error metadata.
 * @returns {{JWT_SECRET: string, JWT_ALGORITHMS?: string, JWT_ISSUER?: string, JWT_AUDIENCE?: string}} JWT config.
 * @throws {AppError} When config is unavailable outside test mode.
 */
function resolveJwtConfig(instance) {
  try {
    return configModule.get();
  } catch (_err) {
    if (process.env.NODE_ENV === 'test') {
      return {
        JWT_SECRET: process.env.JWT_SECRET || 'test-secret',
        JWT_ALGORITHMS: process.env.JWT_ALGORITHMS || 'HS256',
        JWT_ISSUER: process.env.JWT_ISSUER,
        JWT_AUDIENCE: process.env.JWT_AUDIENCE,
      };
    }

    throw new AppError({
      type: 'https://liquifact.com/probs/auth-config-unavailable',
      title: 'Unauthorized',
      status: 401,
      detail: 'Authentication configuration is unavailable',
      instance,
    });
  }
}

/**
 * Middleware function to enforce authentication for protected routes.
 * Checks the "Authorization" header for a "Bearer <token>" pattern,
 * validates the JWT with algorithm allowlist, issuer, and audience enforcement,
 * and attaches the decoded payload to `req.user` on success.
 *
 * @param {import('express').Request} req - Express request object.
 * @param {import('express').Response} res - Express response object.
 * @param {import('express').NextFunction} next - Express next middleware function.
 * @returns {void}
 */
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];

  if (!authHeader) {
    return next(new AppError({
      type: 'https://liquifact.com/probs/unauthorized',
      title: 'Unauthorized',
      status: 401,
      detail: 'Authentication token is required',
      instance: req.originalUrl,
    }));
  }

  const parts = authHeader.split(' ');

  if (parts.length !== 2 || parts[0] !== 'Bearer') {
    return next(new AppError({
      type: 'https://liquifact.com/probs/unauthorized',
      title: 'Unauthorized',
      status: 401,
      detail: 'Invalid Authorization header format. Expected "Bearer <token>"',
      instance: req.originalUrl,
    }));
  }

  const token = parts[1];

  let cfg;
  try {
    cfg = resolveJwtConfig(req.originalUrl);
  } catch (err) {
    return next(err);
  }

  const secret = cfg.JWT_SECRET;
  const algorithms = cfg.JWT_ALGORITHMS
    ? cfg.JWT_ALGORITHMS.split(',').map((a) => a.trim())
    : ['HS256'];

  const options = { algorithms };
  if (cfg.JWT_ISSUER) { options.issuer = cfg.JWT_ISSUER; }
  if (cfg.JWT_AUDIENCE) { options.audience = cfg.JWT_AUDIENCE; }

  jwt.verify(token, secret, options, (err, decoded) => {
    if (err) {
      let detail = 'Invalid token';
      let type = 'https://liquifact.com/probs/invalid-token';

      if (err.name === 'TokenExpiredError') {
        detail = 'Token has expired';
        type = 'https://liquifact.com/probs/token-expired';
      } else if (err.message && err.message.toLowerCase().includes('algorithm')) {
        detail = 'Token algorithm not allowed';
      } else if (err.name === 'NotBeforeError') {
        detail = 'Token not yet active';
      }

      return next(new AppError({ type, title: 'Invalid Token', status: 401, detail, instance: req.originalUrl }));
    }

    req.user = decoded;
    next();
  });
};

module.exports = { authenticateToken, resolveJwtConfig };
