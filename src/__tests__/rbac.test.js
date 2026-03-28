const { roleGuard } = require('../middleware/roleGuard');

describe('roleGuard Middleware', () => {
  let mockRequest;
  let mockResponse;
  let nextFunction;

  beforeEach(() => {
    mockRequest = {};
    mockResponse = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn()
    };
    nextFunction = jest.fn();
  });

  it('should return 401 if req.user is undefined', () => {
    const middleware = roleGuard(['admin']);
    middleware(mockRequest, mockResponse, nextFunction);

    expect(mockResponse.status).toHaveBeenCalledWith(401);
    expect(mockResponse.json).toHaveBeenCalledWith({ error: 'User is not authenticated' });
    expect(nextFunction).not.toHaveBeenCalled();
  });

  it('should return 403 if req.user.role is not provided', () => {
    mockRequest.user = { id: 1 }; // Missing role
    const middleware = roleGuard(['admin']);
    middleware(mockRequest, mockResponse, nextFunction);

    expect(mockResponse.status).toHaveBeenCalledWith(403);
    expect(mockResponse.json).toHaveBeenCalledWith({ error: 'Forbidden: Insufficient privileges' });
    expect(nextFunction).not.toHaveBeenCalled();
  });

  it('should return 403 if req.user.role is not in allowedRoles', () => {
    mockRequest.user = { id: 1, role: 'investor' };
    const middleware = roleGuard(['admin', 'issuer']);
    middleware(mockRequest, mockResponse, nextFunction);

    expect(mockResponse.status).toHaveBeenCalledWith(403);
    expect(mockResponse.json).toHaveBeenCalledWith({ error: 'Forbidden: Insufficient privileges' });
    expect(nextFunction).not.toHaveBeenCalled();
  });

  it('should call next() if req.user.role is allowed', () => {
    mockRequest.user = { id: 1, role: 'admin' };
    const middleware = roleGuard(['admin', 'issuer']);
    middleware(mockRequest, mockResponse, nextFunction);

    expect(nextFunction).toHaveBeenCalled();
    expect(mockResponse.status).not.toHaveBeenCalled();
  });
});
