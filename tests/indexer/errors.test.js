const request = require('supertest');
const app = require('../../src/app');

describe('Indexer Error Response Bodies (RFC7807 Shapes)', () => {
  test('400 Bad Request error response snapshot', async () => {
    const res = await request(app)
      .get('/api/indexer/events?invalidParam=true')
      .expect(400);

    expect(res.body).toMatchSnapshot({
      timestamp: expect.any(String)
    });
  });

  test('404 Not Found error response snapshot', async () => {
    const res = await request(app)
      .get('/api/indexer/non-existent-resource')
      .expect(404);

    expect(res.body).toMatchSnapshot({
      timestamp: expect.any(String)
    });
  });

  test('409 Conflict error response snapshot', async () => {
    const res = await request(app)
      .post('/api/indexer/events/duplicate')
      .send({ id: 'existing-id' })
      .expect(409);

    expect(res.body).toMatchSnapshot({
      timestamp: expect.any(String)
    });
  });

  test('500 Internal Server Error response snapshot', async () => {
    const res = await request(app)
      .get('/api/indexer/trigger-error')
      .expect(500);

    expect(res.body).toMatchSnapshot({
      timestamp: expect.any(String)
    });
  });
});
