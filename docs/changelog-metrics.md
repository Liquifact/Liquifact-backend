# Metrics API Changelog

This document tracks all notable changes to the metrics API endpoints, data schemas, structures, and exposed parameters for the Liquifact Backend application.

> **⚠️ Contribution Policy:** 
> Any Pull Request (PR) that alters, introduces, deprecates, or removes any metrics API endpoint or data payload MUST append a corresponding entry to this file before it can be merged.

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
