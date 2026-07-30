/**
 * @file Tests for the invoice-state request-logging/metrics middleware
 * ({@link module:middleware/invoiceStateMetrics}).
 *
 * Uses `jest.resetModules()` + `jest.doMock()` (not a plain top-of-file
 * `jest.mock('../metrics', ...)`) because this repo's global
 * `tests/mocks/setup.js` (`setupFilesAfterEnv`) already registers its own,
 * incomplete `../metrics` mock, and this repo's Jest config has
 * `"transform": {}` (no babel-jest), so plain `jest.mock()` calls in a test
 * file are not hoisted above that global registration and do not reliably
 * take precedence for the same module path. `jest.resetModules()` +
 * `jest.doMock()` immediately before `require()` sidesteps that — the same
 * technique already validated in `src/services/health.invoiceState.test.js`.
 *
 * `tests/invoiceState.observability.test.js` (pre-existing) attempts to
 * cover this same concern but is a stale artifact: it references
 * `mockInvoices` as an export of `src/routes/invoiceStateRoutes.js`, which
 * does not exist — the current routes are DB-backed via
 * `services/invoiceStateService`, not an in-memory map. That file currently
 * fails even on unmodified `main` (`registry.resetMetrics is not a
 * function`, the same setup.js precedence issue described above, compounded
 * by the architecture mismatch). Left untouched — out of scope here.
 */

'use strict';

describe('invoiceStateMetrics', () => {
  let logger;
  let invoiceStateRequestDurationMs;
  let invoiceStateRequestCount;
  let instrumentInvoiceState;
  let recordInvoiceStateOutcome;
  let normalizeStatusClass;
  let normalizeErrorCause;

  beforeEach(() => {
    jest.resetModules();

    invoiceStateRequestDurationMs = { labels: jest.fn().mockReturnThis(), observe: jest.fn() };
    invoiceStateRequestCount = { labels: jest.fn().mockReturnThis(), inc: jest.fn() };

    jest.doMock('../metrics', () => ({
      invoiceStateRequestDurationMs,
      invoiceStateRequestCount,
    }));

    logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
    logger.createRequestLogger = jest.fn(() => logger);
    jest.doMock('../logger', () => logger);

    ({ instrumentInvoiceState, recordInvoiceStateOutcome, normalizeStatusClass, normalizeErrorCause } =
      require('./invoiceStateMetrics'));
  });

  afterEach(() => {
    jest.dontMock('../metrics');
    jest.dontMock('../logger');
  });

  describe('normalizeStatusClass', () => {
    it.each([
      [200, '2xx'],
      [201, '2xx'],
      [301, '3xx'],
      [400, '4xx'],
      [404, '4xx'],
      [500, '5xx'],
      [503, '5xx'],
      [0, 'other'],
    ])('maps %i to %s', (statusCode, expected) => {
      expect(normalizeStatusClass(statusCode)).toBe(expected);
    });
  });

  describe('normalizeErrorCause', () => {
    it('returns "none" when there is no error', () => {
      expect(normalizeErrorCause(undefined)).toBe('none');
      expect(normalizeErrorCause(null)).toBe('none');
    });

    it('returns the bounded StateTransitionError code when present', () => {
      const error = Object.assign(new Error('Invoice not found'), {
        name: 'StateTransitionError',
        code: 'INVOICE_NOT_FOUND',
      });
      expect(normalizeErrorCause(error)).toBe('INVOICE_NOT_FOUND');
    });

    it('falls back to internal_error for an unrecognized error shape', () => {
      expect(normalizeErrorCause(new Error('boom'))).toBe('internal_error');
    });

    it('falls back to internal_error when name matches but code is missing', () => {
      const error = Object.assign(new Error('boom'), { name: 'StateTransitionError' });
      expect(normalizeErrorCause(error)).toBe('internal_error');
    });
  });

  describe('recordInvoiceStateOutcome', () => {
    it('logs at info level for a 2xx outcome, with no PII fields', () => {
      recordInvoiceStateOutcome({ route: 'state', method: 'GET', statusCode: 200, durationMs: 12.3456 });

      expect(invoiceStateRequestDurationMs.labels).toHaveBeenCalledWith('state', 'GET', '2xx', 'none');
      expect(invoiceStateRequestDurationMs.observe).toHaveBeenCalledWith(12.3456);
      expect(invoiceStateRequestCount.labels).toHaveBeenCalledWith('state', 'GET', '2xx', 'none');
      expect(invoiceStateRequestCount.inc).toHaveBeenCalled();

      expect(logger.info).toHaveBeenCalledWith(
        {
          route: 'state',
          method: 'GET',
          statusClass: '2xx',
          statusCode: 200,
          durationMs: 12.346,
          errorCause: 'none',
        },
        'invoice-state request completed'
      );
      // No PII / secret-shaped fields: no invoiceId, body, reason, message, or stack.
      const loggedFields = logger.info.mock.calls[0][0];
      expect(Object.keys(loggedFields).sort()).toEqual(
        ['durationMs', 'errorCause', 'method', 'route', 'statusClass', 'statusCode'].sort()
      );
    });

    it('logs at warn level for a 4xx outcome', () => {
      const error = Object.assign(new Error('x'), { name: 'StateTransitionError', code: 'MISSING_TARGET_STATE' });
      recordInvoiceStateOutcome({ route: 'transition', method: 'POST', statusCode: 400, durationMs: 5, error });

      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ statusClass: '4xx', errorCause: 'MISSING_TARGET_STATE' }),
        'invoice-state request rejected'
      );
      expect(logger.info).not.toHaveBeenCalled();
      expect(logger.error).not.toHaveBeenCalled();
    });

    it('logs at error level for a 5xx outcome', () => {
      recordInvoiceStateOutcome({
        route: 'approve',
        method: 'POST',
        statusCode: 500,
        durationMs: 42,
        error: new Error('db down'),
      });

      expect(logger.error).toHaveBeenCalledWith(
        expect.objectContaining({ statusClass: '5xx', errorCause: 'internal_error' }),
        'invoice-state request failed'
      );
      expect(logger.info).not.toHaveBeenCalled();
      expect(logger.warn).not.toHaveBeenCalled();
    });

    it('uses a request-scoped logger when req is provided', () => {
      const scopedLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
      logger.createRequestLogger.mockReturnValue(scopedLogger);
      const req = { id: 'req-123' };

      recordInvoiceStateOutcome({ route: 'state', method: 'GET', statusCode: 200, durationMs: 1, req });

      expect(logger.createRequestLogger).toHaveBeenCalledWith(req);
      expect(scopedLogger.info).toHaveBeenCalled();
      expect(logger.info).not.toHaveBeenCalled();
    });
  });

  describe('instrumentInvoiceState', () => {
    function fakeRes(statusCode) {
      const listeners = {};
      return {
        statusCode,
        locals: {},
        on: jest.fn((event, cb) => { listeners[event] = cb; }),
        _finish: () => listeners.finish && listeners.finish(),
      };
    }

    it('records the outcome once the response finishes, with the real status code', async () => {
      const handler = jest.fn(async (req, res) => {
        res.statusCode = 200;
      });
      const wrapped = instrumentInvoiceState('state', handler);
      const req = {};
      const res = fakeRes(200);

      await wrapped(req, res, jest.fn());
      res._finish();

      expect(handler).toHaveBeenCalledWith(req, res, expect.any(Function));
      expect(invoiceStateRequestCount.labels).toHaveBeenCalledWith('state', undefined, '2xx', 'none');
    });

    it('stashes a thrown error on res.locals and re-throws to next, then records it on finish', async () => {
      const boom = Object.assign(new Error('nope'), { name: 'StateTransitionError', code: 'INVOICE_NOT_FOUND' });
      const handler = jest.fn(async () => { throw boom; });
      const wrapped = instrumentInvoiceState('state', handler);
      const req = { method: 'GET' };
      const res = fakeRes(404);
      const next = jest.fn();

      await wrapped(req, res, next);

      expect(next).toHaveBeenCalledWith(boom);
      expect(res.locals.invoiceStateMetricsError).toBe(boom);

      res._finish();
      expect(invoiceStateRequestCount.labels).toHaveBeenCalledWith('state', 'GET', '4xx', 'INVOICE_NOT_FOUND');
    });

    it('only records once even if finish fires more than once', async () => {
      const handler = jest.fn(async (req, res) => { res.statusCode = 200; });
      const wrapped = instrumentInvoiceState('state', handler);
      const res = fakeRes(200);

      await wrapped({}, res, jest.fn());
      res._finish();
      res._finish();

      expect(invoiceStateRequestCount.inc).toHaveBeenCalledTimes(1);
    });
  });
});
