const request = require('supertest');
const asyncHandler = require('../../src/utils/asyncHandler');
const createTestApp = require('../helpers/createTestApp');

describe('asyncHandler utility', () => {
  it('should handle successful async route', async () => {
    const app = createTestApp((app) => {
      app.get(
        '/success',
        asyncHandler(async (req, res) => {
          res.json({ ok: true });
        })
      );
    });

    const res = await request(app).get('/success');

    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('should catch async errors and pass to error handler', async () => {
    const app = createTestApp((app) => {
      app.get(
        '/fail',
        asyncHandler(async () => {
          throw new Error('Test error');
        })
      );
    });

    const res = await request(app).get('/fail');

    expect(res.statusCode).toBe(500);
    expect(res.body.title).toBe('Internal Server Error');
    expect(res.body.status).toBe(500);
  });

  it('should handle rejected promises', async () => {
    const app = createTestApp((app) => {
      app.get(
        '/reject',
        asyncHandler(async () => Promise.reject(new Error('Rejected')))
      );
    });

    const res = await request(app).get('/reject');

    expect(res.statusCode).toBe(500);
  });
});