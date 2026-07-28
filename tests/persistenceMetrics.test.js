'use strict';

const express = require('express');
const request = require('supertest');
const {
  instrumentPersistence,
  recordPersistenceOutcome,
} = require('../src/middleware/persistenceMetrics');
const metrics = require('../src/metrics');

/** Reads a single counter value for a label set (real prom-client, async get). */
async function counterValue(counter, labels) {
  const metric = await counter.get();
  const keys = Object.keys(labels);
  const match = (metric.values || []).find((v) =>
    keys.every((k) => String(v.labels[k]) === String(labels[k])),
  );
  return match ? match.value : 0;
}

describe('persistence metrics instrumentation', () => {
  beforeEach(() => {
    metrics.persistenceRequestDurationSeconds.reset();
    metrics.persistenceRequestsTotal.reset();
    metrics.persistenceRequestErrorsTotal.reset();
  });

  describe('normalizePersistenceStatusClass', () => {
    it('maps 2xx, 4xx, 5xx correctly', async () => {
      expect(metrics.normalizePersistenceStatusClass(201)).toBe('2xx');
      expect(metrics.normalizePersistenceStatusClass(400)).toBe('4xx');
      expect(metrics.normalizePersistenceStatusClass(503)).toBe('5xx');
      expect(metrics.normalizePersistenceStatusClass('200')).toBe('2xx');
    });
  });

  describe('normalizePersistenceEndpoint', () => {
    it('passes known endpoints and collapses unknown', async () => {
      expect(metrics.normalizePersistenceEndpoint('sme_invoice_upload')).toBe('sme_invoice_upload');
      expect(metrics.normalizePersistenceEndpoint('nope')).toBe('unknown');
      expect(metrics.normalizePersistenceEndpoint(42)).toBe('unknown');
    });
  });

  describe('normalizePersistenceCause', () => {
    it('returns none for success', async () => {
      expect(metrics.normalizePersistenceCause(null, 200)).toBe('none');
    });
    it('maps storage-service validation codes to validation', async () => {
      expect(metrics.normalizePersistenceCause({ code: 'INVALID_MIME_TYPE' }, 400)).toBe('validation');
      expect(metrics.normalizePersistenceCause({ code: 'FILE_TOO_LARGE' }, 400)).toBe('validation');
      expect(metrics.normalizePersistenceCause({ code: 'INVALID_TENANT_ID' }, 400)).toBe('validation');
    });
    it('maps any 4xx without a code to validation', async () => {
      expect(metrics.normalizePersistenceCause(null, 422)).toBe('validation');
    });
    it('maps storage-layer error codes to storage', async () => {
      expect(metrics.normalizePersistenceCause({ code: 'STORAGE_WRITE_FAILED' }, 500)).toBe('storage');
      expect(metrics.normalizePersistenceCause({ code: 'ENOENT' }, 500)).toBe('storage');
      expect(metrics.normalizePersistenceCause({ code: 'EACCES' }, 500)).toBe('storage');
    });
    it('maps other server errors to internal', async () => {
      expect(metrics.normalizePersistenceCause(new Error('boom'), 500)).toBe('internal');
      expect(metrics.normalizePersistenceCause({}, 500)).toBe('internal');
    });
  });

  describe('recordPersistenceOutcome', () => {
    it('records duration + request count and no error on success', async () => {
      recordPersistenceOutcome({
        endpoint: 'sme_invoice_upload',
        statusCode: 200,
        durationSeconds: 0.02,
      });
      expect(await counterValue(metrics.persistenceRequestsTotal, { endpoint: 'sme_invoice_upload', status_class: '2xx' })).toBe(1);
      expect(await counterValue(metrics.persistenceRequestErrorsTotal, { endpoint: 'sme_invoice_upload', cause: 'none' })).toBe(0);
    });

    it('records a validation error on a 4xx', async () => {
      recordPersistenceOutcome({
        endpoint: 'sme_invoice_upload',
        statusCode: 400,
        durationSeconds: 0.01,
        error: { code: 'INVALID_MIME_TYPE' },
      });
      expect(await counterValue(metrics.persistenceRequestsTotal, { endpoint: 'sme_invoice_upload', status_class: '4xx' })).toBe(1);
      expect(await counterValue(metrics.persistenceRequestErrorsTotal, { endpoint: 'sme_invoice_upload', cause: 'validation' })).toBe(1);
    });

    it('records an internal error on a 5xx', async () => {
      recordPersistenceOutcome({
        endpoint: 'sme_invoice_upload',
        statusCode: 500,
        durationSeconds: 0.05,
        error: new Error('boom'),
      });
      expect(await counterValue(metrics.persistenceRequestsTotal, { endpoint: 'sme_invoice_upload', status_class: '5xx' })).toBe(1);
      expect(await counterValue(metrics.persistenceRequestErrorsTotal, { endpoint: 'sme_invoice_upload', cause: 'internal' })).toBe(1);
    });

    it('collapses an unknown endpoint to the bounded label', async () => {
      recordPersistenceOutcome({ endpoint: 'mystery', statusCode: 200, durationSeconds: 0.01 });
      expect(await counterValue(metrics.persistenceRequestsTotal, { endpoint: 'unknown', status_class: '2xx' })).toBe(1);
    });

    it('uses a request-scoped logger when a req is supplied', async () => {
      const req = { id: 'r1', correlationId: 'c1' };
      expect(() => recordPersistenceOutcome({
        endpoint: 'sme_invoice_upload',
        statusCode: 200,
        durationSeconds: 0.01,
        req,
      })).not.toThrow();
    });
  });

  describe('instrumentPersistence guard branches', () => {
    const { EventEmitter } = require('events');

    /** Minimal fake res that lets us emit finish manually and toggle locals. */
    function fakeRes({ withLocals = true, statusCode = 200 } = {}) {
      const res = new EventEmitter();
      res.statusCode = statusCode;
      res.headersSent = false;
      if (withLocals) { res.locals = {}; }
      return res;
    }

    it('records only once even if finish fires twice', async () => {
      const res = fakeRes({ statusCode: 200 });
      const handler = async () => {};
      await instrumentPersistence('sme_invoice_upload', handler)({}, res, () => {});
      res.emit('finish');
      res.emit('finish'); // second emit must hit the `recorded` guard and no-op
      expect(await counterValue(metrics.persistenceRequestsTotal, { endpoint: 'sme_invoice_upload', status_class: '2xx' })).toBe(1);
    });

    it('does not throw when res.locals is absent and the handler throws', async () => {
      const res = fakeRes({ withLocals: false, statusCode: 500 });
      const err = new Error('no-locals');
      const handler = async () => { throw err; };
      let passed;
      await instrumentPersistence('sme_invoice_upload', handler)({}, res, (e) => { passed = e; });
      expect(passed).toBe(err);
      res.emit('finish'); // records with undefined error, status 500 -> internal
      expect(await counterValue(metrics.persistenceRequestErrorsTotal, { endpoint: 'sme_invoice_upload', cause: 'internal' })).toBe(1);
    });
  });
  describe('instrumentPersistence wrapper', () => {
    function buildApp(handler, endpoint = 'sme_invoice_upload') {
      const app = express();
      app.use(express.json());
      app.post('/persist', instrumentPersistence(endpoint, handler));
      app.use((err, _req, res, _next) => res.status(res.statusCode >= 400 ? res.statusCode : 500).json({ error: 'x' }));
      return app;
    }

    it('records a 2xx for a successful handler', async () => {
      const app = buildApp(async (_req, res) => { res.status(201).json({ ok: true }); });
      const res = await request(app).post('/persist').send({});
      expect(res.status).toBe(201);
      expect(await counterValue(metrics.persistenceRequestsTotal, { endpoint: 'sme_invoice_upload', status_class: '2xx' })).toBe(1);
    });

    it('records a 4xx when the handler responds with a client error', async () => {
      const app = buildApp(async (_req, res) => { res.status(400).json({ error: 'bad' }); });
      const res = await request(app).post('/persist').send({});
      expect(res.status).toBe(400);
      expect(await counterValue(metrics.persistenceRequestErrorsTotal, { endpoint: 'sme_invoice_upload', cause: 'validation' })).toBe(1);
    });

    it('records and re-throws when the handler throws', async () => {
      const app = buildApp(async () => { const e = new Error('kaboom'); e.code = 'STORAGE_WRITE_FAILED'; throw e; });
      const res = await request(app).post('/persist').send({});
      expect(res.status).toBe(500);
      expect(await counterValue(metrics.persistenceRequestErrorsTotal, { endpoint: 'sme_invoice_upload', cause: 'storage' })).toBeGreaterThanOrEqual(1);
    });
  });
});