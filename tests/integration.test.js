const request = require('supertest');
const { createApp } = require('../src/app');

describe('API Integration Tests', () => {
  let app;

  beforeAll(() => {
    process.env.NODE_ENV = 'test';
    app = createApp();
  });

  describe('GET /health', () => {
    it('should return 200 and health status', async () => {
      const res = await request(app).get('/health');
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        status: 'ok',
        service: 'liquifact-api'
      });
      expect(res.body.timestamp).toBeDefined();
    });
  });

  describe('GET /api', () => {
    it('should return API metadata and endpoints', async () => {
      const res = await request(app).get('/api');
      expect(res.status).toBe(200);
      expect(res.body.name).toBe('LiquiFact API');
      expect(res.body.endpoints).toBeDefined();
    });
  });

  describe('404 Handling', () => {
    it('should return 404 for unknown routes', async () => {
      const res = await request(app).get('/api/undefined-route');
      expect(res.status).toBe(404);
      expect(res.body.error).toBe('Not found');
    });
  });
});
