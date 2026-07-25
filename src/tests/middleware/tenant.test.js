const tenantMiddleware = require('../../src/middleware/tenant');

describe('Tenant Resolution Middleware - Fallbacks and Rejection Paths', () => {
  let req;
  let res;
  let next;

  beforeEach(() => {
    // Mock the Express request, response, and next objects
    req = {
      headers: {},
      id: 'test-correlation-id-1234', // Simulating correlation/request ID middleware upstream
      context: {}
    };
    
    res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis()
    };
    
    next = jest.fn();
  });

  // 1. Test Single Resolution Sources
  test('should successfully resolve tenant from X-Tenant-ID header', () => {
    req.headers['x-tenant-id'] = 'tenant-alpha';

    tenantMiddleware(req, res, next);

    expect(req.context.tenantId).toBe('tenant-alpha');
    expect(next).toHaveBeenCalledWith();
    expect(res.status).not.toHaveBeenCalled();
  });

  test('should successfully resolve tenant from token fallback if header missing', () => {
    // Simulating token payload already decoded upstream (e.g., via JWT middleware)
    req.user = { tenantId: 'tenant-beta' }; 

    tenantMiddleware(req, res, next);

    expect(req.context.tenantId).toBe('tenant-beta');
    expect(next).toHaveBeenCalledWith();
  });

  test('should successfully resolve tenant from domain bindings/host fallback', () => {
    req.get = jest.fn().mockReturnValue('tenant-gamma.liquifact.io');

    tenantMiddleware(req, res, next);

    expect(req.context.tenantId).toBe('tenant-gamma');
    expect(next).toHaveBeenCalledWith();
  });

  // 2. Test Precedence Rules (Header > Token > Binding)
  test('should favor X-Tenant-ID header over token when both exist', () => {
    req.headers['x-tenant-id'] = 'header-tenant';
    req.user = { tenantId: 'token-tenant' };

    tenantMiddleware(req, res, next);

    expect(req.context.tenantId).toBe('header-tenant');
    expect(next).toHaveBeenCalledWith();
  });

  test('should favor token over domain bindings when header is absent', () => {
    req.user = { tenantId: 'token-tenant' };
    req.get = jest.fn().mockReturnValue('binding-tenant.liquifact.io');

    tenantMiddleware(req, res, next);

    expect(req.context.tenantId).toBe('token-tenant');
    expect(next).toHaveBeenCalledWith();
  });

  // 3. Test Rejection Paths & Correlation ID Traceability
  test('should reject with 400 Bad Request when tenant cannot be resolved', () => {
    // Given no headers, tokens, or valid hosts matching a tenant
    req.headers = {};
    req.user = null;
    req.get = jest.fn().mockReturnValue('unknown-host.com');

    tenantMiddleware(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: 'Bad Request',
        message: 'Tenant identity could not be resolved.',
        correlationId: 'test-correlation-id-1234' // Ensuring traceability ID is carried over
      })
    );
  });

  test('should reject with 400 when sources conflict or provide invalid format', () => {
    req.headers['x-tenant-id'] = ''; // Empty/invalid format

    tenantMiddleware(req, res, next);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        correlationId: 'test-correlation-id-1234'
      })
    );
  });
});