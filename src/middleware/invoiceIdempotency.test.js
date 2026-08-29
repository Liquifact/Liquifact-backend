'use strict';

const {
  InvoiceIdempotencyError,
  InvoiceIdempotencyStore,
  canonicalize,
  canonicalJson,
  requestFingerprint,
  validateKey,
  scopedKey,
  errorBody,
} = require('./invoiceIdempotency');

describe('invoice idempotency store', () => {
  let now;
  let store;

  beforeEach(() => {
    now = 1000;
    store = new InvoiceIdempotencyStore({ clock: () => now, ttlMs: 100, maxEntries: 3 });
  });

  test.each([
    ['abcdefgh', 'abcdefgh'],
    ['abc_DEF-123', 'abc_DEF-123'],
    ['a.b:c-1_2', 'a.b:c-1_2'],
    ['  abcdefgh  ', 'abcdefgh'],
  ])('accepts key %p', (input, expected) => expect(validateKey(input)).toBe(expected));

  test.each([undefined, null, '', 'short', 'has space', 'slash/abc', 'üabcdefgh', 'a'.repeat(129)])(
    'rejects malformed key %p', (input) => {
      expect(() => validateKey(input)).toThrow(InvoiceIdempotencyError);
      try { validateKey(input); } catch (error) {
        expect(['KEY_REQUIRED', 'KEY_INVALID']).toContain(error.code);
        expect(error.statusCode).toBe(400);
      }
    },
  );

  test('canonicalizes nested objects independent of insertion order', () => {
    const left = { amount: 10, customer: { z: 2, a: 1 }, lines: [{ b: 2, a: 1 }] };
    const right = { lines: [{ a: 1, b: 2 }], customer: { a: 1, z: 2 }, amount: 10 };
    expect(canonicalJson(left)).toBe(canonicalJson(right));
    expect(canonicalize(left)).toEqual({
      amount: 10,
      customer: { a: 1, z: 2 },
      lines: [{ b: 2, a: 1 }],
    });
  });

  test('does not mutate request objects during canonicalization', () => {
    const body = { b: 1, a: { d: 2, c: 3 } };
    const before = JSON.stringify(body);
    canonicalize(body);
    expect(JSON.stringify(body)).toBe(before);
  });

  test('fingerprint binds method, path, tenant, and body', () => {
    const base = { method: 'POST', path: '/v1/invoices', tenantId: 'tenant-a', body: { amount: 10 } };
    const fingerprint = requestFingerprint(base);
    expect(fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(requestFingerprint({ ...base, body: { amount: 11 } })).not.toBe(fingerprint);
    expect(requestFingerprint({ ...base, tenantId: 'tenant-b' })).not.toBe(fingerprint);
    expect(requestFingerprint({ ...base, path: '/other' })).not.toBe(fingerprint);
    expect(requestFingerprint({ ...base, method: 'PUT' })).not.toBe(fingerprint);
  });

  test('requires a tenant before calculating a fingerprint', () => {
    expect(() => requestFingerprint({ body: {} })).toThrow('Tenant context is required');
  });

  test('scoped keys cannot collide between tenants', () => {
    expect(scopedKey('tenant-a', 'same-key')).not.toBe(scopedKey('tenant-b', 'same-key'));
  });

  test('first request claims a pending record', () => {
    const claim = store.claim({ tenantId: 'a', key: 'abcdefgh', fingerprint: 'fp-a' });
    expect(claim.state).toBe('claimed');
    expect(claim.record.state).toBe('pending');
    expect(claim.record.statusCode).toBeNull();
    expect(claim.record.responseBody).toBeNull();
    expect(claim.record.expiresAt).toBe(1100);
    expect(store.size()).toBe(1);
  });

  test('same pending request is rejected as in progress', () => {
    store.claim({ tenantId: 'a', key: 'abcdefgh', fingerprint: 'fp-a' });
    const second = store.claim({ tenantId: 'a', key: 'abcdefgh', fingerprint: 'fp-a' });
    expect(second.state).toBe('in_progress');
    expect(second.record.state).toBe('pending');
  });

  test('different body is a conflict before completion', () => {
    store.claim({ tenantId: 'a', key: 'abcdefgh', fingerprint: 'fp-a' });
    const second = store.claim({ tenantId: 'a', key: 'abcdefgh', fingerprint: 'fp-b' });
    expect(second.state).toBe('conflict');
  });

  test('completion stores status and response exactly', () => {
    store.claim({ tenantId: 'a', key: 'abcdefgh', fingerprint: 'fp-a' });
    const completed = store.complete('a', 'abcdefgh', 'fp-a', 201, { data: { id: 'inv-1' } });
    expect(completed.state).toBe('completed');
    expect(completed.statusCode).toBe(201);
    expect(completed.responseBody).toEqual({ data: { id: 'inv-1' } });
    expect(store.get('a', 'abcdefgh').state).toBe('completed');
  });

  test('completed request replays the original outcome', () => {
    store.claim({ tenantId: 'a', key: 'abcdefgh', fingerprint: 'fp-a' });
    store.complete('a', 'abcdefgh', 'fp-a', 202, { accepted: true });
    const replay = store.claim({ tenantId: 'a', key: 'abcdefgh', fingerprint: 'fp-a' });
    expect(replay.state).toBe('replay');
    expect(replay.record.statusCode).toBe(202);
    expect(replay.record.responseBody).toEqual({ accepted: true });
  });

  test('same key with a different body remains a conflict after completion', () => {
    store.claim({ tenantId: 'a', key: 'abcdefgh', fingerprint: 'fp-a' });
    store.complete('a', 'abcdefgh', 'fp-a', 201, { ok: true });
    expect(store.claim({ tenantId: 'a', key: 'abcdefgh', fingerprint: 'fp-b' }).state).toBe('conflict');
  });

  test('tenant B can independently use tenant A key', () => {
    store.claim({ tenantId: 'a', key: 'abcdefgh', fingerprint: 'fp-a' });
    store.complete('a', 'abcdefgh', 'fp-a', 201, { tenant: 'a' });
    const tenantB = store.claim({ tenantId: 'b', key: 'abcdefgh', fingerprint: 'fp-b' });
    expect(tenantB.state).toBe('claimed');
    expect(store.size()).toBe(2);
  });

  test('expiry permits key reuse as a new request', () => {
    store.claim({ tenantId: 'a', key: 'abcdefgh', fingerprint: 'fp-a' });
    store.complete('a', 'abcdefgh', 'fp-a', 201, { old: true });
    now = 1100;
    const fresh = store.claim({ tenantId: 'a', key: 'abcdefgh', fingerprint: 'fp-b' });
    expect(fresh.state).toBe('claimed');
    expect(fresh.record.createdAt).toBe(1100);
  });

  test('purge reports expired rows only', () => {
    store.claim({ tenantId: 'a', key: 'abcdefgh', fingerprint: 'fp-a' });
    store.claim({ tenantId: 'b', key: 'abcdefgh', fingerprint: 'fp-b' });
    now = 1099;
    expect(store.purge()).toBe(0);
    now = 1100;
    expect(store.purge()).toBe(2);
    expect(store.size()).toBe(0);
  });

  test('abandon removes only the matching request', () => {
    store.claim({ tenantId: 'a', key: 'abcdefgh', fingerprint: 'fp-a' });
    store.abandon('a', 'abcdefgh', 'other');
    expect(store.get('a', 'abcdefgh')).toBeDefined();
    store.abandon('a', 'abcdefgh', 'fp-a');
    expect(store.get('a', 'abcdefgh')).toBeUndefined();
  });

  test('completion rejects unknown records', () => {
    expect(() => store.complete('a', 'abcdefgh', 'fp-a', 201, {})).toThrow('no longer available');
  });

  test('completion rejects a mismatched fingerprint', () => {
    store.claim({ tenantId: 'a', key: 'abcdefgh', fingerprint: 'fp-a' });
    expect(() => store.complete('a', 'abcdefgh', 'fp-b', 201, {})).toThrow('no longer available');
  });

  test('completion rejects an expired record', () => {
    store.claim({ tenantId: 'a', key: 'abcdefgh', fingerprint: 'fp-a' });
    now = 1100;
    expect(() => store.complete('a', 'abcdefgh', 'fp-a', 201, {})).toThrow('no longer available');
  });

  test('evicts oldest entry at the configured bound', () => {
    store.claim({ tenantId: 'a', key: 'abcdefgh', fingerprint: 'a' });
    now += 1;
    store.claim({ tenantId: 'b', key: 'abcdefgh', fingerprint: 'b' });
    now += 1;
    store.claim({ tenantId: 'c', key: 'abcdefgh', fingerprint: 'c' });
    now += 1;
    store.claim({ tenantId: 'd', key: 'abcdefgh', fingerprint: 'd' });
    expect(store.get('a', 'abcdefgh')).toBeUndefined();
    expect(store.size()).toBe(3);
  });

  test('copies records so callers cannot mutate store state', () => {
    const claim = store.claim({ tenantId: 'a', key: 'abcdefgh', fingerprint: 'fp-a' });
    claim.record.state = 'completed';
    expect(store.get('a', 'abcdefgh').state).toBe('pending');
  });

  test('error bodies use stable machine-readable codes', () => {
    const error = new InvoiceIdempotencyError('REQUEST_IN_PROGRESS', 'try later', 409);
    expect(errorBody(error)).toEqual({ error: 'request_in_progress', code: 'REQUEST_IN_PROGRESS', message: 'try later' });
  });

  test('conflict body uses the endpoint contract name', () => {
    const error = new InvoiceIdempotencyError('KEY_CONFLICT', 'different request', 409);
    expect(errorBody(error).error).toBe('idempotency_conflict');
  });
});
