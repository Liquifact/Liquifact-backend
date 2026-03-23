const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createLoadReport,
  renderMarkdownReport,
  writeLoadReport,
  roundMetric,
  readPercentile,
} = require('./reporter');

test('createLoadReport summarizes successful and failed endpoints', () => {
  const report = createLoadReport([
    {
      name: 'health',
      result: {
        requests: { total: 100, average: 55.4321 },
        latency: { average: 12.345, p50: 11, p97_5: 20.4, p99: 25.7 },
        errors: 0,
        non2xx: 0,
        timeouts: 0,
      },
    },
    {
      name: 'escrow',
      error: new Error('Connection reset'),
    },
  ]);

  assert.equal(report.endpoints[0].throughputRps, 55.43);
  assert.equal(report.endpoints[0].latencyP95Ms, 20.4);
  assert.equal(report.endpoints[1].ok, false);
  assert.equal(report.totals.okCount, 1);
  assert.equal(report.totals.failedCount, 1);
});

test('renderMarkdownReport includes tabular metrics and failures', () => {
  const markdown = renderMarkdownReport({
    generatedAt: '2026-03-23T10:00:00.000Z',
    totals: { okCount: 1, failedCount: 1 },
    endpoints: [
      {
        name: 'health',
        ok: true,
        requests: 100,
        throughputRps: 50,
        latencyAvgMs: 10,
        latencyP50Ms: 9,
        latencyP95Ms: 15,
        latencyP99Ms: 20,
        errorCount: 0,
        non2xxCount: 0,
        timeoutCount: 0,
      },
      {
        name: 'invoices-list',
        ok: false,
        error: 'Unauthorized',
      },
    ],
  });

  assert.match(markdown, /# Load Baseline Report/);
  assert.match(markdown, /\| health \| ok \| 100 \| 50 \|/);
  assert.match(markdown, /Error for `invoices-list`: Unauthorized/);
});

test('writeLoadReport persists JSON and Markdown artifacts', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'liquifact-load-'));
  const report = {
    generatedAt: '2026-03-23T10:00:00.000Z',
    totals: { okCount: 1, failedCount: 0 },
    endpoints: [],
  };

  const artifacts = writeLoadReport(report, tmpDir);

  assert.equal(fs.existsSync(artifacts.jsonPath), true);
  assert.equal(fs.existsSync(artifacts.markdownPath), true);
  assert.match(fs.readFileSync(artifacts.jsonPath, 'utf8'), /2026-03-23T10:00:00.000Z/);
});

test('roundMetric rounds to two decimals', () => {
  assert.equal(roundMetric(10.126), 10.13);
  assert.equal(roundMetric(10.121), 10.12);
  assert.equal(roundMetric(null), null);
});

test('readPercentile falls back to the next available latency percentile', () => {
  assert.equal(readPercentile({ p97_5: 17 }, ['p95', 'p97_5']), 17);
  assert.equal(readPercentile({ p99: 9 }, ['p95', 'p99']), 9);
  assert.equal(readPercentile({}, ['p95']), null);
});
