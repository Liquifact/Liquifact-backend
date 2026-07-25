'use strict';

const crypto = require('crypto');

const ORIGINAL_ENV = { ...process.env };
const DEV_CURSOR_SECRET = 'dev-cursor-secret-change-in-prod';
const REAL_CURSOR_SECRET = 'real-cursor-secret-at-least-32-chars';
const REAL_JWT_SECRET = 'real-jwt-secret-at-least-32-chars-long';

function loadCursorPagination() {
  jest.resetModules();
  return require('../src/utils/cursorPagination');
}

function buildSignedCursor(secret, overrides = {}) {
  const payload = Buffer.from(JSON.stringify({
    sortField: 'amount',
    sortValue: 1000,
    id: 'inv_cursor_secret',
    iat: Math.floor(Date.now() / 1000),
    ...overrides,
  })).toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(payload).digest('hex');
  return `${payload}.${sig}`;
}

function buildRawSignedCursor(secret, payloadValue) {
  const payload = Buffer.from(payloadValue).toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(payload).digest('hex');
  return `${payload}.${sig}`;
}

describe('cursor pagination secret resolution', () => {
  beforeEach(() => {
    jest.resetModules();
    process.env = { ...ORIGINAL_ENV };
    delete process.env.CURSOR_SECRET;
    delete process.env.JWT_SECRET;
    delete process.env.CURSOR_TTL_ENABLED;
    delete process.env.CURSOR_TTL_SECONDS;
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  it('fails closed when no cursor or JWT secret is configured in production', () => {
    process.env.NODE_ENV = 'production';
    const { encodeCursor } = loadCursorPagination();

    expect(() => encodeCursor({ sortField: 'amount', sortValue: 1, id: 'inv_1' }))
      .toThrow(/CURSOR_SECRET or JWT_SECRET/);
  });

  it('signs and verifies cursors with a real production CURSOR_SECRET', () => {
    process.env.NODE_ENV = 'production';
    process.env.CURSOR_SECRET = REAL_CURSOR_SECRET;
    const { encodeCursor, decodeCursor } = loadCursorPagination();

    const cursor = encodeCursor({ sortField: 'amount', sortValue: 42, id: 'inv_real' });
    const decoded = decodeCursor(cursor, 'amount');

    expect(decoded).toMatchObject({ sortField: 'amount', sortValue: 42, id: 'inv_real' });
  });

  it('preserves encode validation for unsupported sort fields and missing ids', () => {
    process.env.NODE_ENV = 'production';
    process.env.CURSOR_SECRET = REAL_CURSOR_SECRET;
    const { encodeCursor } = loadCursorPagination();

    expect(() => encodeCursor({ sortField: 'bad_field', sortValue: 1, id: 'inv_1' }))
      .toThrow(/unsupported sortField/);
    expect(() => encodeCursor({ sortField: 'amount', sortValue: 1, id: '' }))
      .toThrow(/id must be a non-empty string/);
  });

  it('falls back to JWT_SECRET when a dedicated cursor secret is absent', () => {
    process.env.NODE_ENV = 'production';
    process.env.JWT_SECRET = REAL_JWT_SECRET;
    const { encodeCursor, decodeCursor } = loadCursorPagination();

    const cursor = encodeCursor({ sortField: 'yield_bps', sortValue: 700, id: 'inv_jwt' });
    const decoded = decodeCursor(cursor, 'yield_bps');

    expect(decoded).toMatchObject({ sortField: 'yield_bps', sortValue: 700, id: 'inv_jwt' });
  });

  it('keeps the dev fallback available in test mode', () => {
    process.env.NODE_ENV = 'test';
    const { encodeCursor, decodeCursor } = loadCursorPagination();

    const cursor = encodeCursor({ sortField: 'created_at', sortValue: '2026-06-29', id: 'inv_test' });
    const decoded = decodeCursor(cursor, 'created_at');

    expect(decoded.id).toBe('inv_test');
  });

  it('rejects a cursor forged with the dev secret when production uses a real secret', () => {
    process.env.NODE_ENV = 'production';
    process.env.CURSOR_SECRET = REAL_CURSOR_SECRET;
    const { decodeCursor, CursorError } = loadCursorPagination();
    const forged = buildSignedCursor(DEV_CURSOR_SECRET);

    expect(() => decodeCursor(forged, 'amount')).toThrow(CursorError);
  });

  it('preserves malformed cursor and payload validation', () => {
    process.env.NODE_ENV = 'production';
    process.env.CURSOR_SECRET = REAL_CURSOR_SECRET;
    const { decodeCursor, CursorError } = loadCursorPagination();
    const notJson = buildRawSignedCursor(REAL_CURSOR_SECRET, 'not json');
    const unknownSort = buildSignedCursor(REAL_CURSOR_SECRET, { sortField: 'bad_field' });
    const missingId = buildSignedCursor(REAL_CURSOR_SECRET, { id: '' });
    const missingIat = buildSignedCursor(REAL_CURSOR_SECRET, { iat: undefined });

    expect(() => decodeCursor('nodothere', 'amount')).toThrow(CursorError);
    expect(() => decodeCursor(notJson, 'amount')).toThrow(/payload is not valid JSON/);
    expect(() => decodeCursor(unknownSort, 'amount')).toThrow(/unknown sort field/);
    expect(() => decodeCursor(missingId, 'amount')).toThrow(/id tiebreaker/);
    expect(() => decodeCursor(missingIat, 'amount')).toThrow(/issued-at/);
  });

  it('rejects cursors whose sort field does not match the request', () => {
    process.env.NODE_ENV = 'production';
    process.env.CURSOR_SECRET = REAL_CURSOR_SECRET;
    const { encodeCursor, decodeCursor, CursorError } = loadCursorPagination();
    const cursor = encodeCursor({ sortField: 'amount', sortValue: 1, id: 'inv_sort' });

    expect(() => decodeCursor(cursor, 'yield_bps')).toThrow(CursorError);
  });

  it('expires cursors when TTL validation is enabled', () => {
    process.env.NODE_ENV = 'production';
    process.env.CURSOR_SECRET = REAL_CURSOR_SECRET;
    process.env.CURSOR_TTL_ENABLED = 'true';
    process.env.CURSOR_TTL_SECONDS = '60';
    const { decodeCursor, CursorError } = loadCursorPagination();
    const oldIat = Math.floor(Date.now() / 1000) - 61;
    const expired = buildSignedCursor(REAL_CURSOR_SECRET, { iat: oldIat });

    expect(() => decodeCursor(expired, 'amount')).toThrow(CursorError);
    expect(() => decodeCursor(expired, 'amount')).toThrow(/expired/);
  });

  it('accepts fresh cursors when TTL validation is enabled', () => {
    process.env.NODE_ENV = 'production';
    process.env.CURSOR_SECRET = REAL_CURSOR_SECRET;
    process.env.CURSOR_TTL_ENABLED = 'true';
    process.env.CURSOR_TTL_SECONDS = '60';
    const { decodeCursor } = loadCursorPagination();
    const fresh = buildSignedCursor(REAL_CURSOR_SECRET);

    expect(decodeCursor(fresh, 'amount').id).toBe('inv_cursor_secret');
  });
});

describe('cursor pagination config validation', () => {
  beforeEach(() => {
    jest.resetModules();
  });

  it('accepts a production config with a dedicated cursor secret and TTL settings', () => {
    const { ConfigSchema } = require('../src/config');

    const result = ConfigSchema.safeParse({
      NODE_ENV: 'production',
      JWT_SECRET: REAL_JWT_SECRET,
      CURSOR_SECRET: REAL_CURSOR_SECRET,
      CURSOR_TTL_ENABLED: 'true',
      CURSOR_TTL_SECONDS: '900',
    });

    expect(result.success).toBe(true);
    expect(result.data.CURSOR_TTL_SECONDS).toBe(900);
  });

  it('rejects a short dedicated cursor secret', () => {
    const { ConfigSchema } = require('../src/config');

    const result = ConfigSchema.safeParse({
      NODE_ENV: 'production',
      JWT_SECRET: REAL_JWT_SECRET,
      CURSOR_SECRET: 'short',
    });

    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error.issues)).toContain('CURSOR_SECRET');
  });
});
