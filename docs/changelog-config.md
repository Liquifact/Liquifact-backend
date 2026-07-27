# Config API Changelog

Tracks notable, consumer-facing changes to the admin runtime-config API surface:

- `POST /api/admin/config` — validate and accept a `{ section, config }` write for one supported section.
- `GET /api/admin/config/sections` — list the section names accepted by the POST endpoint.

Access is admin-only (JWT bearer or API key) and tenant-scoped. Configuration writes are validated against section-specific Zod schemas; only the `cors` section currently applies a live runtime side effect.

See also: [runbook-config.md](./runbook-config.md) for operations guidance, [config-examples.md](./config-examples.md) for curl/HTTP examples, [config-flow.md](./config-flow.md) for the request lifecycle, [webhooks.md](./webhooks.md) for the outbound `config.updated` event, and [configuration.md](./configuration.md) for the environment-variable reference.

## Policy — keep this current

Any PR that changes either endpoint's request/response shape, status codes, headers, auth/tenant requirements, supported sections, validation rules, rate limits, idempotency behaviour, compression, or related outbound webhook contract **must** add an entry here in the same PR, written from the perspective of a consumer integrating with the API (not internal implementation detail), linking the commit/PR that made the change.

---

## 2026-07-26 — Outbound `config.updated` webhook on successful writes

`6d5bb221`. After a successful `POST /api/admin/config`, the server emits a signed outbound `config.updated` webhook (HMAC `X-Signature: t=<timestamp>,v1=<sig>`) with retry/backoff and DLQ fallback. Payloads larger than 32 KB are truncated to a summary (`truncated: true`, `config._summary` / `config.keys`). The HTTP response contract of the admin endpoints is unchanged — consumers that register a webhook receiver will start seeing this event. See [webhooks.md](./webhooks.md#configuration-event-configupdated).

## 2026-07-26 — gzip compression for large config responses

`ab6c2cb8`. Both admin config routes compress responses above 500 bytes when the client sends `Accept-Encoding: gzip` (via the `compression` middleware). Clients that already negotiate gzip continue to work; clients that do not advertise gzip receive uncompressed bodies as before. No change to JSON shape or status codes.

## 2026-07-25 — Typed DTO boundary (no wire-format change)

`c302d5c8`. Request/response mapping for the admin config routes moved through a typed DTO layer (`src/dto/config.js`). The published JSON shapes (`section`, `config`, `message` on write; `sections` on list) are unchanged.

## 2026-07-25 — Service-layer extraction for apply side effects

`7ce24e23`. Runtime apply logic for validated writes moved to `src/services/configService.js` (`applyConfigSection`). Consumer contract unchanged: only the `cors` section mutates live process config (`CORS_ALLOWED_ORIGINS` / `CORS_MAX_AGE` + reload); other sections remain validate-and-echo.

## 2026-07-25 — Optional `Idempotency-Key` on config writes

`58fb09a5` (#849), building on `e9297d40` (#750). `POST /api/admin/config` accepts an optional `Idempotency-Key` header (8–128 URL-safe characters). When present, retries with the same key and body return the cached response; reusing a key with a different body returns `409` problem+json. Omitting the header leaves prior non-idempotent behaviour intact so existing clients are not broken.

## 2026-07-25 — `cors` section with live reload

`e9297d40` (#750). `GET /api/admin/config/sections` and the POST `section` enum gain `cors`. A write may include `origins` (1–20 root origin URLs) and/or `maxAge` (60–86400 seconds); at least one field is required. Unlike other sections, a successful `cors` write updates the running CORS allowlist / max-age without a process restart.

## 2026-07-25 — Per-client rate limiting

`d76701a8` (#754 / #800). Both admin config routes are rate-limited per client (API key, else socket IP) **before** admin auth, so failed auth attempts still consume quota. Defaults: 20 requests per 60 s window (`CONFIG_RATE_LIMIT_WINDOW_MS` / `CONFIG_RATE_LIMIT_MAX`). Exhaustion returns RFC 7807 `429` with `Retry-After` and a `retry_hint` field.

## 2026-07-24 — Initial admin config API with strict validation

`d30afd8e` (#692). Introduced `POST /api/admin/config` and `GET /api/admin/config/sections`, mounted under admin auth. Writes require `{ section, config }` where `section` is one of `webhook`, `reconciliation`, `kyc`, `retention`, `fraudThresholds`. Each section is validated with a `.strict()` Zod schema (unknown keys rejected; strings length-bounded; numerics range-checked; categoricals allowlisted). Validation failures return RFC 7807 `400` problem+json with a machine-readable `fieldErrors` map. Starting point for this changelog's history.

---

Entries above are backfilled from `git log` against `src/routes/adminConfig.js`, `src/schemas/config.js`, `src/services/configService.js`, `src/dto/config.js`, and `src/services/webhooks.js`. Commit hashes are abbreviated; run `git log <hash>` in this repository for full detail.
