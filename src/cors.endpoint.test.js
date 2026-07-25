const request = require('supertest');

const { createApp } = require('./app');
const {
  CORS_REJECTION_CODE,
  CORS_REJECTION_MESSAGE,
} = require('./config/cors');

describe('CORS endpoint behavior', () => {
  const allowedOrigin = 'https://app.example.com';
  const originalNodeEnv = process.env.NODE_ENV;
  const originalAllowedOrigins = process.env.CORS_ALLOWED_ORIGINS;

  beforeEach(() => {
    process.env.NODE_ENV = 'production';
    process.env.CORS_ALLOWED_ORIGINS = allowedOrigin;
  });

  afterAll(() => {
    if (originalNodeEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = originalNodeEnv;
    }

    if (originalAllowedOrigins === undefined) {
      delete process.env.CORS_ALLOWED_ORIGINS;
    } else {
      process.env.CORS_ALLOWED_ORIGINS = originalAllowedOrigins;
    }
  });

  it('returns the health response for an allowed origin', async () => {
    const response = await request(createApp())
      .get('/health')
      .set('Origin', allowedOrigin);

    expect(response.status).toBe(200);
    expect(response.headers['access-control-allow-origin']).toBe(allowedOrigin);
    expect(response.body).toEqual({
      status: 'ok',
      service: 'liquifact-api',
      version: '0.1.0',
      timestamp: expect.any(String),
    });
  });

  it('preserves the not-found response for an allowed origin', async () => {
    const response = await request(createApp())
      .get('/missing')
      .set('Origin', allowedOrigin);

    expect(response.status).toBe(404);
    expect(response.headers['access-control-allow-origin']).toBe(allowedOrigin);
    expect(response.body).toEqual({
      error: 'Not found',
      path: '/missing',
    });
  });

  it('returns a stable error code when origin validation fails', async () => {
    const response = await request(createApp())
      .get('/health')
      .set('Origin', 'https://blocked.example.com');

    expect(response.status).toBe(403);
    expect(CORS_REJECTION_CODE).toBe('CORS_ORIGIN_REJECTED');
    expect(response.body.error).toBe(CORS_REJECTION_MESSAGE);
    expect(response.body.code).toBe(CORS_REJECTION_CODE);
  });

  it('returns the same response for repeated preflight requests', async () => {
    const app = createApp();
    const sendPreflight = () =>
      request(app)
        .options('/health')
        .set('Origin', allowedOrigin)
        .set('Access-Control-Request-Method', 'GET');

    const firstResponse = await sendPreflight();
    const repeatedResponse = await sendPreflight();

    for (const response of [firstResponse, repeatedResponse]) {
      expect(response.status).toBe(204);
      expect(response.body).toEqual({});
      expect(response.headers['access-control-allow-origin']).toBe(allowedOrigin);
    }

    expect(repeatedResponse.headers['access-control-allow-methods']).toBe(
      firstResponse.headers['access-control-allow-methods']
    );
    expect(repeatedResponse.headers['access-control-max-age']).toBe(
      firstResponse.headers['access-control-max-age']
    );
  });
});
