'use strict';

const { createHealthHandler } = require('./healthHandler');

function createResponse() {
  return {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  };
}

describe('createHealthHandler', () => {
  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(new Date('2026-07-24T10:00:00.000Z'));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('returns the unchanged success response for a healthy check', async () => {
    const checks = { database: { status: 'healthy' } };
    const checkHealth = jest.fn().mockResolvedValue({ healthy: true, checks });
    const res = createResponse();

    await createHealthHandler(checkHealth)({}, res);

    expect(checkHealth).toHaveBeenCalledTimes(1);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      ready: true,
      service: 'liquifact-api',
      timestamp: '2026-07-24T10:00:00.000Z',
      checks,
    });
  });

  it('preserves the 503 response and checks for an unhealthy result', async () => {
    const checks = { database: { status: 'unhealthy' } };
    const res = createResponse();

    await createHealthHandler(jest.fn().mockResolvedValue({ healthy: false, checks }))({}, res);

    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith({
      ready: false,
      service: 'liquifact-api',
      timestamp: '2026-07-24T10:00:00.000Z',
      checks,
    });
  });

  it('preserves the 503 error response when the health check rejects', async () => {
    const res = createResponse();

    await createHealthHandler(jest.fn().mockRejectedValue(new Error('probe failed')))({}, res);

    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith({
      ready: false,
      service: 'liquifact-api',
      timestamp: '2026-07-24T10:00:00.000Z',
      error: 'probe failed',
    });
  });
});
