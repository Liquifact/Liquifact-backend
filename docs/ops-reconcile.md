# Escrow Reconciliation Operations

## Overview

Reconciliation compares off-chain invoice records with the on-chain escrow state returned by the Soroban `get_escrow` read. Previously it only ran when someone called `GET /api/reconciliation`, so drift could go unnoticed. A scheduled trigger now runs the same reconciliation, caches the report, and emits per-invoice webhook alerts when an invoice transitions from `in_sync` to `drift` or `error`.

## Implementation surface

| Concern | Location |
| --- | --- |
| Reconciliation engine | `src/routes/reconciliation.js` (`reconcileAll`) |
| Pure field comparison | `src/services/reconciliation.js` (`reconcileInvoice`) |
| Scheduled trigger | `src/routes/reconciliationTrigger.js` |
| Shared cron guard | `src/middleware/cron-secret.js` |
| Cached latest report / admin read | `src/routes/reconciliation.js` (`getLatestReport`, `setLatestReport`) |
| Webhook event registry | `src/webhooks/store.js` (`VALID_EVENTS`) |
| Webhook delivery | `src/webhooks/deliver.js` |

## Endpoints

### `POST /api/internal/reconciliation/run`

Runs a reconciliation pass and returns the full report plus:

- `alerts`: number of drift webhook events emitted in this run.
- `alertedInvoiceIds`: invoice IDs that produced an alert.

Authentication uses the same guard as `POST /api/internal/indexer/run`:

- `CRON_SECRET` unset or empty → `404` (endpoint is hidden).
- Missing, malformed, or incorrect `Authorization: Bearer <CRON_SECRET>` → `401`.
- Valid token → `200` with the report.
- Unexpected failure → `500`.

### `GET /api/reconciliation/latest`

Admin-only (`Authorization: Bearer <ADMIN_API_TOKEN>`). Returns:

```json
{
  "report": {
    "checkedAt": "2026-11-22T06:00:00.000Z",
    "summary": { "inSync": 1, "drift": 0, "missing": 0, "error": 0 },
    "results": []
  },
  "checkedAt": "2026-11-22T06:00:00.000Z",
  "ageMs": 3600000,
  "ageSeconds": 3600
}
```

`ageMs` is measured from `report.checkedAt`. When no scheduled run has completed, the endpoint returns `404`. `ADMIN_API_TOKEN` unset → `503`; wrong token → `401`.

`GET /api/reconciliation` still performs an on-demand reconciliation, but it does not overwrite the cached scheduled report.

## Transition detection and deduplication

Each result in a report has a `status`: `in_sync`, `drift`, `missing_on_chain`, or `error`.

An `invoice.reconciliation_drift` event is emitted only when:

1. The current result status is `drift` or `error`; and
2. The previous cached report recorded `in_sync` for that invoice (the first observed status is treated as `in_sync`).

If the invoice remains `drift` or `error`, or moves between `drift` and `error`, no second event is emitted. Returning to `in_sync` resets the transition so a later drift/error produces one new event.

The mismatch list from the current result is included in the event payload.

## Webhook event

`invoice.reconciliation_drift` is a valid event for `POST /api/webhooks` and can be subscribed to like other invoice events. The signed envelope follows the existing format:

```json
{
  "id": "evt_...",
  "type": "invoice.reconciliation_drift",
  "createdAt": "2026-11-22T06:00:01.000Z",
  "data": {
    "invoice": {
      "id": "INV_0001",
      "invoiceId": "INV_0001",
      "contractId": "CDQCKR2YU...",
      "previousStatus": "in_sync",
      "status": "drift",
      "mismatchCount": 1,
      "mismatches": [
        {
          "field": "fundedAmount",
          "offChain": "100000000",
          "onChain": "0",
          "severity": "critical"
        }
      ],
      "checkedAt": "2026-11-22T06:00:00.000Z",
      "reconciliation": {
        "invoiceId": "INV_0001",
        "contractId": "CDQCKR2YU...",
        "previousStatus": "in_sync",
        "status": "drift",
        "mismatches": [
          {
            "field": "fundedAmount",
            "offChain": "100000000",
            "onChain": "0",
            "severity": "critical"
          }
        ]
      }
    }
  }
}
```

For `error` results, `code` and `detail` describe the RPC failure and `mismatches` is empty.

## Scheduler example (documentation only)

The following `vercel.json` cron entry is shown as an example only; this repository's `vercel.json` is intentionally unchanged:

```json
{
  "crons": [
    {
      "path": "/api/internal/reconciliation/run",
      "schedule": "0 */6 * * *"
    }
  ]
}
```

The scheduler must send `POST` with `Authorization: Bearer $CRON_SECRET`. Vercel Cron adds the bearer token automatically; if your plan's cron runner only issues `GET`, use an equivalent POST-capable scheduler or a thin adapter in front of this route. Never commit the secret value.

## Environment variables

- `CRON_SECRET`: shared secret for internal trigger routes. Unset disables both `/api/internal/*` triggers (`404`).
- `ADMIN_API_TOKEN`: shared secret for admin reads, including `/api/reconciliation/latest`.

## Operational notes

- The cached report and webhook subscriptions/delivery log are in memory per process instance. A cold start or multi-instance deployment will not share cache state, so alerts can repeat after a new instance begins serving requests.
- Webhook delivery retries are also in memory and do not survive process restarts.
- Use `GET /api/reconciliation/latest` to confirm scheduled runs are still fresh.

## Verification

```bash
npx jest --runInBand tests/reconciliation-trigger.test.js
```

The test suite mocks `readEscrowOnChain` to exercise in-sync → drift transitions, error transitions, deduplication across runs, cron guard responses, admin access to the cached report, and registration of the new webhook event.
