# Metrics API Changelog

This document tracks all notable changes to the metrics API endpoints, data schemas, structures, and exposed parameters for the Liquifact Backend application.

> **⚠️ Contribution Policy:** 
> Any Pull Request (PR) that alters, introduces, deprecates, or removes any metrics API endpoint or data payload MUST append a corresponding entry to this file before it can be merged.

## - SME Metrics Request Input Validation

### Added
- Machine-readable error codes on all SME metrics validation failures. Failure
  responses now carry a top-level `code` of `METRICS_VALIDATION_ERROR` plus a
  `fieldCodes` map that mirrors `fieldErrors` but holds stable codes drawn from
  the new `METRICS_VALIDATION_CODES` taxonomy (`FIELD_REQUIRED`,
  `FIELD_TYPE_INVALID`, `FIELD_TOO_SHORT`, `FIELD_TOO_LONG`,
  `VALUE_BELOW_MINIMUM`, `VALUE_ABOVE_MAXIMUM`, `VALUE_NOT_INTEGER`,
  `ARRAY_TOO_SMALL`, `ARRAY_TOO_LARGE`, `UNKNOWN_FIELD`,
  `FIELD_FORMAT_INVALID`, `FIELD_INVALID`).
- Length bound on the `cursor` query param for `GET /api/sme/metrics`
  (max 512 characters); previously unbounded.
- New module `src/constants/metricsValidationCodes.js` defining the taxonomy and
  the Zod-issue-to-code mapping.
- See [metrics-validation.md](./metrics-validation.md) for the full contract.

### Changed
- **Breaking (error responses only):** `limit` on `GET /api/sme/metrics` is now
  validated instead of silently repaired. Previously `limit=999` was clamped to
  100, `limit=abc` was ignored (falling back to the default page size), and
  `limit=0`/`limit=-5` were clamped into range — all returning `200`. These now
  return a structured `400`. Successful requests with an in-range integer
  `limit` (1–100) are unaffected, as are requests that omit `limit`.
  This aligns the SME metrics route with the pre-existing behaviour of the
  indexer query schema.
- `limit` must now be a bare integer: `20abc`, `1e5`, `10.5`, `0x10` and
  whitespace-only values are rejected rather than partially parsed.

### Unchanged
- `type`, `title`, `status`, `detail` and `fieldErrors` keep their previous
  values and shapes on `POST /api/sme/metrics/bulk`, so existing clients that
  read only those fields are unaffected.
- Unknown query parameters continue to be stripped (not rejected).
- The 25-operation bulk cap and the 128-character `tenantId`/`userId` bounds are
  unchanged in value; they are now reported with explicit codes.

## - Indexer Metrics & Regression Testing

### Added
- Exported Prometheus metrics for indexer endpoints and caching: `indexer_request_duration_seconds`, `indexer_requests_total`, `indexer_request_errors_total`, `indexer_cache_hits_total`, `indexer_cache_misses_total`, `indexer_cache_evictions_total`, and `escrow_indexer_cycle_failures_total`.
- Added metric label normalizers `normalizeIndexerStatusClass` and `normalizeIndexerCause`.

## - Backfill & Initialization

### Added
- Added standard Prometheus metric collections for HTTP response latency and endpoint hits.
- Implemented system health telemetry mapping via `/api/v1/metrics` payload.
- Added structured tracking schemas to log backend operational efficiency.

### Changed
- Standardized error rate response parameters to deliver clear HTTP error codes inside payload objects.
