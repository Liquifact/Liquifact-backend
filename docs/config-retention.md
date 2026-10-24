# Config Data-Retention

This document describes what the LiquiFact backend's configuration layer stores,
how long each piece of data is retained, when it is purged, and any PII
considerations that apply.

Cross-references to source code are given as `src/config/<file>`.

---

## Overview

The configuration layer (`src/config/`) is responsible for:

1. Parsing and validating environment variables at boot time (`index.js`).
2. Holding derived in-memory state (caches, registries) for the lifetime of the
   process.
3. Never writing config values to a database, log file, or external service.

No config value is persisted to a durable store. All state described below lives
in process memory and disappears when the process exits or restarts.

---

## What config stores and for how long

### 1. Validated config object — `src/config/index.js`

| Item stored | Type | Lifetime | PII? |
|---|---|---|---|
| All validated `process.env` values (ports, URLs, flags, secrets) | In-memory JS object | Process lifetime | Yes — see [PII section](#pii-handling) |

`validate()` is called once during boot and the result is held in the module-level
`config` variable. It is never flushed or refreshed automatically. To pick up a
new environment, the process must be restarted.

Secrets included in the validated object:

- `JWT_SECRET`
- `CURSOR_SECRET`
- `KYC_PROVIDER_API_KEY`
- `KYC_PROVIDER_SECRET`
- `API_KEYS` (raw key strings parsed from the registry)
- `SMTP_PASS`

None of these values are written to logs. `logRedactedSummary()` prints only the
**key names** and Zod validation messages on failure — never the values.

---

### 2. API key registry — `src/config/apiKeys.js`

| Item stored | Type | Lifetime | PII? |
|---|---|---|---|
| Parsed API key entries (`key`, `clientId`, `scopes`, `revoked`) | In-memory `Map` | Process lifetime | Yes — raw API key strings |

`loadApiKeyRegistry()` is called fresh on each request (no module-level cache), so
the registry always reflects the current `API_KEYS` environment variable. Raw key
strings exist in memory only for the duration of the timing-safe comparison and are
not retained in logs or request context.

Purge behaviour: entries are removed from memory when the process restarts. To
revoke a key without a restart, set `"revoked": true` and redeploy.

---

### 3. Escrow address cache — `src/config/escrowMap.js`

| Item stored | Type | Default TTL | Max entries | PII? |
|---|---|---|---|---|
| `invoiceId → escrowAddress` mappings | In-memory `Map` | `ESCROW_CACHE_TTL_SECONDS` (default 30 s) | `ESCROW_CACHE_MAX_ENTRIES` (default 500) | No |

Entries are written on first resolution of an invoice-to-address lookup and evicted
when:

- The TTL (in milliseconds, derived from `parseCacheConfig()`) has elapsed — lazy
  eviction on next read.
- The cache reaches `maxEntries` — oldest entry (LRU) is evicted to make room.
- `clearCache()` is called explicitly (e.g. when `ESCROW_ADDR_BY_INVOICE` changes
  between calls, detected by comparing the raw env-var string).

The underlying source of truth is `ESCROW_ADDR_BY_INVOICE` (environment variable).
No database rows are read or written.

**Retention window:** minimum 0 s (after TTL expiry) to maximum
`ESCROW_CACHE_TTL_SECONDS` seconds (default 30 s).

---

### 4. CORS origin-validation cache — `src/config/corsCache.js`

| Item stored | Type | Default TTL | Max entries | PII? |
|---|---|---|---|---|
| `origin string → allowed boolean` | Bounded LRU `Map` | `CORS_CACHE_TTL_SECONDS` (default 5 s, clamped 1–60 s) | `CORS_CACHE_MAX_ENTRIES` (default 256, clamped 16–4096) | Partial — see note |

The raw `Origin` header value is used as the cache key. Origin values take the form
`https://hostname` and generally do not contain personal data, but may contain a
hostname that could be considered PII in certain deployments. Keys are kept for at
most `CORS_CACHE_TTL_SECONDS` seconds.

Eviction triggers:

- TTL expiry — lazy eviction on next `get()` for that key.
- Capacity breach — LRU entry evicted when `map.size > maxEntries`.
- Explicit invalidation — `clear()` is called by `reloadCorsOrigins()` whenever the
  CORS allowlist is reloaded at runtime.

**Retention window:** 1–60 s (default 5 s). The cache is fully cleared on every
allowlist reload.

---

### 5. Verification threshold cache — `src/config/verificationThresholds.js`

| Item stored | Type | Lifetime | PII? |
|---|---|---|---|
| Global and per-tenant `fraudCeiling` / `manualReviewThreshold` numbers | In-memory `_cache` object | Process lifetime (memoized on first call) | No |

Parsed once from `INVOICE_FRAUD_CEILING`, `INVOICE_MANUAL_REVIEW_THRESHOLD`, and
`INVOICE_TENANT_THRESHOLDS`. The result is memoized until the process restarts or
`_resetThresholdCache()` is called (test-only helper).

No PII is involved. Tenant identifiers used as keys are opaque internal IDs, not
personal data.

---

### 6. Stellar / Soroban config — `src/config/stellar.js`

| Item stored | Type | Lifetime | PII? |
|---|---|---|---|
| `SOROBAN_RPC_URL`, `NETWORK_PASSPHRASE` | In-memory object | Process lifetime | No |

Read-through wrapper around the validated config object. No caching layer of its
own; values come directly from `src/config/index.js`.

---

## Purge behaviour summary

| Config component | Purge trigger | Mechanism |
|---|---|---|
| Validated config object | Process restart | Module-level variable garbage-collected |
| API key registry | Process restart (revocation via `revoked: true` + redeploy) | Re-parsed from env on every call |
| Escrow address cache | TTL expiry, capacity eviction, env-var change detection, `clearCache()` | In-memory `Map` |
| CORS origin cache | TTL expiry, capacity eviction, allowlist reload | In-memory `Map` with `clear()` |
| Verification threshold cache | Process restart, `_resetThresholdCache()` (tests only) | Module-level variable |
| Stellar config | Process restart | Read-through, no own cache |

---

## PII handling

### What PII the config layer holds

| Field | Classification | Notes |
|---|---|---|
| `JWT_SECRET` | Secret / credential | Never logged; validated as ≥ 32 chars |
| `CURSOR_SECRET` | Secret / credential | Never logged |
| `KYC_PROVIDER_API_KEY` | Credential | Never logged; half-configured check at boot |
| `KYC_PROVIDER_SECRET` | Credential | Never logged |
| `API_KEYS` (key strings) | Credential | Used only in timing-safe comparisons; never in logs |
| `SMTP_PASS` | Credential | Logged as `[REDACTED]` in all observability output |
| CORS `Origin` header values | Potentially PII | Cached for ≤ 60 s in the CORS cache; not persisted |

### What the config layer does NOT hold

- No user identifiers, email addresses, names, or IP addresses are stored in the
  config layer.
- No database rows, invoice records, or transaction data pass through config.
- The CORS cache holds raw origin strings (hostnames), which are not linked to
  individual users and are not persisted beyond the CORS cache TTL.

### Redaction guarantees

- `logRedactedSummary()` (`src/config/index.js`) never prints secret values — it
  prints only the failing key name and the Zod error message.
- `authenticateApiKey` middleware never logs the raw key value — only outcome
  labels (`unauthorized`, `success`, etc.).
- `SMTP_PASS` and similar transport credentials are explicitly excluded from all
  structured log output by the shared `redactValue` scrubber
  (`src/services/auditLogStore.js`).

---

## Configuration variables reference

The table below lists every environment variable consumed by `src/config/` modules
with their default value, retention impact, and secret status. For the full
consumer-and-type reference see [`docs/configuration.md`](./configuration.md).

| Variable | Default | Secret? | Retention note |
|---|---|---|---|
| `JWT_SECRET` | none (required) | ✅ | Held in validated config for process lifetime |
| `CURSOR_SECRET` | none (optional) | ✅ | Held in validated config for process lifetime |
| `KYC_PROVIDER_API_KEY` | none (optional) | ✅ | Held in validated config for process lifetime |
| `KYC_PROVIDER_SECRET` | none (optional) | ✅ | Held in validated config for process lifetime |
| `API_KEYS` | none (optional) | ✅ | Re-parsed from env on each request; not cached |
| `SMTP_PASS` | none (optional) | ✅ | Held in validated config for process lifetime; never logged |
| `ESCROW_CACHE_TTL_SECONDS` | `30` | ❌ | Controls escrow address cache TTL |
| `ESCROW_CACHE_MAX_ENTRIES` | `500` | ❌ | Controls escrow address cache capacity |
| `ESCROW_ADDR_BY_INVOICE` | none (optional) | ❌ | Source for escrow address mappings; cache cleared on change |
| `CORS_CACHE_TTL_SECONDS` | `5` | ❌ | Controls CORS origin cache TTL (1–60 s) |
| `CORS_CACHE_MAX_ENTRIES` | `256` | ❌ | Controls CORS origin cache capacity (16–4096) |
| `INVOICE_FRAUD_CEILING` | `10000000` | ❌ | Memoized for process lifetime |
| `INVOICE_MANUAL_REVIEW_THRESHOLD` | `1000000` | ❌ | Memoized for process lifetime |
| `INVOICE_TENANT_THRESHOLDS` | none (optional) | ❌ | Memoized for process lifetime |
| `SOROBAN_RPC_URL` | `https://soroban-testnet.stellar.org` | ❌ | Held in validated config for process lifetime |
| `NETWORK_PASSPHRASE` | `Test SDF Network ; September 2015` | ❌ | Held in validated config for process lifetime |

---

## Security notes

1. **No config value is persisted** — all data is in-memory and disappears on
   process exit. There is no config database, config file, or audit trail for
   config reads.
2. **Secrets are never logged** — `logRedactedSummary()` and all middleware ensure
   secret values are never written to stdout/stderr or shipped to Sentry.
3. **API key registry is parse-on-demand** — `loadApiKeyRegistry()` rebuilds the
   registry from `process.env.API_KEYS` on every call. Revoking a key by setting
   `"revoked": true` and redeploying is effective immediately with no cache to
   flush.
4. **CORS cache is invalidated on allowlist reload** — `reloadCorsOrigins()`
   calls `invalidateCorsCache()` which calls `clear()` on the singleton cache,
   ensuring stale origin decisions are not served after a config change.
5. **Escrow cache detects env-var changes** — `parseEscrowMappingConfig()`
   compares the current raw value of `ESCROW_ADDR_BY_INVOICE` against the
   previously seen value and calls `clearCache()` if they differ, preventing
   stale address mappings from surviving a runtime reconfiguration.
6. **Prototype-pollution prevention** — tenant threshold overrides are stored in
   a `Map` (not a plain object), making them immune to `__proto__`/`constructor`
   injection attacks.

---

## See also

- [`docs/configuration.md`](./configuration.md) — full typed variable reference
- [`docs/config-flow.md`](./config-flow.md) — boot-time validation flow
- [`docs/config-examples.md`](./config-examples.md) — annotated example `.env` snippets
- [`docs/runbook-config.md`](./runbook-config.md) — operational runbook for config changes
- [`src/config/index.js`](../src/config/index.js) — Zod schema and `validate()` implementation
- [`src/config/corsCache.js`](../src/config/corsCache.js) — CORS cache implementation
- [`src/config/escrowMap.js`](../src/config/escrowMap.js) — escrow address mapping and cache
- [`src/config/verificationThresholds.js`](../src/config/verificationThresholds.js) — fraud/review threshold resolution
- [`src/config/apiKeys.js`](../src/config/apiKeys.js) — API key registry
