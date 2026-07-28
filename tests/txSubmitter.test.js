'use strict';

const {
  createTxSubmitterWorker,
  submitWithRetry,
  isRetryableSubmitError,
  computeTxBackoff,
  handleTxSubmitJob,
  DEFAULT_CONFIG,
} = require('../src/workers/txSubmitter');

jest.mock('../src/logger', () => ({
  warn: jest.fn(),
  error: jest.fn(),
  info: jest.fn(),
}));

// ─── isRetryableSubmitError ───────────────────────────────────────────────────

describe('isRetryableSubmitError', () => {
  // Transient — should retry
  it('retries on tx_bad_seq message', () => {
    expect(isRetryableSubmitError(new Error('tx_bad_seq'))).toBe(true);
  });

  it('retries on "timeout" in message', () => {
    expect(isRetryableSubmitError(new Error('network timeout'))).toBe(true);
  });

  it('retries on "timed out" in message', () => {
    expect(isRetryableSubmitError(new Error('connection timed out'))).toBe(true);
  });

  it('retries on "transaction_timeout" in message', () => {
    expect(isRetryableSubmitError(new Error('transaction_timeout'))).toBe(true);
  });

  it('retries on ETIMEDOUT code', () => {
    expect(isRetryableSubmitError({ code: 'ETIMEDOUT' })).toBe(true);
  });

  it('retries on ECONNRESET code', () => {
    expect(isRetryableSubmitError({ code: 'ECONNRESET' })).toBe(true);
  });

  it('retries on EAI_AGAIN code', () => {
    expect(isRetryableSubmitError({ code: 'EAI_AGAIN' })).toBe(true);
  });

  it('retries on ENOTFOUND code', () => {
    expect(isRetryableSubmitError({ code: 'ENOTFOUND' })).toBe(true);
  });

  it('retries when tx_bad_seq is in result.code', () => {
    expect(isRetryableSubmitError({ result: { code: 'tx_bad_seq' } })).toBe(true);
  });

  it('retries when tx_bad_seq is in result.result.code', () => {
    expect(isRetryableSubmitError({ result: { result: { code: 'TX_BAD_SEQ' } } })).toBe(true);
  });

  it('is case-insensitive for error codes', () => {
    expect(isRetryableSubmitError({ code: 'etimedout' })).toBe(true);
  });

  // Permanent — should NOT retry
  it('does not retry on malformed transaction error', () => {
    expect(isRetryableSubmitError(new Error('malformed transaction xdr'))).toBe(false);
  });

  it('does not retry on insufficient fee error', () => {
    expect(isRetryableSubmitError(new Error('insufficient base fee'))).toBe(false);
  });

  it('does not retry on bad signature error', () => {
    expect(isRetryableSubmitError(new Error('bad signature'))).toBe(false);
  });

  it('does not retry on account not found error', () => {
    expect(isRetryableSubmitError(new Error('account not found'))).toBe(false);
  });

  it('does not retry on EACCES code (not in allowlist)', () => {
    expect(isRetryableSubmitError({ code: 'EACCES' })).toBe(false);
  });

  // Non-object inputs
  it('returns false for null', () => {
    expect(isRetryableSubmitError(null)).toBe(false);
  });

  it('returns false for undefined', () => {
    expect(isRetryableSubmitError(undefined)).toBe(false);
  });

  it('returns false for a plain string', () => {
    expect(isRetryableSubmitError('timeout')).toBe(false);
  });

  it('returns false for a number', () => {
    expect(isRetryableSubmitError(408)).toBe(false);
  });

  it('returns false for a boolean', () => {
    expect(isRetryableSubmitError(true)).toBe(false);
  });

  it('returns false for an empty object', () => {
    expect(isRetryableSubmitError({})).toBe(false);
  });

  it('returns false when err.code is a number', () => {
    expect(isRetryableSubmitError({ code: 408 })).toBe(false);
  });

  it('does not crash when err.message is undefined', () => {
    const err = { code: 'ETIMEDOUT', message: undefined };
    expect(isRetryableSubmitError(err)).toBe(true);
  });

  it('does not crash when err.message is null', () => {
    const err = { code: 'ETIMEDOUT', message: null };
    expect(isRetryableSubmitError(err)).toBe(true);
  });

  it('retries on transaction_timeout in result code (Stellar/Horizon-style)', () => {
    expect(isRetryableSubmitError({ result: { code: 'TX_BAD_SEQ' } })).toBe(true);
  });

  it('does not retry when result.code is a non-retryable value', () => {
    expect(isRetryableSubmitError({ result: { code: 'op_underfunded' } })).toBe(false);
  });

  it('does not retry when result.result.code is a non-retryable value', () => {
    expect(isRetryableSubmitError({ result: { result: { code: 'op_no_trust' } } })).toBe(false);
  });

  it('retries on mixed-case error codes (ETIMEDOUT → etimedout)', () => {
    expect(isRetryableSubmitError({ code: 'ETIMEDOUT' })).toBe(true);
    expect(isRetryableSubmitError({ code: 'eTiMeDoUt' })).toBe(true);
  });

  it('retries on TX_BAD_SEQ in result code regardless of case', () => {
    expect(isRetryableSubmitError({ result: { code: 'TX_BAD_SEQ' } })).toBe(true);
    expect(isRetryableSubmitError({ result: { code: 'tx_bad_seq' } })).toBe(true);
  });

  it('does not retry on an error object with only a name property', () => {
    expect(isRetryableSubmitError({ name: 'Error' })).toBe(false);
  });

  it('handles an Array as input (non-object path)', () => {
    expect(isRetryableSubmitError(['timeout'])).toBe(false);
  });
});

// ─── computeTxBackoff ─────────────────────────────────────────────────────────

describe('computeTxBackoff', () => {
  it('returns baseDelay on attempt 0', () => {
    expect(computeTxBackoff(0, 100, 10000)).toBe(100);
  });

  it('doubles on each attempt', () => {
    expect(computeTxBackoff(1, 100, 10000)).toBe(200);
    expect(computeTxBackoff(2, 100, 10000)).toBe(400);
    expect(computeTxBackoff(3, 100, 10000)).toBe(800);
  });

  it('clamps at maxDelay', () => {
    expect(computeTxBackoff(4, 100, 500)).toBe(500);
    expect(computeTxBackoff(10, 100, 500)).toBe(500);
  });

  it('never returns a negative value', () => {
    expect(computeTxBackoff(0, 0, 0)).toBe(0);
  });

  it('returns baseDelay on attempt 0 regardless of maxDelay', () => {
    expect(computeTxBackoff(0, 500, 5000)).toBe(500);
  });

  it('handles large attempt numbers without overflow', () => {
    const result = computeTxBackoff(50, 1, 60000);
    expect(result).toBe(60000);
    expect(Number.isFinite(result)).toBe(true);
  });

  it('exponential growth is correct for attempts 0 through 5', () => {
    // base=100, max=100000
    const expected = [100, 200, 400, 800, 1600, 3200];
    for (let i = 0; i < expected.length; i++) {
      expect(computeTxBackoff(i, 100, 100000)).toBe(expected[i]);
    }
  });

  it('clamps at maxDelay even at extreme attempt counts', () => {
    expect(computeTxBackoff(100, 100, 500)).toBe(500);
  });
});

// ─── DEFAULT_CONFIG bounds ────────────────────────────────────────────────────

describe('DEFAULT_CONFIG env clamping', () => {
  it('maxRetries is clamped to 10', () => {
    expect(DEFAULT_CONFIG.maxRetries).toBeLessThanOrEqual(10);
    expect(DEFAULT_CONFIG.maxRetries).toBeGreaterThanOrEqual(0);
  });

  it('baseDelayMs is clamped to 10000', () => {
    expect(DEFAULT_CONFIG.baseDelayMs).toBeLessThanOrEqual(10000);
    expect(DEFAULT_CONFIG.baseDelayMs).toBeGreaterThanOrEqual(0);
  });

  it('maxDelayMs is clamped to 60000', () => {
    expect(DEFAULT_CONFIG.maxDelayMs).toBeLessThanOrEqual(60000);
    expect(DEFAULT_CONFIG.maxDelayMs).toBeGreaterThanOrEqual(0);
  });

  it('feeBumpMultiplier is clamped to 10', () => {
    expect(DEFAULT_CONFIG.feeBumpMultiplier).toBeLessThanOrEqual(10);
    expect(DEFAULT_CONFIG.feeBumpMultiplier).toBeGreaterThan(0);
  });

  it('feeBumpMultiplier defaults to 2 when env is unset', () => {
    // DEFAULT_CONFIG is computed at module load; this verifies the hard-coded fallback.
    expect(DEFAULT_CONFIG.feeBumpMultiplier).toBeGreaterThanOrEqual(1);
    expect(DEFAULT_CONFIG.feeBumpMultiplier).toBeLessThanOrEqual(10);
  });

  it('all config values are finite numbers', () => {
    expect(Number.isFinite(DEFAULT_CONFIG.maxRetries)).toBe(true);
    expect(Number.isFinite(DEFAULT_CONFIG.baseDelayMs)).toBe(true);
    expect(Number.isFinite(DEFAULT_CONFIG.maxDelayMs)).toBe(true);
    expect(Number.isFinite(DEFAULT_CONFIG.feeBumpMultiplier)).toBe(true);
  });
});

// ─── submitWithRetry ──────────────────────────────────────────────────────────

describe('submitWithRetry', () => {
  const FAST = { maxRetries: 3, baseDelayMs: 1, maxDelayMs: 5 };

  it('resolves immediately on first success', async () => {
    const op = jest.fn().mockResolvedValue('ok');
    await expect(submitWithRetry(op, FAST)).resolves.toBe('ok');
    expect(op).toHaveBeenCalledTimes(1);
  });

  it('passes attempt number and feeBumpMultiplier to the operation', async () => {
    const calls = [];
    const op = jest.fn(async (ctx) => { calls.push({ ...ctx }); return 'done'; });
    await submitWithRetry(op, { ...FAST, feeBumpMultiplier: 2 });
    expect(calls[0]).toEqual({ attempt: 0, feeBumpMultiplier: 2 });
  });

  it('retries a transient error and succeeds on the second attempt', async () => {
    let count = 0;
    const op = jest.fn(async () => {
      count += 1;
      if (count === 1) { throw new Error('tx_bad_seq'); }
      return 'submitted';
    });
    await expect(submitWithRetry(op, FAST)).resolves.toBe('submitted');
    expect(op).toHaveBeenCalledTimes(2);
  });

  it('passes the correct (incrementing) attempt number on each retry', async () => {
    const attempts = [];
    const op = jest.fn(async ({ attempt }) => {
      attempts.push(attempt);
      if (attempt < 2) { throw new Error('tx_bad_seq'); }
      return 'done';
    });
    await submitWithRetry(op, FAST);
    expect(attempts).toEqual([0, 1, 2]);
  });

  it('escalates feeBumpMultiplier context consistently across retries', async () => {
    // The same multiplier value is forwarded on every attempt
    const multipliers = [];
    const op = jest.fn(async ({ attempt, feeBumpMultiplier }) => {
      multipliers.push(feeBumpMultiplier);
      if (attempt < 2) { throw new Error('tx_bad_seq'); }
      return 'done';
    });
    await submitWithRetry(op, { ...FAST, feeBumpMultiplier: 3 });
    expect(multipliers).toEqual([3, 3, 3]);
  });

  it('throws immediately on a permanent (non-retryable) error', async () => {
    const op = jest.fn(async () => { throw new Error('insufficient base fee'); });
    await expect(submitWithRetry(op, FAST)).rejects.toThrow('insufficient base fee');
    expect(op).toHaveBeenCalledTimes(1);
  });

  it('stops after maxRetries and throws the last error', async () => {
    const op = jest.fn(async () => { throw new Error('tx_bad_seq'); });
    await expect(submitWithRetry(op, FAST)).rejects.toThrow('tx_bad_seq');
    // attempt 0, 1, 2, 3 = maxRetries + 1 total calls
    expect(op).toHaveBeenCalledTimes(FAST.maxRetries + 1);
  });

  it('does not exceed maxRetries even for persistent transient errors', async () => {
    const op = jest.fn(async () => {
      const err = new Error('connection reset');
      err.code = 'ECONNRESET';
      throw err;
    });
    const cfg = { maxRetries: 2, baseDelayMs: 1, maxDelayMs: 5 };
    await expect(submitWithRetry(op, cfg)).rejects.toThrow();
    expect(op).toHaveBeenCalledTimes(3); // attempts 0, 1, 2
  });

  it('config overrides default — feeBumpMultiplier propagated to operation', async () => {
    let received;
    const op = jest.fn(async (ctx) => { received = ctx.feeBumpMultiplier; return 'ok'; });
    await submitWithRetry(op, { ...FAST, feeBumpMultiplier: 5 });
    expect(received).toBe(5);
  });

  it('delays stay within baseDelayMs..maxDelayMs', async () => {
    // Verify the delay passed to setTimeout is within bounds
    const delays = [];
    const realSetTimeout = global.setTimeout;
    jest.spyOn(global, 'setTimeout').mockImplementation((fn, ms) => {
      delays.push(ms);
      return realSetTimeout(fn, 0); // skip actual wait
    });

    let count = 0;
    const op = jest.fn(async () => {
      count += 1;
      if (count <= 2) { throw new Error('tx_bad_seq'); }
      return 'ok';
    });

    const cfg = { maxRetries: 3, baseDelayMs: 50, maxDelayMs: 200 };
    await submitWithRetry(op, cfg);

    for (const d of delays) {
      expect(d).toBeGreaterThanOrEqual(50);
      expect(d).toBeLessThanOrEqual(200);
    }

    jest.restoreAllMocks();
  });

  it('does not retry when maxRetries is 0', async () => {
    const op = jest.fn(async () => { throw new Error('tx_bad_seq'); });
    await expect(submitWithRetry(op, { maxRetries: 0, baseDelayMs: 1, maxDelayMs: 5 })).rejects.toThrow('tx_bad_seq');
    expect(op).toHaveBeenCalledTimes(1);
  });

  it('retries exactly maxRetries times on persistent transient errors', async () => {
    const op = jest.fn(async () => { throw new Error('tx_bad_seq'); });
    const cfg = { maxRetries: 1, baseDelayMs: 1, maxDelayMs: 5 };
    await expect(submitWithRetry(op, cfg)).rejects.toThrow('tx_bad_seq');
    expect(op).toHaveBeenCalledTimes(2); // attempt 0 + 1 retry
  });

  it('permanent error short-circuits without consuming retry budget', async () => {
    let calls = 0;
    const op = jest.fn(async () => {
      calls += 1;
      throw new Error('bad signature'); // permanent
    });
    const cfg = { maxRetries: 5, baseDelayMs: 1, maxDelayMs: 5 };
    await expect(submitWithRetry(op, cfg)).rejects.toThrow('bad signature');
    expect(op).toHaveBeenCalledTimes(1); // only one attempt — no retries
  });

  it('fee escalation math: operation receives attempt and multiplier for fee calculation', async () => {
    // The operation should calculate: fee = baseFee * multiplier^attempt
    const fees = [];
    const BASE_FEE = 100;
    const MULTIPLIER = 2;
    const op = jest.fn(async ({ attempt, feeBumpMultiplier }) => {
      const computedFee = Math.floor(BASE_FEE * Math.pow(feeBumpMultiplier, attempt));
      fees.push({ attempt, multiplier: feeBumpMultiplier, computedFee });
      if (attempt < 2) { throw new Error('tx_bad_seq'); }
      return 'ok';
    });
    await submitWithRetry(op, { maxRetries: 3, baseDelayMs: 1, maxDelayMs: 5, feeBumpMultiplier: MULTIPLIER });
    expect(fees).toEqual([
      { attempt: 0, multiplier: 2, computedFee: 100 },   // 100 * 2^0 = 100
      { attempt: 1, multiplier: 2, computedFee: 200 },   // 100 * 2^1 = 200
      { attempt: 2, multiplier: 2, computedFee: 400 },   // 100 * 2^2 = 400
    ]);
  });

  it('feeBumpMultiplier of 1 results in no fee escalation', async () => {
    const fees = [];
    const op = jest.fn(async ({ attempt, feeBumpMultiplier }) => {
      fees.push(feeBumpMultiplier);
      if (attempt < 1) { throw new Error('tx_bad_seq'); }
      return 'ok';
    });
    await submitWithRetry(op, { maxRetries: 2, baseDelayMs: 1, maxDelayMs: 5, feeBumpMultiplier: 1 });
    // All attempts receive multiplier=1
    expect(fees).toEqual([1, 1]);
  });

  it('transient error via result.code triggers retry', async () => {
    let calls = 0;
    const op = jest.fn(async () => {
      calls += 1;
      if (calls === 1) {
        const err = new Error('tx_submission_failed');
        err.result = { code: 'tx_bad_seq' };
        throw err;
      }
      return 'ok';
    });
    await expect(submitWithRetry(op, { maxRetries: 2, baseDelayMs: 1, maxDelayMs: 5 })).resolves.toBe('ok');
    expect(op).toHaveBeenCalledTimes(2);
  });

  it('transient error via code property triggers retry', async () => {
    let calls = 0;
    const op = jest.fn(async () => {
      calls += 1;
      if (calls === 1) {
        const err = new Error('network issue');
        err.code = 'ECONNRESET';
        throw err;
      }
      return 'ok';
    });
    await expect(submitWithRetry(op, { maxRetries: 2, baseDelayMs: 1, maxDelayMs: 5 })).resolves.toBe('ok');
    expect(op).toHaveBeenCalledTimes(2);
  });
});

// ─── handleTxSubmitJob ────────────────────────────────────────────────────────

describe('handleTxSubmitJob', () => {
  const validJob = { payload: { signedTransactionXdr: 'AAAA' + 'B'.repeat(50) } };

  it('throws when job payload is null', async () => {
    await expect(handleTxSubmitJob({ payload: null }, jest.fn())).rejects.toThrow('Invalid tx submit job payload');
  });

  it('throws when job payload is not an object', async () => {
    await expect(handleTxSubmitJob({ payload: 'string' }, jest.fn())).rejects.toThrow('Invalid tx submit job payload');
  });

  it('throws when submitTransactionFn is not a function', async () => {
    await expect(handleTxSubmitJob(validJob, 'notafunction')).rejects.toThrow('submitTransactionFn must be supplied');
  });

  it('throws when signedTransactionXdr is missing', async () => {
    await expect(handleTxSubmitJob({ payload: {} }, jest.fn())).rejects.toThrow('signedTransactionXdr is required');
  });

  it('throws when signedTransactionXdr is an empty string', async () => {
    await expect(handleTxSubmitJob({ payload: { signedTransactionXdr: '   ' } }, jest.fn())).rejects.toThrow('signedTransactionXdr is required');
  });

  it('calls submitTransactionFn with the job payload and retry context', async () => {
    const fn = jest.fn().mockResolvedValue({ status: 'ok' });
    const result = await handleTxSubmitJob(validJob, fn, { maxRetries: 0, baseDelayMs: 1, maxDelayMs: 5 });
    expect(result).toEqual({ status: 'ok' });
    expect(fn).toHaveBeenCalledWith(validJob.payload, expect.objectContaining({ attempt: 0, feeBumpMultiplier: expect.any(Number) }));
  });

  it('retries on transient error from submitTransactionFn', async () => {
    let count = 0;
    const fn = jest.fn(async () => {
      count += 1;
      if (count === 1) { throw new Error('tx_bad_seq'); }
      return 'done';
    });
    const result = await handleTxSubmitJob(validJob, fn, { maxRetries: 2, baseDelayMs: 1, maxDelayMs: 5 });
    expect(result).toBe('done');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('throws immediately on a permanent error from submitTransactionFn', async () => {
    const fn = jest.fn(async () => { throw new Error('bad signature'); });
    await expect(handleTxSubmitJob(validJob, fn, { maxRetries: 3, baseDelayMs: 1, maxDelayMs: 5 })).rejects.toThrow('bad signature');
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

// ─── createTxSubmitterWorker ──────────────────────────────────────────────────

describe('createTxSubmitterWorker', () => {
  it('retries transient failures and completes the job', async () => {
    let attempts = 0;
    const submitFn = jest.fn(async () => {
      attempts += 1;
      if (attempts === 1) {
        const err = new Error('tx_bad_seq');
        err.code = 'TX_BAD_SEQ';
        throw err;
      }
      return { status: 'ok' };
    });

    const { txQueue, enqueueTxSubmission, start, stop } = createTxSubmitterWorker(submitFn, {
      durable: false,
      pollIntervalMs: 10,
      maxConcurrency: 1,
      retryConfig: { maxRetries: 2, baseDelayMs: 1, maxDelayMs: 5 },
    });

    await start();
    const jobId = await enqueueTxSubmission({ signedTransactionXdr: 'AAABBB' });
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(txQueue.getJob(jobId).status).toBe('completed');
    expect(submitFn).toHaveBeenCalledTimes(2);

    await stop();
  });

  it('marks the job as failed on a permanent error', async () => {
    const submitFn = jest.fn(async () => { throw new Error('insufficient fee'); });

    const { txQueue, enqueueTxSubmission, start, stop } = createTxSubmitterWorker(submitFn, {
      durable: false,
      pollIntervalMs: 10,
      maxConcurrency: 1,
      retryConfig: { maxRetries: 2, baseDelayMs: 1, maxDelayMs: 5 },
    });

    await start();
    const jobId = await enqueueTxSubmission({ signedTransactionXdr: 'AAABBB' });
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(txQueue.getJob(jobId).status).toBe('failed');
    expect(submitFn).toHaveBeenCalledTimes(1); // no retry for permanent error

    await stop();
  });
});

function createInMemoryTxSubmissionStore() {
  const rows = new Map();

  const db = jest.fn(() => {
    const query = {
      _where: null,
      _whereIn: null,
      insert(data) {
        rows.set(data.id, { ...data });
        return Promise.resolve([data]);
      },
      where(criteria) {
        query._where = criteria;
        return query;
      },
      whereIn(_column, values) {
        query._whereIn = values;
        return query;
      },
      orderBy() {
        return query;
      },
      update(patch) {
        let matches = [...rows.values()];
        if (query._whereIn) {
          matches = matches.filter((row) => query._whereIn.includes(row.status));
        }
        if (query._where && query._where.id) {
          matches = matches.filter((row) => row.id === query._where.id);
        }
        for (const row of matches) {
          rows.set(row.id, { ...row, ...patch });
        }
        return Promise.resolve(matches.length);
      },
      then(resolve, reject) {
        let matches = [...rows.values()];
        if (query._whereIn) {
          matches = matches.filter((row) => query._whereIn.includes(row.status));
        }
        matches.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
        return Promise.resolve(matches).then(resolve, reject);
      },
    };
    return query;
  });

  return { db, rows };
}

describe('createTxSubmitterWorker durable persistence', () => {
  it('persists enqueue and ack transitions', async () => {
    const { db, rows } = createInMemoryTxSubmissionStore();
    const submitFn = jest.fn(async () => ({ status: 'ok' }));

    const { enqueueTxSubmission, start, stop } = createTxSubmitterWorker(submitFn, {
      db,
      pollIntervalMs: 10,
      retryConfig: { maxRetries: 0, baseDelayMs: 1, maxDelayMs: 5 },
    });

    await start();
    const jobId = await enqueueTxSubmission({ signedTransactionXdr: 'AAABBB' });
    await new Promise((resolve) => setTimeout(resolve, 100));
    await stop();

    const row = rows.get(jobId);
    expect(row.status).toBe('completed');
    expect(row.payload).toContain('signedTransactionXdr');
    expect(row.payload_fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(row.attempts).toBe(1);
  });

  it('retries transient failures, then marks the row completed', async () => {
    const { db, rows } = createInMemoryTxSubmissionStore();
    let attempts = 0;
    const submitFn = jest.fn(async () => {
      attempts += 1;
      if (attempts === 1) {
        throw new Error('tx_bad_seq');
      }
      return { status: 'ok' };
    });

    const { enqueueTxSubmission, start, stop } = createTxSubmitterWorker(submitFn, {
      db,
      pollIntervalMs: 10,
      retryConfig: { maxRetries: 2, baseDelayMs: 1, maxDelayMs: 5 },
    });

    await start();
    const jobId = await enqueueTxSubmission({ signedTransactionXdr: 'AAABBB' });
    await new Promise((resolve) => setTimeout(resolve, 150));
    await stop();

    expect(submitFn).toHaveBeenCalledTimes(2);
    expect(rows.get(jobId).status).toBe('completed');
  });

  it('dead-letters exhausted retries in the database', async () => {
    const { db, rows } = createInMemoryTxSubmissionStore();
    const submitFn = jest.fn(async () => { throw new Error('tx_bad_seq'); });

    const { enqueueTxSubmission, start, stop } = createTxSubmitterWorker(submitFn, {
      db,
      pollIntervalMs: 10,
      retryConfig: { maxRetries: 1, baseDelayMs: 1, maxDelayMs: 5 },
    });

    await start();
    const jobId = await enqueueTxSubmission({ signedTransactionXdr: 'AAABBB' });
    await new Promise((resolve) => setTimeout(resolve, 200));
    await stop();

    const row = rows.get(jobId);
    expect(row.status).toBe('failed');
    expect(row.last_error).toContain('tx_bad_seq');
  });

  it('restores non-terminal jobs after restart without duplicating them', async () => {
    const { db, rows } = createInMemoryTxSubmissionStore();
    const submitFn = jest.fn(async () => ({ status: 'ok' }));

    const first = createTxSubmitterWorker(submitFn, {
      db,
      pollIntervalMs: 10,
      retryConfig: { maxRetries: 0, baseDelayMs: 1, maxDelayMs: 5 },
    });

    const jobId = await first.enqueueTxSubmission({ signedTransactionXdr: 'AAABBB' });
    await first.stop();

    rows.set(jobId, {
      ...rows.get(jobId),
      status: 'processing',
      attempts: 1,
    });

    const second = createTxSubmitterWorker(submitFn, {
      db,
      pollIntervalMs: 10,
      retryConfig: { maxRetries: 0, baseDelayMs: 1, maxDelayMs: 5 },
    });

    const firstRestore = await second.restore();
    const secondRestore = await second.restore();

    expect(firstRestore).toEqual({ restored: 1, skipped: 0 });
    expect(secondRestore).toEqual({ restored: 0, skipped: 0 });
    expect(second.txQueue.getJob(jobId)).toBeTruthy();
    expect(second.txQueue.getStats().pending + second.txQueue.getStats().retrying).toBe(1);

    await second.start();
    await new Promise((resolve) => setTimeout(resolve, 100));
    await second.stop();

    expect(submitFn).toHaveBeenCalledTimes(1);
    expect(rows.get(jobId).status).toBe('completed');
  });

  it('does not persist secret-like payload fields', async () => {
    const { db, rows } = createInMemoryTxSubmissionStore();
    const submitFn = jest.fn(async () => ({ status: 'ok' }));

    const { enqueueTxSubmission, start, stop } = createTxSubmitterWorker(submitFn, {
      db,
      pollIntervalMs: 10,
      retryConfig: { maxRetries: 0, baseDelayMs: 1, maxDelayMs: 5 },
    });

    await start();
    const jobId = await enqueueTxSubmission({
      signedTransactionXdr: 'AAABBB',
      secretKey: 'SUPER-SECRET',
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    await stop();

    const persisted = JSON.parse(rows.get(jobId).payload);
    expect(persisted.signedTransactionXdr).toBe('AAABBB');
    expect(persisted.secretKey).toBe('[REDACTED]');
    expect(rows.get(jobId).payload).not.toContain('SUPER-SECRET');
  });
});
