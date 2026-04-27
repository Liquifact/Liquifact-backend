'use strict';

/**
 * @fileoverview Integration tests for core server routes: /health, /api, 404, and 500.
 * Uses supertest for in-process server testing.
 */

// Set required environment variables for testing
process.env.CORS_ORIGINS = 'http://localhost:3000';
process.env.JWT_SECRET = 'test-secret-at-least-32-characters-long-string-for-jest';

const request = require('supertest');

// Mock sqlite3 to avoid native module loading issues in CI/test environments
jest.mock('sqlite3', () => ({
  verbose: jest.fn(() => ({
    Database: jest.fn(() => ({
      run: jest.fn(),
      get: jest.fn(),
      close: jest.fn(),
    })),
  })),
}));

const app = require('../src/index');
const { performHealthChecks } = require('../src/services/health');

// Mock health checks to ensure deterministic results
jest.mock('../src/services/health', () => ({
  performHealthChecks: jest.fn()
}));

describe('Server Core Integration Tests', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    
    // Default healthy response for /health
    performHealthChecks.mockResolvedValue({
      healthy: true,
      checks: {
        soroban: { status: 'healthy', latency: 5 },
        database: { status: 'not_configured' }
      }
    });
  });

  /**
   * Test /health endpoint
   * Requirements: Test JSON shape and 200 OK.
   */
  describe('GET /health', () => {
    it('should return 200 OK with the correct JSON shape', async () => {
      const res = await request(app).get('/health');
      
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toMatch(/json/);
      expect(res.body).toMatchObject({
        status: 'ok',
        service: 'liquifact-api',
        version: expect.any(String),
        timestamp: expect.any(String),
        checks: {
          soroban: expect.any(Object),
          database: expect.any(Object)
        }
      });
    });

    it('should return unhealthy status when dependencies fail', async () => {
      performHealthChecks.mockResolvedValueOnce({
        healthy: false,
        checks: {
          soroban: { status: 'unhealthy', error: 'Connection refused' },
          database: { status: 'not_configured' }
        }
      });

      const res = await request(app).get('/health');
      
      expect(res.statusCode).toBe(200); // Route returns 200 even if unhealthy in current implementation
      expect(res.body.status).toBe('unhealthy');
    });
  });

  /**
   * Test /api endpoint
   * Requirements: Test JSON shape and 200 OK.
   */
  describe('GET /api', () => {
    it('should return 200 OK with API information', async () => {
      const res = await request(app).get('/api');
      
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toMatch(/json/);
      expect(res.body).toMatchObject({
        name: 'LiquiFact API',
        description: expect.any(String),
        endpoints: expect.any(Object)
      });
      
      // Verify minimal expected endpoints are listed
      expect(res.body.endpoints).toHaveProperty('health');
      expect(res.body.endpoints).toHaveProperty('invoices');
    });
  });

  /**
   * Test 404 Not Found handler
   * Requirements: Test status code and JSON shape.
   */
  describe('404 Handler', () => {
    it('should return 404 for non-existent routes', async () => {
      const res = await request(app).get('/api/v1/this-route-does-not-exist');
      
      expect(res.statusCode).toBe(404);
      expect(res.headers['content-type']).toMatch(/json/);
      expect(res.body.error).toMatchObject({
        code: 'NOT_FOUND',
        message: expect.any(String),
        correlation_id: expect.any(String)
      });
    });
  });

  /**
   * Test 500 Internal Error handler
   * Requirements: Test that it returns JSON and correct status.
   */
  describe('500 Error Handler', () => {
    it('should return 500 for exploding routes', async () => {
      // In test environment, __test__/explode is available
      const res = await request(app).get('/__test__/explode');
      
      expect(res.statusCode).toBe(500);
      expect(res.headers['content-type']).toMatch(/json/);
      expect(res.body.error).toMatchObject({
        code: 'INTERNAL_SERVER_ERROR',
        message: expect.any(String),
        correlation_id: expect.any(String)
      });
    });
  });

  /**
   * Test CORS preflight
   * Requirements: Test CORS headers and preflight (OPTIONS).
   */
  describe('CORS Policy', () => {
    const allowedOrigin = 'http://localhost:3000';
    const disallowedOrigin = 'http://malicious-site.com';

    it('should return correct headers for allowed origin (Preflight)', async () => {
      const res = await request(app)
        .options('/health')
        .set('Origin', allowedOrigin)
        .set('Access-Control-Request-Method', 'GET');
      
      expect(res.statusCode).toBe(204);
      expect(res.headers['access-control-allow-origin']).toBe(allowedOrigin);
    });

    it('should allow simple GET requests from allowed origin', async () => {
      const res = await request(app)
        .get('/health')
        .set('Origin', allowedOrigin);
      
      expect(res.statusCode).toBe(200);
      expect(res.headers['access-control-allow-origin']).toBe(allowedOrigin);
    });

    it('should reject requests from disallowed origins with 403', async () => {
      const res = await request(app)
        .get('/health')
        .set('Origin', disallowedOrigin);
      
      expect(res.statusCode).toBe(403);
      expect(res.body.error.message).toBe('CORS policy: origin is not allowed.');
    });
  });
});
