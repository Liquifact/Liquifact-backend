'use strict';

/**
 * Concurrency hardening tests for index.js and purge workers.
 * Tests startup idempotency, fencing token validation, and race conditions.
 */

const { startPurgeWorker, setFencingToken, validateFencingToken, purgeQueue } = require('../jobs/idempotencyPurge');
const { startPurgeWorker: startInvoiceStatePurgeWorker, setFencingToken: setInvoiceStateFencingToken, validateFencingToken: validateInvoiceStateFencingToken, purgeQueue: invoiceStatePurgeQueue } = require('../jobs/invoiceStatePurge');
const { _resetStartupState } = require('../index');

describe('Concurrency hardening - Startup guards', () => {
  beforeEach(() => {
    // Reset startup state before each test
    if (typeof _resetStartupState === 'function') {
      _resetStartupState();
    }
  });

  describe('Idempotency purge worker fencing tokens', () => {
    beforeEach(() => {
      setFencingToken('test-token-123');
    });

    it('validates jobs with matching fencing token', () => {
      const job = {
        id: 'job-1',
        payload: { fencingToken: 'test-token-123' },
      };
      expect(validateFencingToken(job)).toBe(true);
    });

    it('rejects jobs with mismatched fencing token', () => {
      const job = {
        id: 'job-2',
        payload: { fencingToken: 'stale-token-999' },
      };
      expect(validateFencingToken(job)).toBe(false);
    });

    it('rejects jobs missing fencing token when token is configured', () => {
      const job = {
        id: 'job-3',
        payload: {},
      };
      expect(validateFencingToken(job)).toBe(false);
    });

    it('allows all jobs when no fencing token is configured (backward compatibility)', () => {
      setFencingToken(undefined);
      const job = {
        id: 'job-4',
        payload: {},
      };
      expect(validateFencingToken(job)).toBe(true);
    });
  });

  describe('Invoice state purge worker fencing tokens', () => {
    beforeEach(() => {
      setInvoiceStateFencingToken('invoice-token-456');
    });

    it('validates jobs with matching fencing token', () => {
      const job = {
        id: 'job-1',
        payload: { fencingToken: 'invoice-token-456' },
      };
      expect(validateInvoiceStateFencingToken(job)).toBe(true);
    });

    it('rejects jobs with mismatched fencing token', () => {
      const job = {
        id: 'job-2',
        payload: { fencingToken: 'stale-invoice-token-888' },
      };
      expect(validateInvoiceStateFencingToken(job)).toBe(false);
    });

    it('rejects jobs missing fencing token when token is configured', () => {
      const job = {
        id: 'job-3',
        payload: {},
      };
      expect(validateInvoiceStateFencingToken(job)).toBe(false);
    });
  });

  describe('Worker startup idempotency', () => {
    it('startPurgeWorker is idempotent - can be called multiple times safely', () => {
      const spy = jest.spyOn(purgeQueue, 'enqueue').mockImplementation(() => 'job-id');
      
      // Call startPurgeWorker multiple times
      startPurgeWorker({ fencingToken: 'token-1' });
      startPurgeWorker({ fencingToken: 'token-2' });
      startPurgeWorker({ fencingToken: 'token-3' });

      // Worker should only start once
      expect(spy).toHaveBeenCalledTimes(1);
      
      spy.mockRestore();
    });

    it('startInvoiceStatePurgeWorker is idempotent - can be called multiple times safely', () => {
      const spy = jest.spyOn(invoiceStatePurgeQueue, 'enqueue').mockImplementation(() => 'job-id');
      
      // Call startPurgeWorker multiple times
      startInvoiceStatePurgeWorker({ fencingToken: 'token-1' });
      startInvoiceStatePurgeWorker({ fencingToken: 'token-2' });
      startInvoiceStatePurgeWorker({ fencingToken: 'token-3' });

      // Worker should only start once
      expect(spy).toHaveBeenCalledTimes(1);
      
      spy.mockRestore();
    });
  });

  describe('Fencing token isolation between workers', () => {
    it('maintains separate fencing tokens for each worker type', () => {
      setFencingToken('idempotency-token');
      setInvoiceStateFencingToken('invoice-state-token');

      const idempotencyJob = {
        id: 'job-1',
        payload: { fencingToken: 'idempotency-token' },
      };
      const invoiceStateJob = {
        id: 'job-2',
        payload: { fencingToken: 'invoice-state-token' },
      };

      expect(validateFencingToken(idempotencyJob)).toBe(true);
      expect(validateInvoiceStateFencingToken(invoiceStateJob)).toBe(true);

      // Cross-validation should fail
      expect(validateFencingToken(invoiceStateJob)).toBe(false);
      expect(validateInvoiceStateFencingToken(idempotencyJob)).toBe(false);
    });
  });
});
