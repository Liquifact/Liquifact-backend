'use strict';

/**
 * Unit tests for issue #1641: hasValidAdminToken and requireAdminToken.
 * Tests edge cases with mock req/res without requiring app or network imports.
 */

const { requireAdminToken, hasValidAdminToken } = require('../src/middleware/require-admin-token');

/**
 * Creates a mock Express request object.
 *
 * @param {string} [authorizationHeader] optional Authorization header value
 * @returns {object} mock req
 */
function createMockReq(authorizationHeader) {
  const headers = {};
  if (authorizationHeader !== undefined) {
    headers['authorization'] = authorizationHeader;
  }
  return {
    headers,
    get: jest.fn((name) => headers[name.toLowerCase()]),
  };
}

/**
 * Creates a mock Express response object supporting method chaining.
 *
 * @returns {object} mock res
 */
function createMockRes() {
  const res = {
    statusCode: null,
    body: null,
    headers: {},
  };
  res.status = jest.fn((code) => {
    res.statusCode = code;
    return res;
  });
  res.json = jest.fn((payload) => {
    res.body = payload;
    return res;
  });
  res.set = jest.fn((name, value) => {
    res.headers[name] = value;
    return res;
  });
  return res;
}

describe('require-admin-token middleware and guard', () => {
  const originalEnvToken = process.env.ADMIN_API_TOKEN;
  const VALID_TOKEN = 'secret-admin-token-12345';

  afterEach(() => {
    if (originalEnvToken === undefined) {
      delete process.env.ADMIN_API_TOKEN;
    } else {
      process.env.ADMIN_API_TOKEN = originalEnvToken;
    }
  });

  describe('requiredRoles marker', () => {
    test('declares requiredRoles equals ["admin"]', () => {
      expect(requireAdminToken.requiredRoles).toEqual(['admin']);
    });
  });

  describe('unset env (503)', () => {
    test('returns 503 and does not call next when ADMIN_API_TOKEN is unset (undefined)', () => {
      delete process.env.ADMIN_API_TOKEN;
      const req = createMockReq(`Bearer ${VALID_TOKEN}`);
      const res = createMockRes();
      const next = jest.fn();

      requireAdminToken(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(503);
      expect(res.statusCode).toBe(503);
      expect(res.json).toHaveBeenCalledWith({
        error: 'Admin API is not configured',
        code: 'ADMIN_TOKEN_NOT_CONFIGURED',
      });
      expect(res.set).not.toHaveBeenCalled();
      expect(hasValidAdminToken(req)).toBe(false);
    });

    test('returns 503 when ADMIN_API_TOKEN is empty string', () => {
      process.env.ADMIN_API_TOKEN = '';
      const req = createMockReq(`Bearer ${VALID_TOKEN}`);
      const res = createMockRes();
      const next = jest.fn();

      requireAdminToken(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(503);
      expect(res.statusCode).toBe(503);
      expect(res.json).toHaveBeenCalledWith({
        error: 'Admin API is not configured',
        code: 'ADMIN_TOKEN_NOT_CONFIGURED',
      });
      expect(res.set).not.toHaveBeenCalled();
      expect(hasValidAdminToken(req)).toBe(false);
    });
  });

  describe('when ADMIN_API_TOKEN is configured', () => {
    beforeEach(() => {
      process.env.ADMIN_API_TOKEN = VALID_TOKEN;
    });

    describe('missing header', () => {
      test('rejects request with 401 when Authorization header is absent', () => {
        const req = createMockReq();
        const res = createMockRes();
        const next = jest.fn();

        requireAdminToken(req, res, next);

        expect(next).not.toHaveBeenCalled();
        expect(res.set).toHaveBeenCalledWith('WWW-Authenticate', 'Bearer');
        expect(res.status).toHaveBeenCalledWith(401);
        expect(res.statusCode).toBe(401);
        expect(res.json).toHaveBeenCalledWith({
          error: 'Admin token required',
          code: 'UNAUTHORIZED',
        });
        expect(hasValidAdminToken(req)).toBe(false);
      });

      test('rejects request with 401 when Authorization header is empty string', () => {
        const req = createMockReq('');
        const res = createMockRes();
        const next = jest.fn();

        requireAdminToken(req, res, next);

        expect(next).not.toHaveBeenCalled();
        expect(res.set).toHaveBeenCalledWith('WWW-Authenticate', 'Bearer');
        expect(res.status).toHaveBeenCalledWith(401);
        expect(res.statusCode).toBe(401);
        expect(res.json).toHaveBeenCalledWith({
          error: 'Admin token required',
          code: 'UNAUTHORIZED',
        });
        expect(hasValidAdminToken(req)).toBe(false);
      });
    });

    describe('"Basic x"', () => {
      test('rejects "Basic x" header with 401', () => {
        const req = createMockReq('Basic x');
        const res = createMockRes();
        const next = jest.fn();

        requireAdminToken(req, res, next);

        expect(next).not.toHaveBeenCalled();
        expect(res.set).toHaveBeenCalledWith('WWW-Authenticate', 'Bearer');
        expect(res.status).toHaveBeenCalledWith(401);
        expect(res.statusCode).toBe(401);
        expect(res.json).toHaveBeenCalledWith({
          error: 'Admin token required',
          code: 'UNAUTHORIZED',
        });
        expect(hasValidAdminToken(req)).toBe(false);
      });
    });

    describe('"Bearer" with no token', () => {
      test.each(['Bearer', 'Bearer ', 'Bearer    ', 'bearer', 'bearer '])(
        'rejects "%s" with 401',
        (header) => {
          const req = createMockReq(header);
          const res = createMockRes();
          const next = jest.fn();

          requireAdminToken(req, res, next);

          expect(next).not.toHaveBeenCalled();
          expect(res.set).toHaveBeenCalledWith('WWW-Authenticate', 'Bearer');
          expect(res.status).toHaveBeenCalledWith(401);
          expect(res.statusCode).toBe(401);
          expect(res.json).toHaveBeenCalledWith({
            error: 'Admin token required',
            code: 'UNAUTHORIZED',
          });
          expect(hasValidAdminToken(req)).toBe(false);
        },
      );
    });

    describe('wrong token', () => {
      test('rejects wrong token with 401', () => {
        const req = createMockReq('Bearer wrong-admin-token');
        const res = createMockRes();
        const next = jest.fn();

        requireAdminToken(req, res, next);

        expect(next).not.toHaveBeenCalled();
        expect(res.set).toHaveBeenCalledWith('WWW-Authenticate', 'Bearer');
        expect(res.status).toHaveBeenCalledWith(401);
        expect(res.statusCode).toBe(401);
        expect(res.json).toHaveBeenCalledWith({
          error: 'Admin token required',
          code: 'UNAUTHORIZED',
        });
        expect(hasValidAdminToken(req)).toBe(false);
      });
    });

    describe('correct token', () => {
      test('accepts exact correct token, calls next, and sets no error response', () => {
        const req = createMockReq(`Bearer ${VALID_TOKEN}`);
        const res = createMockRes();
        const next = jest.fn();

        requireAdminToken(req, res, next);

        expect(next).toHaveBeenCalledTimes(1);
        expect(res.status).not.toHaveBeenCalled();
        expect(res.json).not.toHaveBeenCalled();
        expect(res.set).not.toHaveBeenCalled();
        expect(hasValidAdminToken(req)).toBe(true);
      });
    });

    describe('case-insensitive scheme', () => {
      test.each([
        `bearer ${VALID_TOKEN}`,
        `BEARER ${VALID_TOKEN}`,
        `bEaReR ${VALID_TOKEN}`,
      ])('accepts scheme variance "%s"', (header) => {
        const req = createMockReq(header);
        const res = createMockRes();
        const next = jest.fn();

        requireAdminToken(req, res, next);

        expect(next).toHaveBeenCalledTimes(1);
        expect(res.status).not.toHaveBeenCalled();
        expect(res.json).not.toHaveBeenCalled();
        expect(res.set).not.toHaveBeenCalled();
        expect(hasValidAdminToken(req)).toBe(true);
      });
    });

    describe('trailing whitespace', () => {
      test.each([
        `Bearer ${VALID_TOKEN} `,
        `Bearer ${VALID_TOKEN}   `,
        `Bearer ${VALID_TOKEN}\t`,
      ])('accepts token with trailing whitespace: %j', (header) => {
        const req = createMockReq(header);
        const res = createMockRes();
        const next = jest.fn();

        requireAdminToken(req, res, next);

        expect(next).toHaveBeenCalledTimes(1);
        expect(res.status).not.toHaveBeenCalled();
        expect(res.json).not.toHaveBeenCalled();
        expect(res.set).not.toHaveBeenCalled();
        expect(hasValidAdminToken(req)).toBe(true);
      });
    });
  });
});
