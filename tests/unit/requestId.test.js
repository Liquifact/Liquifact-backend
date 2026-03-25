const requestId = require('../../src/middleware/requestId');
const logger = require('../../src/utils/logger');
const { v4: uuidv4, validate: validateUuid } = require('uuid');

describe('RequestId Middleware', () => {
  let req;
  let res;
  let next;

  beforeEach(() => {
    req = {
      get: jest.fn().mockReturnValue(null),
    };
    res = {
      setHeader: jest.fn(),
    };
    next = jest.fn();
    jest.clearAllMocks();
  });

  test('should generate a new UUID if X-Request-Id header is missing', (done) => {
    requestId(req, res, () => {
      expect(req.id).toBeDefined();
      expect(validateUuid(req.id)).toBe(true);
      expect(res.setHeader).toHaveBeenCalledWith('X-Request-Id', req.id);
      done();
    });
  });

  test('should propagate existing X-Request-Id header', (done) => {
    const existingId = uuidv4();
    req.get.mockReturnValue(existingId);

    requestId(req, res, () => {
      expect(req.id).toBe(existingId);
      expect(res.setHeader).toHaveBeenCalledWith('X-Request-Id', existingId);
      done();
    });
  });

  test('should inject the ID into logger storage', (done) => {
    requestId(req, res, () => {
      const storedId = logger.storage.getStore();
      expect(storedId).toBe(req.id);
      done();
    });
  });
});

describe('Logger Utility', () => {
  beforeEach(() => {
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('should include requestId in logs when running in storage context', (done) => {
    const testId = 'test-request-id';
    logger.storage.run(testId, () => {
      logger.info('test message');
      
      const logOutput = JSON.parse(console.log.mock.calls[0][0]);
      expect(logOutput.requestId).toBe(testId);
      expect(logOutput.message).toBe('test message');
      expect(logOutput.level).toBe('info');
      done();
    });
  });

  test('should include error details and requestId in error logs', (done) => {
    const testId = 'error-id';
    const error = new Error('oops');
    
    logger.storage.run(testId, () => {
      logger.error('failed', error);
      
      const logOutput = JSON.parse(console.error.mock.calls[0][0]);
      expect(logOutput.requestId).toBe(testId);
      expect(logOutput.message).toBe('failed');
      expect(logOutput.error).toBe('oops');
      expect(logOutput.stack).toBeDefined();
      done();
    });
  });

  test('should handle object errors in error logs', (done) => {
    const testId = 'error-obj-id';
    const errorObj = { custom: 'data' };
    
    logger.storage.run(testId, () => {
      logger.error('failed obj', errorObj);
      
      const logOutput = JSON.parse(console.error.mock.calls[0][0]);
      expect(logOutput.custom).toBe('data');
      done();
    });
  });

  test('should include requestId as undefined when not in storage context', () => {
    logger.info('no context');
    const logOutput = JSON.parse(console.log.mock.calls[0][0]);
    expect(logOutput.requestId).toBeUndefined();
  });

  test('should log warnings', () => {
    logger.warn('be careful');
    const logOutput = JSON.parse(console.warn.mock.calls[0][0]);
    expect(logOutput.level).toBe('warn');
    expect(logOutput.message).toBe('be careful');
  });
});
