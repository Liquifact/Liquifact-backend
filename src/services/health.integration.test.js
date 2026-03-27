/**
 * @file Integration tests for /health and /ready endpoints.
 */

const request = require('supertest');
const { createApp } = require('../app');

describe('Health and Readiness Endpoints', () => {
  let app;
  let originalEnv;
  let fetchMock;

  beforeEach(() => {
    originalEnv = { ...process.env };
    fetchMock = jest.fn();
    global.fetch = fetchMock;
    app = createApp();
  });

  afterEach(() => {
    process.env = originalEnv;
    jest.restoreAllMocks();
  });

  describe('GET /health', () => {
    it('should return 200 with service status', async () => {
      const response = await request(app).get('/health');

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        status: 'ok',
        service: 'liquifact-api',
        version: '0.1.0'
      });
      expect(response.body.timestamp).toBeDefined();
    });

    it('should always return ok regardless of dependencies', async () => {
      process.env.SOROBAN_RPC_URL = 'https://soroban-testnet.stellar.org';
      fetchMock.mockRejectedValue(new Error('Connection refused'));

      const response = await request(app).get('/health');

      expect(response.status).toBe(200);
      expect(response.body.status).toBe('ok');
    });
  });

  describe('GET /ready', () => {
    it('should return 200 when all dependencies are healthy', async () => {
      process.env.SOROBAN_RPC_URL = 'https://soroban-testnet.stellar.org';
      fetchMock.mockResolvedValue({ ok: true, status: 200 });

      const response = await request(app).get('/ready');

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        ready: true,
        service: 'liquifact-api'
      });
      expect(response.body.checks.soroban.status).toBe('healthy');
      expect(response.body.timestamp).toBeDefined();
    });

    it('should return 200 when Soroban is not configured', async () => {
      delete process.env.SOROBAN_RPC_URL;

      const response = await request(app).get('/ready');

      expect(response.status).toBe(200);
      expect(response.body.ready).toBe(true);
      expect(response.body.checks.soroban.status).toBe('unknown');
    });

    it('should return 503 when Soroban is unhealthy', async () => {
      process.env.SOROBAN_RPC_URL = 'https://soroban-testnet.stellar.org';
      fetchMock.mockResolvedValue({ ok: false, status: 503 });

      const response = await request(app).get('/ready');

      expect(response.status).toBe(503);
      expect(response.body.ready).toBe(false);
      expect(response.body.checks.soroban.status).toBe('unhealthy');
    });

    it('should return 503 when Soroban connection fails', async () => {
      process.env.SOROBAN_RPC_URL = 'https://soroban-testnet.stellar.org';
      fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));

      const response = await request(app).get('/ready');

      expect(response.status).toBe(503);
      expect(response.body.ready).toBe(false);
      expect(response.body.checks.soroban.error).toBe('ECONNREFUSED');
    });

    it('should include latency metrics in response', async () => {
      process.env.SOROBAN_RPC_URL = 'https://soroban-testnet.stellar.org';
      fetchMock.mockResolvedValue({ ok: true, status: 200 });

      const response = await request(app).get('/ready');

      expect(response.status).toBe(200);
      expect(response.body.checks.soroban.latency).toBeGreaterThanOrEqual(0);
    });

    it('should handle health check errors gracefully', async () => {
      process.env.SOROBAN_RPC_URL = 'https://soroban-testnet.stellar.org';
      fetchMock.mockImplementation(() => {
        throw new Error('Unexpected error');
      });

      const response = await request(app).get('/ready');

      expect(response.status).toBe(503);
      expect(response.body.ready).toBe(false);
    });

    it('should check database status when configured', async () => {
      process.env.SOROBAN_RPC_URL = 'https://soroban-testnet.stellar.org';
      process.env.DATABASE_URL = 'postgresql://localhost:5432/test';
      fetchMock.mockResolvedValue({ ok: true, status: 200 });

      const response = await request(app).get('/ready');

      expect(response.body.checks.database).toBeDefined();
      expect(response.body.checks.database.status).toBe('not_implemented');
    });
  });
});
