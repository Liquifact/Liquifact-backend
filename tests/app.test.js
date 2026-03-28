const request = require('supertest');
const express = require('express');

const asyncHandler = require('../src/utils/asyncHandler');
const errorHandler = require('../src/middleware/errorHandler');

const app = express();
app.use(express.json());

app.get(
  '/success',
  asyncHandler(async (req, res) => {
    res.json({ ok: true });
  })
);

app.get(
  '/fail',
  asyncHandler(async () => {
    throw new Error('Boom');
  })
);

app.use(errorHandler);

describe('Async Handler', () => {
  it('should return success response', async () => {
    const res = await request(app).get('/success');
    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('should catch async errors', async () => {
    const res = await request(app).get('/fail');
    expect(res.statusCode).toBe(500);
    expect(res.body.title).toBe('Internal Server Error');
    expect(res.body.status).toBe(500);
  });
});