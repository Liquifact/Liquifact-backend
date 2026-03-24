const fs = require('fs');
const path = require('path');

/**
 * Convert raw autocannon endpoint results into a compact serializable summary.
 *
 * @param {{name: string, result?: object, error?: Error|null}[]} endpointResults Raw endpoint results.
 * @returns {{generatedAt: string, endpoints: object[], totals: object}}
 */
function createLoadReport(endpointResults) {
  const endpoints = endpointResults.map((entry) => {
    if (entry.error) {
      return {
        name: entry.name,
        ok: false,
        error: entry.error.message,
      };
    }

    return {
      name: entry.name,
      ok: true,
      requests: entry.result.requests.total,
      throughputRps: roundMetric(entry.result.requests.average),
      latencyAvgMs: roundMetric(entry.result.latency.average),
      latencyP50Ms: roundMetric(readPercentile(entry.result.latency, ['p50'])),
      latencyP95Ms: roundMetric(readPercentile(entry.result.latency, ['p95', 'p97_5', 'p90'])),
      latencyP99Ms: roundMetric(readPercentile(entry.result.latency, ['p99', 'p99_9'])),
      errorCount: entry.result.errors,
      non2xxCount: entry.result.non2xx,
      timeoutCount: entry.result.timeouts,
    };
  });

  return {
    generatedAt: new Date().toISOString(),
    endpoints,
    totals: {
      okCount: endpoints.filter((entry) => entry.ok).length,
      failedCount: endpoints.filter((entry) => !entry.ok).length,
    },
  };
}

/**
 * Render a markdown summary for human review.
 *
 * @param {{generatedAt: string, endpoints: object[], totals: object}} report Load report.
 * @returns {string}
 */
function renderMarkdownReport(report) {
  const lines = [
    '# Load Baseline Report',
    '',
    `Generated at: ${report.generatedAt}`,
    '',
    '| Endpoint | Status | Requests | Avg RPS | Avg Latency (ms) | P50 (ms) | P95 (ms) | P99 (ms) | Errors | Non-2xx | Timeouts |',
    '| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
  ];

  for (const endpoint of report.endpoints) {
    if (!endpoint.ok) {
      lines.push(
        `| ${endpoint.name} | failed | - | - | - | - | - | - | - | - | - |`,
      );
      lines.push('');
      lines.push(`Error for \`${endpoint.name}\`: ${endpoint.error}`);
      lines.push('');
      continue;
    }

    lines.push(
      `| ${endpoint.name} | ok | ${endpoint.requests} | ${endpoint.throughputRps} | ${endpoint.latencyAvgMs} | ${endpoint.latencyP50Ms} | ${endpoint.latencyP95Ms} | ${endpoint.latencyP99Ms} | ${endpoint.errorCount} | ${endpoint.non2xxCount} | ${endpoint.timeoutCount} |`,
    );
  }

  lines.push('');
  lines.push(`Successful endpoints: ${report.totals.okCount}`);
  lines.push(`Failed endpoints: ${report.totals.failedCount}`);

  return `${lines.join('\n')}\n`;
}

/**
 * Persist both JSON and Markdown report artifacts.
 *
 * @param {{generatedAt: string, endpoints: object[], totals: object}} report Load report.
 * @param {string} reportDir Destination directory.
 * @returns {{jsonPath: string, markdownPath: string}}
 */
function writeLoadReport(report, reportDir) {
  fs.mkdirSync(reportDir, { recursive: true });

  const timestamp = report.generatedAt.replace(/[:.]/g, '-');
  const jsonPath = path.join(reportDir, `baseline-${timestamp}.json`);
  const markdownPath = path.join(reportDir, `baseline-${timestamp}.md`);

  fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2));
  fs.writeFileSync(markdownPath, renderMarkdownReport(report));

  return {
    jsonPath,
    markdownPath,
  };
}

/**
 * Round a numeric metric to two decimal places.
 *
 * @param {number} value Metric value.
 * @returns {number}
 */
function roundMetric(value) {
  if (value == null || Number.isNaN(value)) {
    return null;
  }

  return Math.round(value * 100) / 100;
}

/**
 * Read the first available percentile value from an autocannon latency object.
 *
 * @param {Record<string, number>} latencyMetrics Autocannon latency metrics.
 * @param {string[]} percentileKeys Ordered percentile keys to try.
 * @returns {number|null}
 */
function readPercentile(latencyMetrics, percentileKeys) {
  for (const key of percentileKeys) {
    if (typeof latencyMetrics[key] === 'number') {
      return latencyMetrics[key];
    }
  }

  return null;
}

module.exports = {
  createLoadReport,
  renderMarkdownReport,
  writeLoadReport,
  roundMetric,
  readPercentile,
};
