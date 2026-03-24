const { timingSafeEqual } = require('crypto');

const { AppError } = require('../errors/AppError');

/**
 * Parse a Bearer Authorization header into its token value.
 *
 * @param {string | undefined} headerValue Raw Authorization header value.
 * @returns {string}
 */
function parseBearerAuthorizationHeader(headerValue) {
  if (typeof headerValue !== 'string') {
    throw new AppError({
      status: 401,
      code: 'AUTHENTICATION_REQUIRED',
      message: 'Authentication is required for this endpoint.',
      retryable: false,
      retryHint: 'Provide a valid Bearer token and try again.',
    });
  }

  const trimmedHeader = headerValue.trim();
  if (trimmedHeader.length === 0) {
    throw new AppError({
      status: 400,
      code: 'VALIDATION_ERROR',
      message: 'Authorization header is malformed.',
      retryable: false,
      retryHint: 'Send a Bearer token in the Authorization header and try again.',
    });
  }

  const parts = trimmedHeader.split(/\s+/);
  if (parts.length !== 2 || parts[0] !== 'Bearer' || parts[1].includes(',')) {
    throw new AppError({
      status: 400,
      code: 'VALIDATION_ERROR',
      message: 'Authorization header is malformed.',
      retryable: false,
      retryHint: 'Send a Bearer token in the Authorization header and try again.',
    });
  }

  return parts[1];
}

/**
 * Compare token strings without leaking early-match timing.
 *
 * @param {string} actualToken Token supplied by the client.
 * @param {string} expectedToken Token configured by the server.
 * @returns {boolean}
 */
function tokensMatch(actualToken, expectedToken) {
  const actual = Buffer.from(actualToken, 'utf8');
  const expected = Buffer.from(expectedToken, 'utf8');

  if (actual.length !== expected.length) {
    return false;
  }

  return timingSafeEqual(actual, expected);
}

/**
 * Create a Bearer-token middleware for protected routes.
 *
 * @param {{ token?: string }} [options] Auth middleware configuration.
 * @returns {import('express').RequestHandler}
 */
function requireBearerToken(options = {}) {
  const expectedToken = options.token ?? process.env.TEST_API_TOKEN ?? '';

  return (req, _res, next) => {
    let token;

    try {
      token = parseBearerAuthorizationHeader(req.header('authorization'));
    } catch (error) {
      next(error);
      return;
    }

    if (!expectedToken || !tokensMatch(token, expectedToken)) {
      next(
        new AppError({
          status: 401,
          code: 'INVALID_TOKEN',
          message: 'The provided access token is invalid.',
          retryable: false,
          retryHint: 'Provide a valid Bearer token and try again.',
        }),
      );
      return;
    }

    next();
  };
}

module.exports = {
  parseBearerAuthorizationHeader,
  tokensMatch,
  requireBearerToken,
};
