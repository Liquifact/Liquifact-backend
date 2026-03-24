#!/usr/bin/env node

const autocannon = require('autocannon');

const { loadLoadTestConfig, getLoadScenarios } = require('./config');
const { createLoadReport, writeLoadReport, renderMarkdownReport } = require('./reporter');

/**
 * Run the core endpoint load baseline suite and persist summary artifacts.
 *
 * @returns {Promise<void>}
 */
async function main() {
  const config = loadLoadTestConfig();
  const scenarios = getLoadScenarios(config);
  const endpointResults = [];

  for (const scenario of scenarios) {
    try {
      const result = await runScenario(config, scenario);
      endpointResults.push({ name: scenario.name, result, error: null });
    } catch (error) {
      endpointResults.push({ name: scenario.name, error });
    }
  }

  const report = createLoadReport(endpointResults);
  const artifacts = writeLoadReport(report, config.reportDir);

  process.stdout.write(renderMarkdownReport(report));
  process.stdout.write(`\nJSON report: ${artifacts.jsonPath}\n`);
  process.stdout.write(`Markdown report: ${artifacts.markdownPath}\n`);

  if (report.totals.failedCount > 0) {
    process.exitCode = 1;
  }
}

/**
 * Execute one autocannon scenario.
 *
 * @param {object} config Runtime configuration.
 * @param {{name: string, method: string, path: string, headers: object, body?: string}} scenario Scenario definition.
 * @returns {Promise<object>}
 */
function runScenario(config, scenario) {
  return autocannon({
    url: new URL(scenario.path, config.baseUrl).toString(),
    method: scenario.method,
    headers: scenario.headers,
    body: scenario.body,
    connections: config.connections,
    duration: config.durationSeconds,
    timeout: config.timeoutSeconds,
  });
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
