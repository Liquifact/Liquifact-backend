'use strict';

// ── Mocks ─────────────────────────────────────────────────────────────────────

const mockDeliveryAttempts = { inc: jest.fn() };
const mockDeliverySuccess = { inc: jest.fn() };
const mockDeadLetters = { inc: jest.fn() };
const mockLogger = { warn: jest.fn(), info: jest.fn(), error: jest.fn() };
const mockCreateTransport = jest.fn((options) => ({
  options,
  sendMail: jest.fn(),
}));

jest.mock('nodemailer', () => ({ createTransport: mockCreateTransport }), { virtual: true });
jest.mock('../src/db/knex', () => jest.fn());
jest.mock('../src/logger', () => mockLogger);
jest.mock('../src/metrics', () => ({
  registerJobQueue: jest.fn(),
  registerWorker: jest.fn(),
  maturityReminderDeliveryAttemptsTotal: mockDeliveryAttempts,
  maturityReminderDeliverySuccessTotal: mockDeliverySuccess,
  maturityReminderDeadLetterTotal: mockDeadLetters,
  normalizeJobType: jest.fn((value) =>
    value === 'maturity_reminder' ? value : 'unknown'
  ),
  normalizeReminderReason: jest.fn((error) => {
    const message = (error && error.message) ? error.message : String(error || '');
    if (/timeout|etimedout|econnrefused/i.test(message)) return 'smtp_timeout';
    if (/reject|550|551|552|553|554/i.test(message)) return 'smtp_reject';
    if (/template/i.test(message)) return 'template_error';
    return 'unknown';
  }),
}));

// ── Module under test ─────────────────────────────────────────────────────────

const {
  scheduleReminder,
  cancelReminder,
  startQueueProcessing,
  stopQueueProcessing,
  invoiceJobs,
  emailQueue,
  emailWorker,
  templates,
  getTransport,
  getMaxAttempts,
  createMaturityReminderHandler,
  persistReminderDeadLetter,
  listReminderDeadLetters,
} = require('../src/jobs/maturityReminders');

const defaultDb = require('../src/db/knex');

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Flushes microtask + macrotask queues so fire-and-forget promises settle. */
function flushPromises() {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * Builds a minimal mock Knex client that returns `rows` for a chained query.
 */
function createListDb(rows = []) {
  const query = {
    select: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    then: (resolve, reject) => Promise.resolve(rows).then(resolve, reject),
  };
  return { db: jest.fn(() => query), query };
}

/** Builds a minimal job object with optional payload overrides. */
function makeJob(payloadOverrides = {}) {
  return {
    id: 'job-42',
    type: 'maturity_reminder',
    payload: {
      invoiceId: 'inv-42',
      customer: 'Alice',
      amount: 500,
      email: 'alice@example.com',
      targetDate: '2026-07-01T00:00:00.000Z',
      ...payloadOverrides,
    },
  };
}

// ── Shared lifecycle ──────────────────────────────────────────────────────────

beforeEach(async () => {
  if (emailWorker.isRunning) {
    await stopQueueProcessing(100);
  }
  emailQueue.clear();
  invoiceJobs.clear();
  jest.clearAllMocks();
  delete process.env.SMTP_HOST;
  delete process.env.SMTP_PORT;
  delete process.env.SMTP_USER;
  delete process.env.SMTP_PASS;
  delete process.env.SMTP_FROM;
  delete process.env.SMTP_MAX_RETRIES;
});

afterAll(async () => {
  await stopQueueProcessing(200);
});

// ─────────────────────────────────────────────────────────────────────────────
// 1. Transport
// ─────────────────────────────────────────────────────────────────────────────

describe('getTransport()', () => {
  it('returns a dry-run transport when SMTP_HOST is unset', async () => {
    const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const result = await getTransport().sendMail({
      to: 'test@example.com',
      subject: 'Test',
      text: 'Hello',
    });
    expect(result.messageId).toBe('mock-id-12345');
    expect(result.response).toBe('250 OK Mock');
    // Dry-run logs three lines: to, subject, text
    expect(consoleSpy).toHaveBeenCalledTimes(3);
    consoleSpy.mockRestore();
  });

  it('does not call nodemailer.createTransport in dry-run mode', () => {
    getTransport();
    expect(mockCreateTransport).not.toHaveBeenCalled();
  });

  it('creates a real SMTP transport when SMTP_HOST is set', () => {
    process.env.SMTP_HOST = 'smtp.example.com';
    process.env.SMTP_USER = 'user@example.com';
    process.env.SMTP_PASS = 'secret';
    const transport = getTransport();
    expect(mockCreateTransport).toHaveBeenCalledWith(
      expect.objectContaining({ host: 'smtp.example.com', port: 587 })
    );
    expect(transport.options).toMatchObject({ host: 'smtp.example.com', port: 587 });
  });

  it('respects a custom SMTP_PORT', () => {
    process.env.SMTP_HOST = 'smtp.example.com';
    process.env.SMTP_PORT = '2525';
    const transport = getTransport();
    expect(transport.options.port).toBe(2525);
  });

  it('never logs SMTP credentials in dry-run output', async () => {
    process.env.SMTP_PASS = 'super-secret-password';
    const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    await getTransport().sendMail({ to: 'x@example.com', subject: 's', text: 't' });
    const allOutput = consoleSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(allOutput).not.toContain('super-secret-password');
    consoleSpy.mockRestore();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Email template
// ─────────────────────────────────────────────────────────────────────────────

describe('templates.maturityReminder()', () => {
  it('includes customer name, amount, and target date', () => {
    const text = templates.maturityReminder('Bob', 2500, '2026-09-15');
    expect(text).toContain('Bob');
    expect(text).toContain('$2500');
    expect(text).toContain('2026-09-15');
  });

  it('does not expose internal system paths or secrets', () => {
    const text = templates.maturityReminder('Alice', 100, '2026-01-01');
    expect(text).not.toContain('process.env');
    expect(text).not.toContain('SMTP');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Retry configuration
// ─────────────────────────────────────────────────────────────────────────────

describe('getMaxAttempts()', () => {
  it('defaults to 3 when SMTP_MAX_RETRIES is unset', () => {
    expect(getMaxAttempts()).toBe(3);
  });

  it('returns 3 for non-numeric SMTP_MAX_RETRIES', () => {
    process.env.SMTP_MAX_RETRIES = 'invalid';
    expect(getMaxAttempts()).toBe(3);
  });

  it('clamps to minimum of 1 when SMTP_MAX_RETRIES is 0 or negative', () => {
    process.env.SMTP_MAX_RETRIES = '0';
    expect(getMaxAttempts()).toBe(1);

    process.env.SMTP_MAX_RETRIES = '-5';
    expect(getMaxAttempts()).toBe(1);
  });

  it('clamps to maximum of 10 when SMTP_MAX_RETRIES exceeds 10', () => {
    process.env.SMTP_MAX_RETRIES = '20';
    expect(getMaxAttempts()).toBe(10);

    process.env.SMTP_MAX_RETRIES = '999';
    expect(getMaxAttempts()).toBe(10);
  });

  it('truncates fractional values', () => {
    process.env.SMTP_MAX_RETRIES = '4.9';
    expect(getMaxAttempts()).toBe(4);

    process.env.SMTP_MAX_RETRIES = '2.1';
    expect(getMaxAttempts()).toBe(2);
  });

  it('accepts valid in-range integers', () => {
    process.env.SMTP_MAX_RETRIES = '5';
    expect(getMaxAttempts()).toBe(5);

    process.env.SMTP_MAX_RETRIES = '1';
    expect(getMaxAttempts()).toBe(1);

    process.env.SMTP_MAX_RETRIES = '10';
    expect(getMaxAttempts()).toBe(10);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Scheduling
// ─────────────────────────────────────────────────────────────────────────────

describe('scheduleReminder() / cancelReminder()', () => {
  it('schedules a reminder and stores it in invoiceJobs', () => {
    const invoice = { id: 'inv-sched-1', customer: 'Bob', amount: 300 };
    const jobId = scheduleReminder(invoice, new Date(Date.now() + 5000), 'bob@example.com');
    expect(typeof jobId).toBe('string');
    expect(invoiceJobs.get(invoice.id)).toBe(jobId);
  });

  it('replaces an existing scheduled reminder on re-schedule', () => {
    const invoice = { id: 'inv-sched-2', customer: 'Carol', amount: 400 };
    const first = scheduleReminder(invoice, new Date(Date.now() + 5000), 'carol@example.com');
    const second = scheduleReminder(invoice, new Date(Date.now() + 6000), 'carol@example.com');
    expect(second).not.toBe(first);
    expect(emailQueue.getJob(first)).toBeNull();
    expect(invoiceJobs.get(invoice.id)).toBe(second);
  });

  it('cancels a pending reminder and removes it from invoiceJobs', () => {
    const invoice = { id: 'inv-sched-3', customer: 'Dave', amount: 200 };
    scheduleReminder(invoice, new Date(Date.now() + 5000), 'dave@example.com');
    expect(cancelReminder(invoice.id)).toBe(true);
    expect(invoiceJobs.has(invoice.id)).toBe(false);
  });

  it('returns false when cancelling a non-existent reminder', () => {
    expect(cancelReminder('nonexistent-invoice')).toBe(false);
  });

  it('schedules immediately (delay=0) when targetDate is in the past', () => {
    const invoice = { id: 'inv-past', customer: 'Eve', amount: 50 };
    const pastDate = new Date(Date.now() - 10000);
    const jobId = scheduleReminder(invoice, pastDate, 'eve@example.com');
    expect(jobId).toBeTruthy();
    expect(invoiceJobs.get(invoice.id)).toBe(jobId);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. Queue lifecycle
// ─────────────────────────────────────────────────────────────────────────────

describe('startQueueProcessing() / stopQueueProcessing()', () => {
  it('starts the email worker', async () => {
    startQueueProcessing();
    expect(emailWorker.isRunning).toBe(true);
    await stopQueueProcessing(100);
  });

  it('is idempotent: calling start twice does not throw', () => {
    startQueueProcessing();
    expect(() => startQueueProcessing()).not.toThrow();
    // Worker should still be running
    expect(emailWorker.isRunning).toBe(true);
  });

  it('stops the email worker', async () => {
    startQueueProcessing();
    await stopQueueProcessing(100);
    expect(emailWorker.isRunning).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. Dead-letter persistence helpers
// ─────────────────────────────────────────────────────────────────────────────

describe('persistReminderDeadLetter()', () => {
  it('inserts a row with expected fields using the injected db client', async () => {
    const insert = jest.fn().mockResolvedValue();
    const dbClient = jest.fn(() => ({ insert }));

    await persistReminderDeadLetter(
      {
        jobId: 'job-1',
        invoiceId: 'inv-1',
        jobType: 'maturity_reminder',
        reason: 'smtp_timeout',
        attempts: 3,
        targetDate: '2026-07-01T00:00:00.000Z',
      },
      dbClient
    );

    expect(dbClient).toHaveBeenCalledWith('maturity_reminder_dead_letters');
    expect(insert).toHaveBeenCalledWith(
      expect.objectContaining({
        job_id: 'job-1',
        invoice_id: 'inv-1',
        reason: 'smtp_timeout',
        attempts: 3,
      })
    );
  });

  it('stores only allowlisted operational metadata in payload_metadata', async () => {
    const insert = jest.fn().mockResolvedValue();
    const dbClient = jest.fn(() => ({ insert }));

    await persistReminderDeadLetter(
      {
        jobId: 'job-2',
        invoiceId: 'inv-2',
        jobType: 'maturity_reminder',
        reason: 'smtp_reject',
        attempts: 1,
        targetDate: '2026-08-01T00:00:00.000Z',
        // These must NOT appear in stored payload
        email: 'sensitive@example.com',
        customer: 'Sensitive Customer',
        amount: 12345,
        body: 'private email body',
      },
      dbClient
    );

    const stored = insert.mock.calls[0][0];
    const meta = JSON.parse(stored.payload_metadata);

    // Only jobType and targetDate go into metadata
    expect(meta).toEqual({
      jobType: 'maturity_reminder',
      targetDate: '2026-08-01T00:00:00.000Z',
    });

    // PII and sensitive fields must not appear anywhere
    const serialized = JSON.stringify(stored);
    expect(serialized).not.toContain('sensitive@example.com');
    expect(serialized).not.toContain('Sensitive Customer');
    expect(serialized).not.toContain('12345');
    expect(serialized).not.toContain('private email body');
  });

  it('falls back to the shared db when no client is injected', async () => {
    const insert = jest.fn().mockResolvedValue();
    defaultDb.mockReturnValueOnce({ insert });

    await persistReminderDeadLetter({
      jobId: 'job-default',
      invoiceId: 'inv-default',
      jobType: 'maturity_reminder',
      reason: 'unknown',
      attempts: 0,
      targetDate: '2026-07-01T00:00:00.000Z',
    });

    expect(insert).toHaveBeenCalledTimes(1);
  });

  it('includes a created_at timestamp', async () => {
    const insert = jest.fn().mockResolvedValue();
    const dbClient = jest.fn(() => ({ insert }));
    const before = new Date();

    await persistReminderDeadLetter(
      { jobId: 'j', invoiceId: 'i', jobType: 'maturity_reminder', reason: 'unknown', attempts: 0, targetDate: '' },
      dbClient
    );

    const stored = insert.mock.calls[0][0];
    expect(stored.created_at).toBeInstanceOf(Date);
    expect(stored.created_at.getTime()).toBeGreaterThanOrEqual(before.getTime());
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. listReminderDeadLetters()
// ─────────────────────────────────────────────────────────────────────────────

describe('listReminderDeadLetters()', () => {
  it('returns rows from the database ordered newest-first', async () => {
    const rows = [{ id: 'dl-1', reason: 'smtp_reject' }, { id: 'dl-2', reason: 'smtp_timeout' }];
    const { db, query } = createListDb(rows);
    const result = await listReminderDeadLetters({}, db);
    expect(result).toEqual(rows);
    expect(query.orderBy).toHaveBeenCalledWith('created_at', 'desc');
  });

  it('defaults limit to 50', async () => {
    const { db, query } = createListDb([]);
    await listReminderDeadLetters({}, db);
    expect(query.limit).toHaveBeenCalledWith(50);
  });

  it('caps limit at 200', async () => {
    const { db, query } = createListDb([]);
    await listReminderDeadLetters({ limit: 999 }, db);
    expect(query.limit).toHaveBeenCalledWith(200);
  });

  it('clamps limit of 0 to 1', async () => {
    const { db, query } = createListDb([]);
    await listReminderDeadLetters({ limit: 0 }, db);
    expect(query.limit).toHaveBeenCalledWith(1);
  });

  it('uses default limit for non-numeric values', async () => {
    const { db, query } = createListDb([]);
    await listReminderDeadLetters({ limit: 'not-a-number' }, db);
    expect(query.limit).toHaveBeenCalledWith(50);
  });

  it('applies a reason filter when provided', async () => {
    const rows = [{ id: 'dl-3', reason: 'smtp_timeout' }];
    const { db, query } = createListDb(rows);
    await listReminderDeadLetters({ limit: 10, reason: 'smtp_timeout' }, db);
    expect(query.where).toHaveBeenCalledWith('reason', 'smtp_timeout');
  });

  it('does not apply where clause when reason is omitted', async () => {
    const { db, query } = createListDb([]);
    await listReminderDeadLetters({ limit: 10 }, db);
    expect(query.where).not.toHaveBeenCalled();
  });

  it('returns empty array when no dead letters exist', async () => {
    const { db } = createListDb([]);
    await expect(listReminderDeadLetters({}, db)).resolves.toEqual([]);
  });

  it('uses the shared default db when no client is injected', async () => {
    const query = {
      select: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      then: (resolve) => Promise.resolve([]).then(resolve),
    };
    defaultDb.mockReturnValueOnce(query);
    await expect(listReminderDeadLetters()).resolves.toEqual([]);
  });

  it('selects only the expected safe columns', async () => {
    const { db, query } = createListDb([]);
    await listReminderDeadLetters({}, db);
    expect(query.select).toHaveBeenCalledWith(
      'id', 'job_id', 'invoice_id', 'reason', 'attempts', 'payload_metadata', 'created_at'
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 8. createMaturityReminderHandler() — successful delivery
// ─────────────────────────────────────────────────────────────────────────────

describe('createMaturityReminderHandler() — successful delivery', () => {
  it('calls sendMail with correct from/to/subject/text', async () => {
    const sendMail = jest.fn().mockResolvedValue({ messageId: 'ok-1' });
    const handler = createMaturityReminderHandler({
      transportFactory: () => ({ sendMail }),
      persistDeadLetter: jest.fn(),
    });

    await handler(makeJob());

    expect(sendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'alice@example.com',
        subject: 'Settlement Reminder: Invoice inv-42',
        from: 'noreply@liquifact.com',
      })
    );
    expect(sendMail.mock.calls[0][0].text).toContain('Alice');
  });

  it('uses SMTP_FROM env variable when set', async () => {
    process.env.SMTP_FROM = 'custom@liquifact.io';
    const sendMail = jest.fn().mockResolvedValue({ messageId: 'ok' });
    const handler = createMaturityReminderHandler({
      transportFactory: () => ({ sendMail }),
      persistDeadLetter: jest.fn(),
    });

    await handler(makeJob());
    expect(sendMail.mock.calls[0][0].from).toBe('custom@liquifact.io');
  });

  it('increments the delivery attempts counter once per attempt', async () => {
    const sendMail = jest.fn().mockResolvedValue({ messageId: 'ok' });
    const handler = createMaturityReminderHandler({
      transportFactory: () => ({ sendMail }),
      persistDeadLetter: jest.fn(),
    });

    await handler(makeJob());
    expect(mockDeliveryAttempts.inc).toHaveBeenCalledTimes(1);
    expect(mockDeliveryAttempts.inc).toHaveBeenCalledWith(
      expect.objectContaining({ job_type: 'maturity_reminder' })
    );
  });

  it('increments the success counter after a successful delivery', async () => {
    const sendMail = jest.fn().mockResolvedValue({ messageId: 'ok' });
    const handler = createMaturityReminderHandler({
      transportFactory: () => ({ sendMail }),
      persistDeadLetter: jest.fn(),
    });

    await handler(makeJob());
    expect(mockDeliverySuccess.inc).toHaveBeenCalledTimes(1);
    expect(mockDeliverySuccess.inc).toHaveBeenCalledWith({ job_type: 'maturity_reminder' });
  });

  it('does NOT increment the dead-letter counter on success', async () => {
    const sendMail = jest.fn().mockResolvedValue({ messageId: 'ok' });
    const handler = createMaturityReminderHandler({
      transportFactory: () => ({ sendMail }),
      persistDeadLetter: jest.fn(),
    });

    await handler(makeJob());
    expect(mockDeadLetters.inc).not.toHaveBeenCalled();
  });

  it('does NOT call persistDeadLetter on success', async () => {
    const sendMail = jest.fn().mockResolvedValue({ messageId: 'ok' });
    const persist = jest.fn();
    const handler = createMaturityReminderHandler({
      transportFactory: () => ({ sendMail }),
      persistDeadLetter: persist,
    });

    await handler(makeJob());
    await flushPromises();
    expect(persist).not.toHaveBeenCalled();
  });

  it('removes the invoice from invoiceJobs map after success', async () => {
    const sendMail = jest.fn().mockResolvedValue({ messageId: 'ok' });
    const handler = createMaturityReminderHandler({
      transportFactory: () => ({ sendMail }),
      persistDeadLetter: jest.fn(),
    });
    invoiceJobs.set('inv-42', 'job-42');

    await handler(makeJob());
    expect(invoiceJobs.has('inv-42')).toBe(false);
  });

  it('resolves (does not throw) on success', async () => {
    const handler = createMaturityReminderHandler({
      transportFactory: () => ({ sendMail: jest.fn().mockResolvedValue({}) }),
      persistDeadLetter: jest.fn(),
    });
    await expect(handler(makeJob())).resolves.toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 9. createMaturityReminderHandler() — transient failures & retry
// ─────────────────────────────────────────────────────────────────────────────

describe('createMaturityReminderHandler() — transient failure / retry', () => {
  it('retries the configured number of times before dead-lettering', async () => {
    process.env.SMTP_MAX_RETRIES = '2';
    const sendMail = jest.fn().mockRejectedValue(new Error('ETIMEDOUT connection'));
    const persist = jest.fn().mockResolvedValue();
    const handler = createMaturityReminderHandler({
      transportFactory: () => ({ sendMail }),
      persistDeadLetter: persist,
    });

    await handler(makeJob());
    await flushPromises();

    expect(sendMail).toHaveBeenCalledTimes(2);
    expect(mockDeliveryAttempts.inc).toHaveBeenCalledTimes(2);
  }, 10000);

  it('increments the dead-letter counter after exhausting retries', async () => {
    process.env.SMTP_MAX_RETRIES = '2';
    const handler = createMaturityReminderHandler({
      transportFactory: () => ({ sendMail: jest.fn().mockRejectedValue(new Error('ETIMEDOUT')) }),
      persistDeadLetter: jest.fn().mockResolvedValue(),
    });

    await handler(makeJob());
    await flushPromises();

    expect(mockDeadLetters.inc).toHaveBeenCalledWith({
      reason: 'smtp_timeout',
      job_type: 'maturity_reminder',
    });
  }, 10000);

  it('does NOT increment the success counter on exhausted-retry failure', async () => {
    process.env.SMTP_MAX_RETRIES = '1';
    const handler = createMaturityReminderHandler({
      transportFactory: () => ({ sendMail: jest.fn().mockRejectedValue(new Error('ETIMEDOUT')) }),
      persistDeadLetter: jest.fn().mockResolvedValue(),
    });

    await handler(makeJob());
    await flushPromises();
    expect(mockDeliverySuccess.inc).not.toHaveBeenCalled();
  }, 5000);

  it('persists a sanitized dead-letter record after retries are exhausted', async () => {
    process.env.SMTP_MAX_RETRIES = '2';
    const persist = jest.fn().mockResolvedValue();
    const handler = createMaturityReminderHandler({
      transportFactory: () => ({ sendMail: jest.fn().mockRejectedValue(new Error('ETIMEDOUT')) }),
      persistDeadLetter: persist,
    });

    await handler(makeJob());
    await flushPromises();

    expect(persist).toHaveBeenCalledTimes(1);
    const record = persist.mock.calls[0][0];
    expect(record.jobId).toBe('job-42');
    expect(record.invoiceId).toBe('inv-42');
    expect(record.jobType).toBe('maturity_reminder');
    expect(record.reason).toBe('smtp_timeout');
    expect(record.attempts).toBe(2);
    expect(record.targetDate).toBe('2026-07-01T00:00:00.000Z');
  }, 10000);

  it('strips PII from the dead-letter record', async () => {
    process.env.SMTP_MAX_RETRIES = '1';
    const persist = jest.fn().mockResolvedValue();
    const handler = createMaturityReminderHandler({
      transportFactory: () => ({ sendMail: jest.fn().mockRejectedValue(new Error('ETIMEDOUT')) }),
      persistDeadLetter: persist,
    });

    await handler(makeJob());
    await flushPromises();

    const serialized = JSON.stringify(persist.mock.calls[0][0]);
    expect(serialized).not.toContain('alice@example.com');
    expect(serialized).not.toContain('Alice');
    expect(serialized).not.toContain('500');
  }, 5000);

  it('removes the invoice from invoiceJobs map even after failure', async () => {
    process.env.SMTP_MAX_RETRIES = '1';
    invoiceJobs.set('inv-42', 'job-42');
    const handler = createMaturityReminderHandler({
      transportFactory: () => ({ sendMail: jest.fn().mockRejectedValue(new Error('ETIMEDOUT')) }),
      persistDeadLetter: jest.fn().mockResolvedValue(),
    });

    await handler(makeJob());
    expect(invoiceJobs.has('inv-42')).toBe(false);
  }, 5000);
});

// ─────────────────────────────────────────────────────────────────────────────
// 10. createMaturityReminderHandler() — permanent SMTP failures
// ─────────────────────────────────────────────────────────────────────────────

describe('createMaturityReminderHandler() — permanent SMTP failure', () => {
  it('dead-letters immediately on a 550 permanent error without retrying', async () => {
    process.env.SMTP_MAX_RETRIES = '5';
    const permError = Object.assign(new Error('550 rejected'), { response: '550 5.1.1 User unknown' });
    const sendMail = jest.fn().mockRejectedValue(permError);
    const persist = jest.fn().mockResolvedValue();
    const handler = createMaturityReminderHandler({
      transportFactory: () => ({ sendMail }),
      persistDeadLetter: persist,
    });

    await handler(makeJob());
    await flushPromises();

    expect(sendMail).toHaveBeenCalledTimes(1);
    expect(persist).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'smtp_reject', attempts: 1 })
    );
  });

  it('increments the dead-letter counter with smtp_reject reason', async () => {
    process.env.SMTP_MAX_RETRIES = '5';
    const permError = Object.assign(new Error('550 rejected'), { response: '550 rejected' });
    const handler = createMaturityReminderHandler({
      transportFactory: () => ({ sendMail: jest.fn().mockRejectedValue(permError) }),
      persistDeadLetter: jest.fn().mockResolvedValue(),
    });

    await handler(makeJob());
    await flushPromises();

    expect(mockDeadLetters.inc).toHaveBeenCalledWith({
      reason: 'smtp_reject',
      job_type: 'maturity_reminder',
    });
  });

  it('does NOT increment the success counter on permanent failure', async () => {
    const permError = Object.assign(new Error('550 rejected'), { response: '550 rejected' });
    const handler = createMaturityReminderHandler({
      transportFactory: () => ({ sendMail: jest.fn().mockRejectedValue(permError) }),
      persistDeadLetter: jest.fn().mockResolvedValue(),
    });

    await handler(makeJob());
    await flushPromises();
    expect(mockDeliverySuccess.inc).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 11. createMaturityReminderHandler() — transport setup failure
// ─────────────────────────────────────────────────────────────────────────────

describe('createMaturityReminderHandler() — transport setup failure', () => {
  it('dead-letters when transportFactory throws', async () => {
    const persist = jest.fn().mockResolvedValue();
    const handler = createMaturityReminderHandler({
      transportFactory: () => { throw new Error('credentials failed'); },
      persistDeadLetter: persist,
    });

    await handler(makeJob());
    await flushPromises();

    expect(persist).toHaveBeenCalledWith(
      expect.objectContaining({ attempts: 0, reason: 'unknown' })
    );
  });

  it('does not leak recipient email in the dead-letter record', async () => {
    const persist = jest.fn().mockResolvedValue();
    const handler = createMaturityReminderHandler({
      transportFactory: () => { throw new Error('credentials failed for alice@example.com'); },
      persistDeadLetter: persist,
    });

    await handler(makeJob());
    await flushPromises();

    const serialized = JSON.stringify(persist.mock.calls[0][0]);
    expect(serialized).not.toContain('alice@example.com');
  });

  it('resolves without throwing even on transport setup failure', async () => {
    const handler = createMaturityReminderHandler({
      transportFactory: () => { throw new Error('setup error'); },
      persistDeadLetter: jest.fn().mockResolvedValue(),
    });

    await expect(handler(makeJob())).resolves.toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 12. createMaturityReminderHandler() — persistence error resilience
// ─────────────────────────────────────────────────────────────────────────────

describe('createMaturityReminderHandler() — persistence error resilience', () => {
  it('does not block the handler on a slow dead-letter persistence call', async () => {
    process.env.SMTP_MAX_RETRIES = '1';
    let finishPersistence;
    const persist = jest.fn(() => new Promise((resolve) => { finishPersistence = resolve; }));
    const handler = createMaturityReminderHandler({
      transportFactory: () => ({ sendMail: jest.fn().mockRejectedValue(new Error('ETIMEDOUT')) }),
      persistDeadLetter: persist,
    });

    const done = handler(makeJob());
    await done;
    // Persistence hasn't finished yet but handler has resolved
    expect(persist).toHaveBeenCalledTimes(1);
    finishPersistence();
    await flushPromises();
  }, 5000);

  it('logs a warn and resolves when persistence rejects with an Error', async () => {
    process.env.SMTP_MAX_RETRIES = '1';
    const handler = createMaturityReminderHandler({
      transportFactory: () => ({ sendMail: jest.fn().mockRejectedValue(new Error('ETIMEDOUT')) }),
      persistDeadLetter: jest.fn().mockRejectedValue(new Error('database unavailable')),
    });

    await expect(handler(makeJob())).resolves.toBeUndefined();
    await flushPromises();

    expect(mockLogger.warn).toHaveBeenCalledWith(
      { err: 'database unavailable', jobId: 'job-42' },
      'Failed to persist maturity-reminder dead letter'
    );
  }, 5000);

  it('logs a warn and resolves when persistence rejects with a string', async () => {
    process.env.SMTP_MAX_RETRIES = '1';
    const handler = createMaturityReminderHandler({
      transportFactory: () => ({ sendMail: jest.fn().mockRejectedValue(new Error('ETIMEDOUT')) }),
      persistDeadLetter: jest.fn().mockRejectedValue('offline'),
    });

    await handler(makeJob());
    await flushPromises();

    expect(mockLogger.warn).toHaveBeenCalledWith(
      { err: 'offline', jobId: 'job-42' },
      'Failed to persist maturity-reminder dead letter'
    );
  }, 5000);
});

// ─────────────────────────────────────────────────────────────────────────────
// 13. createMaturityReminderHandler() — mock (dry-run) transport
// ─────────────────────────────────────────────────────────────────────────────

describe('createMaturityReminderHandler() — dry-run / mock transport', () => {
  it('delivers successfully via the dry-run transport (no SMTP_HOST)', async () => {
    const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const persist = jest.fn();
    const handler = createMaturityReminderHandler({ persistDeadLetter: persist });

    await handler(makeJob());
    await flushPromises();

    expect(mockDeliverySuccess.inc).toHaveBeenCalledTimes(1);
    expect(mockDeadLetters.inc).not.toHaveBeenCalled();
    expect(persist).not.toHaveBeenCalled();
    consoleSpy.mockRestore();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 14. Metrics — normalizeReminderReason (via mocked module)
// ─────────────────────────────────────────────────────────────────────────────

describe('normalizeReminderReason (mocked)', () => {
  const { normalizeReminderReason } = require('../src/metrics');

  it('maps ETIMEDOUT errors to smtp_timeout', () => {
    expect(normalizeReminderReason(new Error('ETIMEDOUT connecting'))).toBe('smtp_timeout');
  });

  it('maps timeout errors to smtp_timeout', () => {
    expect(normalizeReminderReason(new Error('connection timeout'))).toBe('smtp_timeout');
  });

  it('maps ECONNREFUSED errors to smtp_timeout', () => {
    expect(normalizeReminderReason(new Error('ECONNREFUSED'))).toBe('smtp_timeout');
  });

  it('maps 550 rejection errors to smtp_reject', () => {
    expect(normalizeReminderReason(new Error('550 rejected'))).toBe('smtp_reject');
  });

  it('maps unknown errors to unknown', () => {
    expect(normalizeReminderReason(new Error('something else entirely'))).toBe('unknown');
  });

  it('handles null gracefully', () => {
    expect(normalizeReminderReason(null)).toBe('unknown');
  });

  it('handles non-error objects gracefully', () => {
    expect(normalizeReminderReason({ code: 'OTHER' })).toBe('unknown');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 15. End-to-end: cancelled reminder never delivers
// ─────────────────────────────────────────────────────────────────────────────

describe('cancelled reminder', () => {
  it('a cancelled job is never dequeued or delivered', () => {
    const invoice = { id: 'inv-cancel', customer: 'Frank', amount: 75 };
    const jobId = scheduleReminder(invoice, new Date(Date.now() + 60000), 'frank@example.com');
    const cancelled = cancelReminder(invoice.id);
    expect(cancelled).toBe(true);
    expect(emailQueue.getJob(jobId)).toBeNull();
    expect(invoiceJobs.has(invoice.id)).toBe(false);
  });
});
