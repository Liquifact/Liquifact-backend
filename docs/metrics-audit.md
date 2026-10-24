# Metrics Mutation Audit Log (issue #872)

## Overview

Prometheus metrics in `src/metrics.js` are mutated constantly via `.inc`,
`.set`, and `.observe` calls and via the periodic `refreshMetrics()` pass.
Without an audit trail, a sudden jump in a counter or gauge leaves no
record of _who_ or _what_ caused the change — incident review becomes a
guessing game.

This change introduces an in-memory, bounded mutation audit log that:

1. Records every counter/gauge/histogram mutation through a thin wrapper
   installed in `src/metrics.js` (see `wrapMetricMutations`).
2. Records an explicit `DELETE` entry whenever `resetMetricsForTests()`
   clears the registry gauges.
3. Records an `UPDATE` entry with `source="refreshMetrics"` whenever the
   periodic refresh mutates the three job-queue gauges.
4. Exposes the captured entries through the authenticated HTTP endpoint
   `GET /api/admin/metrics/audit`.

The endpoint and module are documented below.

---

## Bounded, in-memory ring buffer

The audit log lives in `src/metricsAudit.js` as a FIFO ring buffer
capped by `METRICS_AUDIT_MAX_ENTRIES` (default: 1000, max: 100 000).
When the buffer is full, the oldest entry is evicted atomically before
the new entry is appended.  This prevents unbounded memory growth while
still keeping the most recent mutations visible during incident review.

```js
// src/metricsAudit.js — public surface
metricsAudit.recordMetricMutation({ metricName, metricType, labels, before, after, source })
metricsAudit.recordMetricDelete({ metricName, metricType, labels, before, after, source })
metricsAudit.getMetricAuditLog({ metricName, action, actorId, limit, offset })
metricsAudit.setActorContext({ actorType, actorId })
metricsAudit.withActorContext(context, fn)
metricsAudit.clearMetricAuditLog()  // test-only, refuses in production
```

The buffer is `Object.freeze`-d on insertion so callers cannot accidentally
mutate entries in place.

---

## Action lifecycle

Every audit entry carries one of three actions:

| Action  | When emitted                                                       |
|---------|--------------------------------------------------------------------|
| `CREATE` | First write for a `(metricName, labels)` pair (before = null)     |
| `UPDATE` | Subsequent writes against a known `(metricName, labels)` pair    |
| `DELETE` | Explicit reset/clear (before populated, after = 0)               |

The classification is automatic — callers do not need to compute it.

---

## Redaction

Label values are passed through `redactValue()` from
`src/services/auditLogStore.js` before they are stored in the buffer.
Sensitive key patterns are redacted recursively:

- `password`
- `secret`
- `token`
- `api[-_]?key`
- `authorization`
- `private[-_]?key`
- `seed`
- `mnemonic`

Any value under a matching key (at any depth) is replaced with the
sentinel `***REDACTED***`.  This matches the redaction behaviour of the
durable `audit_log_events` table to keep incident responders from
having to mentally switch between two redaction conventions.

---

## Read endpoint

### `GET /api/admin/metrics/audit`

Authentication: admin JWT or admin API key (via `adminStack`).
Tenant extraction is enforced but the buffer is a system-level view and
is **not** filtered by tenant.

#### Query parameters

| Parameter   | Type   | Default | Notes                                  |
|-------------|--------|---------|----------------------------------------|
| `metricName`| string | none    | Restrict to a Prometheus metric name   |
| `action`    | enum   | none    | `CREATE` \| `UPDATE` \| `DELETE`       |
| `actorId`   | string | none    | Restrict by actor identifier           |
| `limit`     | int    | 100     | Page size (clamped to ≤ 1000 per call) |
| `offset`    | int    | 0       | Records to skip                        |

#### Response

```json
{
  "data": [
    {
      "id": "metric-audit-1700000000000-7",
      "timestamp": "2026-06-30T12:00:00.000Z",
      "actor": { "actorType": "system", "actorId": "refreshMetrics" },
      "action": "UPDATE",
      "metricName": "liquifact_job_queue_depth",
      "metricType": "gauge",
      "labels": {},
      "before": 3,
      "after": 5,
      "source": "set"
    }
  ],
  "meta": { "total": 1, "limit": 100, "offset": 0, "returned": 1 },
  "filters": { "metricName": null, "action": null, "actorId": null }
}
```

Validation errors return a 400 RFC 7807 envelope with a `fieldErrors`
map so callers can map failures to specific query parameters.

---

## Configuration

| Env var                      | Default | Notes                                     |
|------------------------------|---------|-------------------------------------------|
| `METRICS_AUDIT_MAX_ENTRIES`  | 1000    | Hard ceiling at 100 000; non-integer falls back to 1000 |

Set this conservatively in production — high-volume counters can churn
the buffer in seconds if the cap is too small, losing historical context
during incidents.

---

## Why an in-memory buffer (and not the durable `audit_log_events` table)?

Metrics like `escrow_indexer_events_processed_total` can be `.inc`'d
hundreds of times per second under load.  Routing every increment through
the durable `audit_log_events` table would:

- Saturate PostgreSQL write IOPS,
- Add 1–10 ms of latency to the hot path,
- Bloat the table past the retainable size guidance.

FIFO eviction solves the "incident review" requirement without those
costs.  When durable durability is desired for specific metrics, callers
can additionally emit an event into the durable audit log via the
existing `auditLog` service.

---

## Test coverage

- `tests/metricsAudit.test.js` — ring buffer, redaction, FIFO eviction,
  validation, actor context, pagination, production guard.
- `tests/metricsAudit.integration.test.js` — HTTP auth, query validation,
  filters, pagination, redacted payloads in the response body.
