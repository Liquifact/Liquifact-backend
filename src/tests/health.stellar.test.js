const request = require('supertest');
const { createApp } = require('../index');

describe('Stellar Health Checks', () => {
  let app;
  let originalEnv;

  beforeAll(() => {
    originalEnv = process.env;
    process.env = { 
      ...originalEnv, 
      JWT_SECRET: 'supersecret32characterlongstringforzod', 
      SOROBAN_RPC_URL: 'http://localhost:8000',
      NODE_ENV: 'test'
    };
    app = createApp({ enableTestRoutes: true });
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('should return 200 OK when Soroban RPC is healthy', async () => {
    global.fetch = jest.fn(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ result: 'ok' })
      })
    );

    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.checks.soroban.status).toBe('healthy');
  });

  it('should return 503 Service Unavailable when Soroban RPC fails', async () => {
    global.fetch = jest.fn(() => Promise.reject(new Error('Network error')));

    const res = await request(app).get('/health');
    expect(res.status).toBe(503);
    expect(res.body.status).toBe('error');
    expect(res.body.checks.soroban.status).toBe('unhealthy');
    expect(res.body.checks.soroban.error).toBe('Network error');
  });

  it('should return 503 when Soroban RPC returns an HTTP error status', async () => {
    global.fetch = jest.fn(() =>
      Promise.resolve({
        ok: false,
        status: 500
      })
    );

    const res = await request(app).get('/health');
    expect(res.status).toBe(503);
    expect(res.body.status).toBe('error');
    expect(res.body.checks.soroban.status).toBe('unhealthy');
    expect(res.body.checks.soroban.error).toBe('HTTP 500');
  });
});