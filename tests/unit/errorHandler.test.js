const errorHandler = require('../../src/middleware/errorHandler');
const AppError = require('../../src/errors/AppError');

describe('errorHandler Middleware Unit Tests', () => {
  let mockRequest;
  let mockResponse;
  let nextFunction;

  beforeEach(() => {
    mockRequest = {
      originalUrl: '/api/v1/test',
    };
    mockResponse = {
      header: jest.fn(),
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
    };
    nextFunction = jest.fn();
    // Keep console.error quiet during tests
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    console.error.mockRestore();
  });

  test('should handle AppError and send RFC 7807 response', () => {
    const error = new AppError({
      type: 'https://liquifact.com/probs/bad-request',
      title: 'Bad Request',
      status: 400,
      detail: 'Invalid data',
    });

    errorHandler(error, mockRequest, mockResponse, nextFunction);

    expect(mockResponse.header).toHaveBeenCalledWith('Content-Type', 'application/problem+json');
    expect(mockResponse.status).toHaveBeenCalledWith(400);
    expect(mockResponse.json).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'https://liquifact.com/probs/bad-request',
        title: 'Bad Request',
        status: 400,
        detail: 'Invalid data',
        instance: '/api/v1/test',
      })
    );
  });

  test('should handle generic Error and fallback to 500', () => {
    const error = new Error('Something exploded');

    errorHandler(error, mockRequest, mockResponse, nextFunction);

    expect(mockResponse.status).toHaveBeenCalledWith(500);
    expect(mockResponse.json).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 500,
        title: 'Internal Server Error',
        detail: 'An unexpected error occurred while processing your request.',
      })
    );
  });
});
const request = require('supertest');
const createTestApp = require('../helpers/createTestApp');

describe('errorHandler middleware', () => {
  it('should return 500 by default', async () => {
    const app = createTestApp((app) => {
      app.get('/error', () => {
        throw new Error('Boom');
      });
    });

    const res = await request(app).get('/error');

    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({ error: { message: 'Boom' } });
  });

  it('should respect custom statusCode', async () => {
    const app = createTestApp((app) => {
      app.get('/custom', () => {
        const err = new Error('Bad Request');
        err.statusCode = 400;
        throw err;
      });
    });

    const res = await request(app).get('/custom');

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ error: 'Bad Request' });
  });

  it('should hide stack in production', async () => {
    process.env.NODE_ENV = 'production';

    const app = createTestApp((app) => {
      app.get('/prod-error', () => {
        throw new Error('Sensitive');
      });
    });

    const res = await request(app).get('/prod-error');

    expect(res.body).toEqual({ error: { message: 'Internal server error' } });

    process.env.NODE_ENV = 'test'; // reset
  });
});