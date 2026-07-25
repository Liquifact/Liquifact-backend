# TODO - enhancement/reconciliation-14-mismatch-alerts

- [ ] Inspect current Sentry wiring and matcher for captureException
- [x] Implement structured mismatch alert helper in `src/jobs/reconcileEscrow.js`:
  - [x] Keep existing warn log and `escrowReconciliationMismatches.inc()` untouched
  - [x] Add Sentry capture (minimal, scrubbed fields only) behind Sentry enabled check
  - [x] Add env configurable mismatch alert threshold + channel

- [ ] Update `src/services/health.js` (`checkReconciliationHealth`) so `/ready` degrades only when `summary.mismatches >= RECONCILIATION_DRIFT_THRESHOLD`

- [ ] Update tests in `tests/reconcileEscrow.test.js`:
  - [ ] Cover mismatch alerts (log + Sentry capture)
  - [ ] Cover Sentry disabled
  - [ ] Cover threshold breach health degradation
  - [ ] Cover read failure health path
- [ ] Update documentation `docs/ops-reconcile.md` with env vars + behavior
- [ ] Run `npm test` and `npm run lint`
- [ ] Ensure ≥95% test coverage for impacted modules

