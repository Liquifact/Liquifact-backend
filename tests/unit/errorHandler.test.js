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