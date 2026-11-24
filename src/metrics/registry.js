'use strict';

/**
 * Dependency-free Prometheus metrics registry supporting Counter, Gauge,
 * and Histogram (with fixed buckets) and Prometheus text exposition format 0.0.4.
 */

const CONTENT_TYPE = 'text/plain; version=0.0.4; charset=utf-8';

const DEFAULT_HTTP_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

/**
 * Escapes a Prometheus label value per the text exposition specification.
 *
 * @param {unknown} value
 * @returns {string}
 */
function escapeLabelValue(value) {
  return String(value)
    .replace(/\\/g, '\\\\')
    .replace(/\n/g, '\\n')
    .replace(/"/g, '\\"');
}

/**
 * Formats a label map into `{k1="v1",k2="v2"}` or empty string.
 *
 * @param {Record<string, string | number>} [labels]
 * @returns {string}
 */
function formatLabels(labels) {
  if (!labels) {
    return '';
  }
  const keys = Object.keys(labels).sort();
  if (keys.length === 0) {
    return '';
  }
  const pairs = keys.map((k) => `${k}="${escapeLabelValue(labels[k])}"`);
  return `{${pairs.join(',')}}`;
}

/**
 * Builds a deterministic map key for a label set.
 *
 * @param {string[]} labelNames
 * @param {Record<string, string | number>} [labels]
 * @returns {{ key: string, normalized: Record<string, string> }}
 */
function normalizeLabels(labelNames, labels = {}) {
  const normalized = {};
  for (const name of labelNames) {
    normalized[name] = labels[name] !== undefined ? String(labels[name]) : '';
  }
  const key = formatLabels(normalized);
  return { key, normalized };
}

class Counter {
  /**
   * @param {{ name: string, help: string, labelNames?: string[] }} opts
   */
  constructor({ name, help, labelNames = [] }) {
    this.name = name;
    this.help = help;
    this.type = 'counter';
    this.labelNames = [...labelNames].sort();
    this.values = new Map();
  }

  /**
   * @param {Record<string, string | number> | number} [labelsOrValue]
   * @param {number} [value=1]
   */
  inc(labelsOrValue, value = 1) {
    let labels = {};
    let delta = value;
    if (typeof labelsOrValue === 'number') {
      delta = labelsOrValue;
    } else if (labelsOrValue && typeof labelsOrValue === 'object') {
      labels = labelsOrValue;
    }
    if (delta < 0) {
      throw new Error(`Counter ${this.name} cannot be decremented`);
    }
    const { key, normalized } = normalizeLabels(this.labelNames, labels);
    const current = this.values.get(key);
    this.values.set(key, {
      labels: normalized,
      value: (current ? current.value : 0) + delta,
    });
  }

  /**
   * @param {Record<string, string | number>} [labels]
   * @returns {number}
   */
  get(labels = {}) {
    const { key } = normalizeLabels(this.labelNames, labels);
    const entry = this.values.get(key);
    return entry ? entry.value : 0;
  }

  reset() {
    this.values.clear();
  }

  /**
   * @returns {string}
   */
  render() {
    const lines = [
      `# HELP ${this.name} ${this.help}`,
      `# TYPE ${this.name} counter`,
    ];
    if (this.values.size === 0 && this.labelNames.length === 0) {
      lines.push(`${this.name} 0`);
    } else {
      for (const [labelStr, entry] of this.values.entries()) {
        lines.push(`${this.name}${labelStr} ${entry.value}`);
      }
    }
    return lines.join('\n');
  }
}

class Gauge {
  /**
   * @param {{ name: string, help: string, labelNames?: string[] }} opts
   */
  constructor({ name, help, labelNames = [] }) {
    this.name = name;
    this.help = help;
    this.type = 'gauge';
    this.labelNames = [...labelNames].sort();
    this.values = new Map();
  }

  /**
   * @param {Record<string, string | number> | number} labelsOrValue
   * @param {number} [value]
   */
  set(labelsOrValue, value) {
    let labels = {};
    let nextValue = value;
    if (typeof labelsOrValue === 'number') {
      nextValue = labelsOrValue;
    } else if (labelsOrValue && typeof labelsOrValue === 'object') {
      labels = labelsOrValue;
    }
    const { key, normalized } = normalizeLabels(this.labelNames, labels);
    this.values.set(key, { labels: normalized, value: Number(nextValue) });
  }

  /**
   * @param {Record<string, string | number> | number} [labelsOrValue]
   * @param {number} [value=1]
   */
  inc(labelsOrValue, value = 1) {
    let labels = {};
    let delta = value;
    if (typeof labelsOrValue === 'number') {
      delta = labelsOrValue;
    } else if (labelsOrValue && typeof labelsOrValue === 'object') {
      labels = labelsOrValue;
    }
    const current = this.get(labels);
    this.set(labels, current + delta);
  }

  /**
   * @param {Record<string, string | number> | number} [labelsOrValue]
   * @param {number} [value=1]
   */
  dec(labelsOrValue, value = 1) {
    let labels = {};
    let delta = value;
    if (typeof labelsOrValue === 'number') {
      delta = labelsOrValue;
    } else if (labelsOrValue && typeof labelsOrValue === 'object') {
      labels = labelsOrValue;
    }
    const current = this.get(labels);
    this.set(labels, current - delta);
  }

  /**
   * @param {Record<string, string | number>} [labels]
   * @returns {number}
   */
  get(labels = {}) {
    const { key } = normalizeLabels(this.labelNames, labels);
    const entry = this.values.get(key);
    return entry ? entry.value : 0;
  }

  reset() {
    this.values.clear();
  }

  /**
   * @returns {string}
   */
  render() {
    const lines = [
      `# HELP ${this.name} ${this.help}`,
      `# TYPE ${this.name} gauge`,
    ];
    if (this.values.size === 0 && this.labelNames.length === 0) {
      lines.push(`${this.name} 0`);
    } else {
      for (const [labelStr, entry] of this.values.entries()) {
        lines.push(`${this.name}${labelStr} ${entry.value}`);
      }
    }
    return lines.join('\n');
  }
}

class Histogram {
  /**
   * @param {{ name: string, help: string, labelNames?: string[], buckets?: number[] }} opts
   */
  constructor({ name, help, labelNames = [], buckets = DEFAULT_HTTP_BUCKETS }) {
    this.name = name;
    this.help = help;
    this.type = 'histogram';
    this.labelNames = [...labelNames].sort();
    this.buckets = [...buckets].sort((a, b) => a - b);
    this.values = new Map();
  }

  /**
   * @param {Record<string, string | number> | number} labelsOrValue
   * @param {number} [value]
   */
  observe(labelsOrValue, value) {
    let labels = {};
    let observed = value;
    if (typeof labelsOrValue === 'number') {
      observed = labelsOrValue;
    } else if (labelsOrValue && typeof labelsOrValue === 'object') {
      labels = labelsOrValue;
    }
    const { key, normalized } = normalizeLabels(this.labelNames, labels);
    let entry = this.values.get(key);
    if (!entry) {
      entry = {
        labels: normalized,
        counts: new Array(this.buckets.length).fill(0),
        sum: 0,
        count: 0,
      };
      this.values.set(key, entry);
    }
    for (let i = 0; i < this.buckets.length; i++) {
      if (observed <= this.buckets[i]) {
        entry.counts[i] += 1;
      }
    }
    entry.sum += observed;
    entry.count += 1;
  }

  reset() {
    this.values.clear();
  }

  /**
   * @returns {string}
   */
  render() {
    const lines = [
      `# HELP ${this.name} ${this.help}`,
      `# TYPE ${this.name} histogram`,
    ];
    for (const entry of this.values.values()) {
      for (let i = 0; i < this.buckets.length; i++) {
        const bucketLabels = formatLabels({ ...entry.labels, le: this.buckets[i] });
        lines.push(`${this.name}_bucket${bucketLabels} ${entry.counts[i]}`);
      }
      const infLabels = formatLabels({ ...entry.labels, le: '+Inf' });
      lines.push(`${this.name}_bucket${infLabels} ${entry.count}`);
      const baseLabels = formatLabels(entry.labels);
      lines.push(`${this.name}_sum${baseLabels} ${entry.sum}`);
      lines.push(`${this.name}_count${baseLabels} ${entry.count}`);
    }
    return lines.join('\n');
  }
}

class Registry {
  constructor() {
    /** @type {Map<string, Counter | Gauge | Histogram>} */
    this.metrics = new Map();
  }

  /**
   * @template {Counter | Gauge | Histogram} T
   * @param {T} metric
   * @returns {T}
   */
  register(metric) {
    if (this.metrics.has(metric.name)) {
      throw new Error(`Metric "${metric.name}" is already registered`);
    }
    this.metrics.set(metric.name, metric);
    return metric;
  }

  reset() {
    for (const metric of this.metrics.values()) {
      metric.reset();
    }
  }

  /**
   * @returns {string}
   */
  render() {
    const blocks = [];
    for (const metric of this.metrics.values()) {
      blocks.push(metric.render());
    }
    return `${blocks.join('\n\n')}\n`;
  }
}

const registry = new Registry();

const httpRequestsTotal = registry.register(
  new Counter({
    name: 'http_requests_total',
    help: 'Total number of HTTP requests handled by the API.',
    labelNames: ['method', 'route', 'status'],
  }),
);

const httpRequestDurationSeconds = registry.register(
  new Histogram({
    name: 'http_request_duration_seconds',
    help: 'HTTP request duration in seconds.',
    labelNames: ['method', 'route', 'status'],
    buckets: DEFAULT_HTTP_BUCKETS,
  }),
);

const webhookDeliveriesTotal = registry.register(
  new Counter({
    name: 'webhook_deliveries_total',
    help: 'Total number of webhook delivery outcomes.',
    labelNames: ['status'],
  }),
);

const indexerIngestedTotal = registry.register(
  new Counter({
    name: 'indexer_ingested_total',
    help: 'Total number of escrow events ingested by the indexer.',
  }),
);

const indexerLastLedger = registry.register(
  new Gauge({
    name: 'indexer_last_ledger',
    help: 'Latest Stellar ledger observed by the escrow event indexer.',
  }),
);

const idempotencyReplaysTotal = registry.register(
  new Counter({
    name: 'idempotency_replays_total',
    help: 'Total number of idempotent responses replayed from cache.',
  }),
);

const bodySizeLimitRejectionsTotal = registry.register(
  new Counter({
    name: 'body_size_limit_rejections_total',
    help: 'Total number of requests rejected due to exceeding body size limits.',
    labelNames: ['type'],
  }),
);

const escrowIndexerEventsProcessedTotal = registry.register(
  new Counter({
    name: 'escrow_indexer_events_processed_total',
    help: 'Total number of escrow indexer events decoded and persisted.',
  }),
);

const escrowIndexerEventsSkippedTotal = registry.register(
  new Counter({
    name: 'escrow_indexer_events_skipped_total',
    help: 'Total number of escrow indexer events skipped due to decode failures.',
  }),
);

const escrowIndexerCycleFailuresTotal = registry.register(
  new Counter({
    name: 'escrow_indexer_cycle_failures_total',
    help: 'Total number of failed escrow indexer polling cycles.',
  }),
);

const escrowIndexerLastCursorAdvanceTimestampSeconds = registry.register(
  new Gauge({
    name: 'escrow_indexer_last_cursor_advance_timestamp_seconds',
    help: 'Unix timestamp (seconds) when the escrow indexer cursor last advanced.',
  }),
);

const escrowReconciliationMismatchesTotal = registry.register(
  new Counter({
    name: 'escrow_reconciliation_mismatches_total',
    help: 'Total number of escrow reconciliation mismatches detected.',
  }),
);

const escrowReconciliationDriftAlertsTotal = registry.register(
  new Counter({
    name: 'escrow_reconciliation_drift_alerts_total',
    help: 'Total number of escrow reconciliation runs exceeding drift threshold.',
  }),
);

module.exports = {
  CONTENT_TYPE,
  DEFAULT_HTTP_BUCKETS,
  Counter,
  Gauge,
  Histogram,
  Registry,
  registry,
  httpRequestsTotal,
  httpRequestDurationSeconds,
  webhookDeliveriesTotal,
  indexerIngestedTotal,
  indexerLastLedger,
  idempotencyReplaysTotal,
  bodySizeLimitRejectionsTotal,
  escrowIndexerEventsProcessedTotal,
  escrowIndexerEventsSkippedTotal,
  escrowIndexerCycleFailuresTotal,
  escrowIndexerLastCursorAdvanceTimestampSeconds,
  escrowReconciliationMismatchesTotal,
  escrowReconciliationDriftAlertsTotal,
};
