'use strict';

// tests/mocks/setup.js globally auto-mocks src/metrics with a tiny stub for
// every test file; this file exercises the real module directly (see
// tests/metrics.test.js for the same pattern and rationale).
jest.unmock('../src/metrics');

const metrics = require('../src/metrics');

describe('getMetricsText (extracted business logic, issue: split metrics handler)', () => {
  beforeEach(() => {
    metrics.resetMetricsForTests();
    metrics.registry.resetMetrics();
  });

  it('is directly callable without an Express req/res pair', async () => {
    const text = await metrics.getMetricsText();
    expect(typeof text).toBe('string');
  });

  it('returns Prometheus exposition text containing registered metric help lines', async () => {
    const text = await metrics.getMetricsText();
    expect(text).toMatch(/# HELP/);
    expect(text).toMatch(/# TYPE/);
  });

  it('reflects metric changes made between calls', async () => {
    metrics.metricsRequestsTotal.labels({ status_class: '2xx' }).inc();
    const text = await metrics.getMetricsText();
    expect(text).toMatch(/metrics_requests_total\{status_class="2xx"\} 1/);
  });
});

describe('metrics soak / repeat calls (issue: soak-test metrics)', () => {
  const ITERATIONS = 200;

  beforeEach(() => {
    metrics.resetMetricsForTests();
    metrics.registry.resetMetrics();
  });

  it('repeated recordMetricsEndpointOutcome calls produce stable, bounded-cardinality output with no growth beyond the fixed label set', async () => {
    for (let i = 0; i < ITERATIONS; i += 1) {
      metrics.recordMetricsEndpointOutcome({
        statusCode: i % 5 === 0 ? 500 : 200,
        durationSeconds: 0.001 * (i % 10),
        error: i % 5 === 0 ? new Error('boom') : null,
      });
    }

    const text = await metrics.getMetricsText();

    // Bounded cardinality: exactly one series per status_class value that
    // actually occurred (2xx, 5xx), not one per call. A leak would show up
    // as unbounded distinct label combinations or a growing series count.
    const requestsTotalLines = text
      .split('\n')
      .filter((line) => line.startsWith('metrics_requests_total{'));
    expect(requestsTotalLines.length).toBeLessThanOrEqual(2);

    expect(text).toMatch(/metrics_requests_total\{status_class="2xx"\} \d+/);
    expect(text).toMatch(/metrics_requests_total\{status_class="5xx"\} \d+/);

    // Exact counts: 1 in 5 iterations is a 5xx (statusCode 500 at i % 5 === 0).
    const expected5xx = Math.ceil(ITERATIONS / 5);
    const expected2xx = ITERATIONS - expected5xx;
    expect(text).toMatch(new RegExp(`metrics_requests_total\\{status_class="2xx"\\} ${expected2xx}\\b`));
    expect(text).toMatch(new RegExp(`metrics_requests_total\\{status_class="5xx"\\} ${expected5xx}\\b`));
  });

  it('repeated getMetricsText calls stay fast and never mutate the metrics_requests_total series', async () => {
    const extractRequestsTotalLine = (text) =>
      text.split('\n').find((line) => line.startsWith('metrics_requests_total{'));

    const before = extractRequestsTotalLine(await metrics.getMetricsText());

    const start = Date.now();
    for (let i = 0; i < ITERATIONS; i += 1) {
      // eslint-disable-next-line no-await-in-loop -- deliberate sequential soak, not parallel load
      await metrics.getMetricsText();
    }
    const elapsedMs = Date.now() - start;

    const after = extractRequestsTotalLine(await metrics.getMetricsText());

    // `getMetricsText` is a pure read; repeated calls with no intervening
    // recordMetricsEndpointOutcome() calls must never move this counter
    // (would indicate a leak/side-effect in the read path).
    expect(after).toBe(before);
    // Not a strict perf assertion — just a guard against catastrophic
    // per-call slowdown (e.g. an accidental O(n^2) accumulation).
    expect(elapsedMs).toBeLessThan(5000);
  });

  it('metricsAuth handles repeated unauthorized calls without leaking listeners or throwing', async () => {
    const req = {
      headers: {},
      socket: { remoteAddress: '203.0.113.5' },
      ip: '203.0.113.5',
    };

    expect(() => {
      for (let i = 0; i < ITERATIONS; i += 1) {
        const res = {
          statusCode: 200,
          body: undefined,
          status(code) { this.statusCode = code; return this; },
          json(payload) { this.body = payload; return this; },
        };
        metrics.metricsAuth(req, res, () => {});
      }
    }).not.toThrow();

    const text = await metrics.getMetricsText();
    // Still exactly one series for the 4xx class despite N repeated calls.
    const lines = text
      .split('\n')
      .filter((line) => line.startsWith('metrics_requests_total{'));
    expect(lines.length).toBeLessThanOrEqual(1);
    expect(text).toMatch(new RegExp(`metrics_requests_total\\{status_class="4xx"\\} ${ITERATIONS}\\b`));
  });
});
