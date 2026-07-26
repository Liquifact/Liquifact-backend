# KYC Webhooks API Changelog

Tracks notable, consumer-facing changes to the KYC webhooks API surface:

- `POST /api/kyc/webhook` — inbound webhook ingestion from the external KYC provider.
- `GET /api/kyc/webhooks` — cursor-paginated listing of ingested KYC records.

See also: [runbook-kyc-webhooks.md](./runbook-kyc-webhooks.md) for operational/failure-mode detail, [webhooks.md](./webhooks.md) for the signature-verification contract, and [configuration.md](./configuration.md) for the full environment-variable reference.

## Policy — keep this current

Any PR that changes either endpoint's request/response shape, status codes, headers, auth/tenant requirements, or signature scheme **must** add an entry here in the same PR, written from the perspective of a consumer integrating with the API (not internal implementation detail), linking the commit/PR that made the change.

---

## Known issues

### `GET /api/kyc/webhooks` is currently non-functional

The cursor-pagination change (`0c756431`, 2026-07-25, "feat(kyc-webhooks): add cursor pagination") references `responseHelper`, `db`, `decodeCursor`, `encodeCursor`, and `CursorError` in `src/routes/kyc.js`, but none of them are imported in that file — every request to this route throws a `ReferenceError` before it can respond. Separately, `'updated_at'` (the field the route sorts and paginates by) is not present in `ALLOWED_SORT_FIELDS` in `src/utils/cursorPagination.js`, so `encodeCursor`/`decodeCursor` would still reject it once the imports are fixed. There is no automated test coverage for this route today, which is why this shipped without being caught.

Do not treat this endpoint as available to consumers until a fix lands. This entry should be replaced with a normal dated entry (below) once it is.

---

## 2026-07-25 — Structured request validation on webhook ingestion

`50cc354f` (#852). `POST /api/kyc/webhook` now validates the parsed JSON body against a strict Zod schema (`src/schemas/kycWebhook.js`, `.strict()`) before processing: unknown fields are rejected, `smeId` must be 1–128 characters matching `^[A-Za-z0-9_-]+$`, `status` must be 1–50 characters, and `recordId` is capped at 255 characters. Previously, any payload with the right field names was accepted with no bounds. Consumers sending malformed or oversized payloads will now receive a `400` earlier and with a more specific error.

## 2026-07-24 — Metrics and structured logging on webhook ingestion

`aba066ba`. The webhook route now emits `kyc_webhook_request_duration_seconds`, `kyc_webhook_requests_total`, and `kyc_webhook_errors_total` (labelled by status class and failure cause) and logs structured success/reject events. No change to the request/response contract — flagged here because consumers running their own alerting on this integration can now scrape these directly.

## 2026-06-27 — Unmapped provider statuses are rejected, not silently normalized

`faa65a8c`. A webhook payload whose `status` value is not present in the provider-status map (`kycService.PROVIDER_STATUS_MAP`) is now rejected with `400 Unknown provider status: <value>` instead of being silently persisted as `unknown`. This is an intentional fail-closed change (issue #592): integrations that previously relied on unrecognized status strings being accepted and normalized will now get a `400`. See [runbook-kyc-webhooks.md § 3](./runbook-kyc-webhooks.md#3-webhook-is-rejected-with-400-unknown-provider-status).

## 2026-05-27 — Timestamped, replay-resistant webhook signatures

`20460278` (#238). The `X-Signature` header format changed to `t=<timestamp>,v1=<hmac>`, signing `HMAC-SHA256(secret, "<timestamp>.<rawBody>")` with a 5-minute tolerance window and verified with a constant-time comparison. This replaced an earlier signature scheme with no replay protection. Any provider or consumer generating this header must send the current `t=,v1=` format — see [webhooks.md](./webhooks.md) for the full receiver-side verification contract.

## 2026-05-28 — KYC gating enforced across all capital-movement routes

`173b703d`. KYC gating (blocking capital-movement actions for SMEs without an approved KYC status) was extended to routes that had previously bypassed the check. Does not change the webhook ingestion contract itself, but changes which downstream actions become available once a webhook is processed.

## 2026-04-25 — Initial KYC status model

`29822056`. Introduced the KYC status model and funding gate that the webhook ingestion endpoint (added shortly after) writes to. Starting point for this changelog's history.

---

Entries above are backfilled from `git log` against `src/routes/kyc.js`, `src/services/kycService.js`, and `src/services/webhooks.js`. Commit hashes are abbreviated; run `git log <hash>` in this repository for full detail.
