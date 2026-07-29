'use strict';

const express = require('express');
const request = require('supertest');
const { instrumentConfig, recordConfigOutcome } = require('../src/middleware/configMetrics');
const metrics = require('../src/metrics');

async function counterValue(counter, labels) {
  const metric = await counter.get();
  const keys = Object.keys(labels);
  const match = (metric.values || []).find((v) =>
    keys.every((k) => String(v.labels[k]) === String(labels[k])),
  );
  return match ? match.value : 0;
}

describe('config metrics instrumentation', () => {
  beforeEach(() => {
    metrics.configRequestDurationSeconds.reset();
    metrics.configRequestsTotal.reset();
    metrics.configRequestErrorsTotal.reset();
  });

  describe('normalizeConfigStatusClass', () => {
    it('maps 2xx, 4xx, 5xx correctly', () => {
      expect(metrics.normalizeConfigStatusClass(200)).toBe('2xx');
      expect(metrics.normalizeConfigStatusClass(201)).toBe('2xx');
      expect(metrics.normalizeConfigStatusClass(400)).toBe('4xx');
      expect(metrics.normalizeConfigStatusClass(404)).toBe('4xx');
      expect(metrics.normalizeConfigStatusClass(503)).toBe('5xx');
      expect(metrics.normalizeConfigStatusClass(500)).toBe('5xx');
      expect(metrics.normalizeConfigStatusClass('200')).toBe('2xx');
    });
  });

  describe('normalizeConfigEndpoint', () => {
    it('passes known endpoints', () => {
      expect(metrics.normalizeConfigEndpoint('config_update')).toBe('config_update');
      expect(metrics.normalizeConfigEndpoint('config_sections')).toBe('config_sections');
    });

    it('collapses unknown endpoints to unknown', () => {
      expect(metrics.normalizeConfigEndpoint('nope')).toBe('unknown');
      expect(metrics.normalizeConfigEndpoint('')).toBe('unknown');
      expect(metrics.normalizeConfigEndpoint(42)).toBe('unknown');
      expect(metrics.normalizeConfigEndpoint(null)).toBe('unknown');
    });
  });

  describe('normalizeConfigCause', () => {
    it('returns none for successful responses', () => {
      expect(metrics.normalizeConfigCause(null, 200)).toBe('none');
      expect(metrics.normalizeConfigCause(undefined, 201)).toBe('none');
    });

    it('returns validation for 4xx responses', () => {
      expect(metrics.normalizeConfigCause(null, 400)).toBe('validation');
      expect(metrics.normalizeConfigCause({ message: 'invalid' }, 400)).toBe('validation');
    });

    it('returns internal for 5xx responses', () => {
      expect(metrics.normalizeConfigCause(new Error('boom'), 500)).toBe('internal');
      expect(metrics.normalizeConfigCause({}, 503)).toBe('internal');
    });
  });

  describe('recordConfigOutcome', () => {
    async function getCounterVal(counter, labels) {
      const data = await counter.get();
      if (Array.isArray(data.values)) {
        const match = data.values.find((v) =>
          Object.keys(labels).every((k) => String(v.labels[k]) === String(labels[k])),
        );
        return match ? match.value : 0;
      }
      const key = JSON.stringify(labels);
      const entry = data.hashMap && data.hashMap[key];
      return entry ? entry.value : 0;
    }

    it('records success metrics and info log for 2xx', () => {
      const loggerInfo = jest.spyOn(require('../src/logger'), 'info').mockImplementation(() => {});
      const loggerWarn = jest.spyOn(require('../src/logger'), 'warn').mockImplementation(() => {});
      const loggerError = jest.spyOn(require('../src/logger'), 'error').mockImplementation(() => {});

      recordConfigOutcome({
        endpoint: 'config_update',
        statusCode: 200,
        durationSeconds: 0.123,
        error: null,
        req: null,
      });

      expect(loggerInfo).toHaveBeenCalledWith(
        expect.objectContaining({ endpoint: 'config_update', statusClass: '2xx', statusCode: 200 }),
        'config endpoint request completed',
      );
      expect(loggerWarn).not.toHaveBeenCalled();
      expect(loggerError).not.toHaveBeenCalled();

      loggerInfo.mockRestore();
      loggerWarn.mockRestore();
      loggerError.mockRestore();
    });

    it('records warn log for 4xx', () => {
      const loggerWarn = jest.spyOn(require('../src/logger'), 'warn').mockImplementation(() => {});

      recordConfigOutcome({
        endpoint: 'config_update',
        statusCode: 400,
        durationSeconds: 0.05,
        error: null,
        req: null,
      });

      expect(loggerWarn).toHaveBeenCalledWith(
        expect.objectContaining({ endpoint: 'config_update', statusClass: '4xx', statusCode: 400 }),
        'config endpoint request rejected',
      );

      loggerWarn.mockRestore();
    });

    it('records error log for 5xx', () => {
      const loggerError = jest.spyOn(require('../src/logger'), 'error').mockImplementation(() => {});

      recordConfigOutcome({
        endpoint: 'config_update',
        statusCode: 500,
        durationSeconds: 0.1,
        error: new Error('server error'),
        req: null,
      });

      expect(loggerError).toHaveBeenCalledWith(
        expect.objectContaining({ endpoint: 'config_update', statusClass: '5xx', statusCode: 500 }),
        'config endpoint request failed',
      );

      loggerError.mockRestore();
    });

    it('increments error counter when cause is not none', async () => {
      recordConfigOutcome({
        endpoint: 'config_update',
        statusCode: 400,
        durationSeconds: 0.01,
        error: { message: 'bad request' },
        req: null,
      });

      expect(await getCounterVal(metrics.configRequestErrorsTotal, { endpoint: 'config_update', cause: 'validation' })).toBeGreaterThanOrEqual(1);
    });

    it('does not increment error counter when cause is none', async () => {
      recordConfigOutcome({
        endpoint: 'config_update',
        statusCode: 200,
        durationSeconds: 0.01,
        error: null,
        req: null,
      });

      expect(await getCounterVal(metrics.configRequestErrorsTotal, { endpoint: 'config_update', cause: 'none' })).toBe(0);
    });
  });

  describe('instrumentConfig', () => {
    let app;

    beforeEach(() => {
      app = express();
      app.use(express.json());
      metrics.configRequestDurationSeconds.reset();
      metrics.configRequestsTotal.reset();
      metrics.configRequestErrorsTotal.reset();
    });

    function buildTestHandler(statusCode, body, shouldThrow) {
      return instrumentConfig('config_update', async (req, res) => {
        if (shouldThrow) {
          throw new Error(shouldThrow);
        }
        res.status(statusCode).json(body);
      });
    }

    async function counterVal(counter, labels) {
      const data = await counter.get();
      if (Array.isArray(data.values)) {
        const match = data.values.find((v) =>
          Object.keys(labels).every((k) => String(v.labels[k]) === String(labels[k])),
        );
        return match ? match.value : 0;
      }
      const key = JSON.stringify(labels);
      const entry = data.hashMap && data.hashMap[key];
      return entry ? entry.value : 0;
    }

    it('records success metrics on 200 response', async () => {
      app.post('/test', buildTestHandler(200, { ok: true }));

      const res = await request(app).post('/test').send({});

      expect(res.status).toBe(200);
      expect(await counterVal(metrics.configRequestsTotal, { endpoint: 'config_update', status_class: '2xx' })).toBe(1);
    });

    it('records client error metrics on 400 response', async () => {
      app.post('/test', buildTestHandler(400, { error: 'bad' }));

      const res = await request(app).post('/test').send({});

      expect(res.status).toBe(400);
      expect(await counterVal(metrics.configRequestsTotal, { endpoint: 'config_update', status_class: '4xx' })).toBe(1);
      expect(await counterVal(metrics.configRequestErrorsTotal, { endpoint: 'config_update', cause: 'validation' })).toBe(1);
    });

    it('records server error metrics when handler throws', async () => {
      app.post('/test', buildTestHandler(200, null, 'server error'));

      app.use((err, req, res, next) => {
        res.status(500).json({ error: err.message });
      });

      const res = await request(app).post('/test').send({});

      expect(res.status).toBe(500);
      expect(await counterVal(metrics.configRequestsTotal, { endpoint: 'config_update', status_class: '5xx' })).toBe(1);
      expect(await counterVal(metrics.configRequestErrorsTotal, { endpoint: 'config_update', cause: 'internal' })).toBe(1);
    });

    it('records metrics for config_sections endpoint', async () => {
      app.get('/sections', instrumentConfig('config_sections', (req, res) => {
        res.status(200).json({ sections: [] });
      }));

      const res = await request(app).get('/sections');

      expect(res.status).toBe(200);
      expect(await counterVal(metrics.configRequestsTotal, { endpoint: 'config_sections', status_class: '2xx' })).toBe(1);
    });

    it('records histogram duration', async () => {
      app.post('/test', buildTestHandler(200, { ok: true }));

      await request(app).post('/test').send({});

      const durationMetric = metrics.configRequestDurationSeconds;
      const histogramData = await durationMetric.get();
      const match = (histogramData.values || []).find(
        (v) => v.labels.endpoint === 'config_update' && v.labels.status_class === '2xx',
      );
      expect(match).toBeDefined();
      expect(match.value).toBeGreaterThan(0);
    });
  });

  describe('CONFIG_ENDPOINT_ENUM completeness', () => {
    it('contains all expected endpoint labels', () => {
      const enm = metrics.CONFIG_ENDPOINT_ENUM;
      expect(enm).toContain('config_update');
      expect(enm).toContain('config_sections');
      expect(enm).toContain('unknown');
      expect(Object.isFrozen(enm)).toBe(true);
    });
  });

  describe('CONFIG_CAUSE_ENUM completeness', () => {
    it('contains all expected cause labels', () => {
      const enm = metrics.CONFIG_CAUSE_ENUM;
      expect(enm).toContain('none');
      expect(enm).toContain('validation');
      expect(enm).toContain('auth_failure');
      expect(enm).toContain('internal');
      expect(Object.isFrozen(enm)).toBe(true);
    });
  });

  describe('CONFIG_STATUS_CLASS_ENUM completeness', () => {
    it('contains all expected status class labels', () => {
      const enm = metrics.CONFIG_STATUS_CLASS_ENUM;
      expect(enm).toEqual(['2xx', '4xx', '5xx']);
      expect(Object.isFrozen(enm)).toBe(true);
    });
  });
});
