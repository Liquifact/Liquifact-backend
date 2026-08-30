'use strict';

/**
 * Contract coverage for issue #1178.
 *
 * These tests keep the externally visible webhook guarantees small and easy
 * to review: a receiver can verify the exact bytes it received, transient
 * delivery failures are bounded, and a failed delivery has enough durable
 * information for a safe replay. Transport/database integration tests remain
 * in webhooks.delivery.test.js and webhooks.retry.test.js.
 */

process.env.NODE_ENV = 'test';

jest.mock('../src/db/knex', () => jest.fn());
jest.mock('../src/logger', () => ({
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));
jest.mock('../src/services/auditLogStore', () => ({ appendAuditEvent: jest.fn() }));
jest.mock('../src/metrics', () => ({ registry: {} }));

const crypto = require('crypto');
const db = require('../src/db/knex');
const { withRetry } = require('../src/utils/retry');
const {
  createSignature,
  createSignatureHeader,
  verifySignature,
  sortKeys,
  writeDeadLetter,
} = require('../src/services/webhooks');

function queryReturning(row) {
  return {
    insert: jest.fn().mockReturnThis(),
    returning: jest.fn().mockResolvedValue([row]),
  };
}

describe('webhook signature contract', () => {
  const secret = 'whsec_contract_test';
  const body = JSON.stringify({ amount: 12, event: 'invoice.paid', invoiceId: 'inv-42' });
  const timestamp = 1_700_000_000;

  afterEach(() => jest.useRealTimers());

  it('signs timestamp and raw body bytes with HMAC-SHA256', () => {
    const expected = crypto
      .createHmac('sha256', secret)
      .update(`${timestamp}.${body}`)
      .digest('hex');

    expect(createSignature(secret, body, timestamp)).toBe(expected);
  });

  it('creates a parseable versioned header', () => {
    jest.useFakeTimers().setSystemTime(timestamp * 1000);
    const header = createSignatureHeader(secret, body);

    expect(header).toMatch(/^t=1700000000,v1=[a-f0-9]{64}$/);
    expect(verifySignature(secret, body, header)).toEqual({ valid: true, error: null });
  });

  it('rejects a changed body even when the timestamp is current', () => {
    jest.useFakeTimers().setSystemTime(timestamp * 1000);
    const header = createSignatureHeader(secret, body);

    expect(verifySignature(secret, `${body} `, header)).toMatchObject({
      valid: false,
      error: 'Signature mismatch',
    });
  });

  it('rejects a changed secret', () => {
    jest.useFakeTimers().setSystemTime(timestamp * 1000);
    const header = createSignatureHeader(secret, body);

    expect(verifySignature('wrong-secret', body, header).valid).toBe(false);
  });

  it('rejects timestamps outside the replay window', () => {
    jest.useFakeTimers().setSystemTime((timestamp + 301) * 1000);
    const header = `t=${timestamp},v1=${createSignature(secret, body, timestamp)}`;

    expect(verifySignature(secret, body, header)).toEqual({
      valid: false,
      error: 'Timestamp outside tolerance window',
    });
  });

  it.each([
    '',
    'v1=abc',
    't=not-a-number,v1=abc',
    't=1700000000,v1=',
    `t=${Math.floor(Date.now() / 1000)},v1=abc,unexpected=value`,
  ])('rejects malformed signature header %s', (header) => {
    expect(verifySignature(secret, body, header)).toMatchObject({
      valid: false,
      error: 'Invalid signature header format',
    });
  });

  it('rejects an oversized header before cryptographic work', () => {
    expect(verifySignature(secret, body, `t=1700000000,v1=${'a'.repeat(300)}`)).toEqual({
      valid: false,
      error: 'Invalid signature header format',
    });
  });
});

describe('canonical payload contract', () => {
  it('sorts object keys recursively without changing arrays', () => {
    const value = {
      z: { beta: 2, alpha: 1 },
      a: [{ z: true, a: false }, null],
      middle: 'value',
    };

    expect(sortKeys(value)).toEqual({
      a: [{ a: false, z: true }, null],
      middle: 'value',
      z: { alpha: 1, beta: 2 },
    });
    expect(JSON.stringify(sortKeys(value))).toBe(
      '{"a":[{"a":false,"z":true},null],"middle":"value","z":{"alpha":1,"beta":2}}',
    );
  });

  it('does not mutate the producer payload', () => {
    const original = { nested: { b: 2, a: 1 } };
    const sorted = sortKeys(original);

    expect(sorted).not.toBe(original);
    expect(original).toEqual({ nested: { b: 2, a: 1 } });
  });
});

describe('bounded delivery retry contract', () => {
  it('retries only transient status failures and returns on recovery', async () => {
    let calls = 0;
    const retryAttempts = [];
    const result = await withRetry(
      async () => {
        calls += 1;
        if (calls < 3) {
          const error = new Error('provider unavailable');
          error.status = 503;
          throw error;
        }
        return { ok: true };
      },
      {
        maxRetries: 5,
        baseDelay: 0,
        maxDelay: 0,
        shouldRetry: (error) => error.status >= 500 && error.status < 600,
        retryDelay: () => 0,
        onRetry: ({ attempt }) => retryAttempts.push(attempt),
      },
    );

    expect(result).toEqual({ ok: true });
    expect(calls).toBe(3);
    expect(retryAttempts).toEqual([1, 2]);
  });

  it('does not retry a permanent response', async () => {
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls += 1;
          const error = new Error('invalid signature');
          error.status = 401;
          throw error;
        },
        {
          maxRetries: 5,
          baseDelay: 0,
          shouldRetry: (error) => error.status >= 500 && error.status < 600,
        },
      ),
    ).rejects.toMatchObject({ status: 401 });
    expect(calls).toBe(1);
  });

  it('caps retry count even when a provider stays unavailable', async () => {
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls += 1;
          const error = new Error('timeout');
          error.code = 'ETIMEDOUT';
          throw error;
        },
        {
          maxRetries: 10_000,
          baseDelay: 0,
          maxDelay: 0,
          shouldRetry: () => true,
          retryDelay: () => 0,
        },
      ),
    ).rejects.toMatchObject({ code: 'ETIMEDOUT' });
    expect(calls).toBe(11);
  });
});

describe('dead-letter persistence contract', () => {
  it('stores the exact payload, endpoint, reason, and attempt count', async () => {
    const query = queryReturning({ id: 'dl-1178-1' });
    db.mockReturnValue(query);
    const payload = { event: 'invoice.paid', invoiceId: 'inv-42', amount: 12 };

    const id = await writeDeadLetter({
      tenantId: 'tenant-42',
      invoiceId: 'inv-42',
      event: 'invoice.paid',
      payload,
      webhookUrl: 'https://merchant.example.test/webhooks',
      attempts: 4,
      lastError: 'Webhook responded with 503',
    });

    expect(id).toBe('dl-1178-1');
    expect(query.insert).toHaveBeenCalledWith({
      tenant_id: 'tenant-42',
      invoice_id: 'inv-42',
      event: 'invoice.paid',
      payload: JSON.stringify(payload),
      webhook_url: 'https://merchant.example.test/webhooks',
      attempts: 4,
      last_error: 'Webhook responded with 503',
    });
  });
});
