# LiquiFact Config Module Reference

> **Source:** `src/config/`
> **Last updated:** 2026-07-24

The `src/config/` directory contains the internal configuration layer for the LiquiFact backend. It is **not** an HTTP API — there are no REST endpoints in this module. Instead, it provides typed, validated configuration objects that the rest of the application imports at boot time and during request handling.

This document covers each module's public interface: the environment variables it reads, the values it exports, the error conditions it raises, and a concrete usage example.

---

## Table of Contents

1. [config/index.js — Core Environment Validation](#1-configindexjs--core-environment-validation)
2. [config/cors.js — CORS Policy](#2-configcorsjs--cors-policy)
3. [config/stellar.js — Stellar Network Config](#3-configstellarjs--stellar-network-config)
4. [config/cache.js — Escrow Cache TTL](#4-configcachejs--escrow-cache-ttl)
5. [config/escrowMap.js — Invoice-to-Escrow Address Resolution](#5-configescrowmapjs--invoice-to-escrow-address-resolution)
6. [config/apiKeys.js — API Key Registry](#6-configapikeysjs--api-key-registry)
7. [config/escrowVersions.js — Wasm Schema Version Registry](#7-configescrowversionsjs--wasm-schema-version-registry)
8. [Environment Variable Quick Reference](#8-environment-variable-quick-reference)
9. [Error Reference](#9-error-reference)

---

## 1. config/index.js — Core Environment Validation

**Source:** [`src/config/index.js`](../src/config/index.js)

Provides Zod-based validation of all environment variables. Called once during application bootstrap via `validate()`. Subsequent modules call `get()` to retrieve the validated config object. Throws a hard error if any required field is absent or fails its constraint — the server will not start in a bad state.

### Exports

| Export | Type | Description |
|---|---|---|
| `validate()` | `() => Config` | Parses `process.env` against `ConfigSchema`. Must be called before `get()`. Throws `Error` on failure. |
| `get()` | `() => Config` | Returns the previously validated config. Throws if `validate()` has not been called. |
| `ConfigSchema` | `z.ZodObject` | The raw Zod schema. Useful for unit-testing config shapes in isolation. |
| `securityHeaders` | `Object` | Helmet-compatible security header config (CSP, HSTS, referrer policy). Also includes `docsContentSecurityPolicy` for the Swagger UI route. |

### Config schema

| Field | Type | Default | Constraint | Description |
|---|---|---|---|---|
| `NODE_ENV` | `string` | `development` | `development \| production \| test` | Runtime environment. |
| `PORT` | `number` | `3001` | `1–65535` | HTTP listen port. |
| `JWT_SECRET` | `string` | — | min 32 chars | Secret used to sign/verify JWTs. **No default — must be supplied.** |
| `CORS_ALLOWED_ORIGINS` | `string` | — | optional | Comma-separated allowed origins. See `config/cors.js`. |
| `SOROBAN_RPC_URL` | `string` (URL) | `https://soroban-testnet.stellar.org` | valid URL | Soroban RPC endpoint. |
| `NETWORK_PASSPHRASE` | `string` | `Test SDF Network ; September 2015` | — | Stellar network passphrase. |
| `SOROBAN_BATCH_CONCURRENCY` | `number` | `5` | `1–50` | Max concurrent on-chain reads in batch operations. |
| `SOROBAN_BATCH_TIMEOUT_MS` | `number` | `5000` | `100–30000` | Per-request timeout for on-chain reads (ms). |
| `ESCROW_INDEXER_ENABLED` | `string` | `false` | `true \| false` | Feature flag for the background escrow indexer job. |
| `ESCROW_INDEXER_STALE_THRESHOLD_SECONDS` | `number` | `300` | min 1 | Seconds before indexer cursor is considered stale for `/ready`. |
| `KYC_PROVIDER_URL` | `string` (URL) | — | optional | KYC provider base URL. Must be paired with `KYC_PROVIDER_API_KEY`. |
| `KYC_PROVIDER_API_KEY` | `string` | — | optional, min 1 | KYC provider API key. Must be paired with `KYC_PROVIDER_URL`. |
| `KYC_PROVIDER_SECRET` | `string` | — | optional, min 1 | KYC provider HMAC signing secret for webhook verification. |

**Cross-field constraint:** In non-`test` environments, `KYC_PROVIDER_URL` and `KYC_PROVIDER_API_KEY` must both be set or both be absent. Providing only one causes `validate()` to throw.

### `securityHeaders` shape

```js
{
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc:  ["'self'"],
      styleSrc:   ["'self'"],
      imgSrc:     ["'self'", "data:"],
      connectSrc: ["'self'"],
      fontSrc:    ["'self'"],
      objectSrc:  ["'none'"],
      mediaSrc:   ["'self'"],
      frameSrc:   ["'none'"],
      baseUri:    ["'self'"],
      formAction: ["'self'"]
    }
  },
  referrerPolicy: { policy: 'no-referrer' },
  hsts: { maxAge: 31536000, includeSubDomains: true, preload: true },
  // Relaxed CSP used for GET /docs (Swagger UI)
  docsContentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc:  ["'self'", "'unsafe-inline'"],
      styleSrc:   ["'self'", "'unsafe-inline'"],
      // ... (same remaining keys as above)
    }
  }
}
```

### Errors

| Condition | Error message pattern |
|---|---|
| `JWT_SECRET` shorter than 32 chars | `Invalid configuration: … string …` |
| `PORT` is not a number | `Invalid configuration: … number …` |
| `NODE_ENV` not in enum | `Invalid configuration: … Enum …` |
| Only one of the KYC pair provided (non-test) | `Invalid configuration: KYC_PROVIDER_URL and KYC_PROVIDER_API_KEY must both be set or both be absent.` |
| `get()` called before `validate()` | `Config not validated. Call validate() first.` |

### Example

```js
// src/index.js (bootstrap)
const { validate } = require('./config');
validate(); // throws and exits if env is invalid

// In any module
const { get } = require('./config');
const { PORT, SOROBAN_RPC_URL } = get();
```

---

## 2. config/cors.js — CORS Policy

**Source:** [`src/config/cors.js`](../src/config/cors.js)

Builds and manages the CORS options object passed to the `cors` npm middleware. Supports live allowlist reloading without a server restart.

### Exports

| Export | Type | Description |
|---|---|---|
| `createCorsOptions(env?)` | `(env?) => CorsOptions` | Returns a `cors`-compatible options object. Pass a custom env map for isolated testing; omit to use the live module-level allowlist. |
| `reloadCorsOrigins()` | `() => void` | Re-reads `CORS_ORIGINS` / `CORS_ALLOWED_ORIGINS` from `process.env` and updates the in-memory allowlist. In-flight requests are unaffected. |
| `parseAllowedOrigins(raw)` | `(string?) => string[]` | Splits a comma-separated origin string into a deduplicated array. Returns `[]` for absent/blank input. |
| `getAllowedOriginsFromEnv(env?)` | `(env?) => string[]` | Resolves the effective allowlist from an env map (falls back to `DEV_DEFAULT_ORIGINS` in development). |
| `resolveAllowlist(env?)` | `(env?) => string[]` | Alias for `getAllowedOriginsFromEnv`. |
| `getDevelopmentFallbackOrigins()` | `() => string[]` | Returns the hard-coded dev-only origin list. |
| `parseMaxAge(raw)` | `(string?) => number` | Parses `CORS_MAX_AGE` to a positive integer; defaults to `600`. |
| `getMaxAge()` | `() => number` | Returns the current preflight `Access-Control-Max-Age` value. |
| `createCorsRejectionError(origin?)` | `(string?) => Error` | Creates a 403-tagged error for blocked origins. |
| `isCorsOriginRejectedError(err)` | `(unknown) => boolean` | Returns `true` when the error was produced by `createCorsRejectionError`. |
| `CORS_REJECTION_MESSAGE` | `string` | Fixed rejection message: `'CORS policy: origin is not allowed.'` |
| `DEV_DEFAULT_ORIGINS` | `string[]` | The hardcoded development fallback origins. |

### Environment variables

| Variable | Default | Description |
|---|---|---|
| `CORS_ALLOWED_ORIGINS` | — | Comma-separated list of exact allowed origins. Takes precedence over `CORS_ORIGINS`. |
| `CORS_ORIGINS` | — | Deprecated alias for `CORS_ALLOWED_ORIGINS`. |
| `CORS_MAX_AGE` | `600` | Preflight `Access-Control-Max-Age` in seconds. Must be a positive integer. |
| `NODE_ENV` | `development` | When `development` and no origin env var is set, uses `DEV_DEFAULT_ORIGINS`. |

### Development fallback origins (`DEV_DEFAULT_ORIGINS`)

```
http://localhost:3000
http://localhost:3001
http://localhost:5173
http://127.0.0.1:3000
http://127.0.0.1:5173
```

### CORS options object shape

```js
{
  origin: Function,      // exact-match callback; undefined origin always passes
  maxAge: number,        // from CORS_MAX_AGE, default 600
  optionsSuccessStatus: 204
}
```

### Origin resolution logic

```
Request has no Origin header  →  allowed (server-to-server, curl, Postman)
CORS_ALLOWED_ORIGINS set      →  exact match against the parsed list
CORS_ALLOWED_ORIGINS unset + NODE_ENV=development  →  DEV_DEFAULT_ORIGINS
CORS_ALLOWED_ORIGINS unset + any other environment →  all origins denied (empty allowlist)
```

### CORS rejection error shape

When an origin is blocked, the error handler in `app.js` returns:

```json
HTTP 403
{ "error": "CORS policy: origin is not allowed." }
```

The error carries:
- `.isCorsOriginRejected = true`
- `.isCorsOriginRejectedError = true`
- `.status = 403`

### Errors

| Condition | Behaviour |
|---|---|
| Origin on allowlist | `callback(null, true)` — allowed |
| Origin not on allowlist | `callback(Error)` with `.status = 403` |
| No Origin header | `callback(null, true)` — always allowed |
| Empty allowlist (non-dev, no env var) | All browser origins rejected |

### Example

```js
// app.js
const cors = require('cors');
const { createCorsOptions, reloadCorsOrigins } = require('./config/cors');

app.use(cors(createCorsOptions()));

// Reload allowlist at runtime (e.g. from an admin endpoint)
reloadCorsOrigins();
```

```bash
# .env — allow two origins
CORS_ALLOWED_ORIGINS=https://app.liquifact.io,https://admin.liquifact.io
CORS_MAX_AGE=3600
```

---

## 3. config/stellar.js — Stellar Network Config

**Source:** [`src/config/stellar.js`](../src/config/stellar.js)

Provides Stellar/Soroban network configuration and enforces strict network–RPC pairing at boot time. The `validateStellarConfig()` function is called from `src/index.js` before the HTTP server starts — a mismatch is a hard fail.

### Exports

| Export | Type | Description |
|---|---|---|
| `validateStellarConfig()` | `() => { network, rpcUrl, passphrase }` | Reads `STELLAR_NETWORK` and `SOROBAN_RPC_URL`, validates them as a matched pair, and returns the resolved config. Throws on any mismatch or missing value. |
| `getStellarConfig()` | `() => { rpcUrl, networkPassphrase }` | Returns the current Soroban RPC URL and network passphrase from the validated `config/index` store. Requires `validate()` to have been called first. |
| `getNetworkPassphrase(network)` | `(string) => string` | Returns the canonical passphrase for a known network name. Throws for unknown networks. |
| `getExpectedRpc(network)` | `(string) => string` | Returns the canonical RPC URL for a known network name. Throws for unknown networks. |
| `VALID_NETWORKS` | `string[]` | `['TESTNET', 'MAINNET', 'FUTURENET']` |
| `NETWORK_RPC_MAP` | `Record<string, string>` | Maps network name → canonical RPC URL. |
| `NETWORK_PASSPHRASE_MAP` | `Record<string, string>` | Maps network name → canonical network passphrase. |

### Environment variables

| Variable | Required | Description |
|---|---|---|
| `STELLAR_NETWORK` | Yes | One of `TESTNET`, `MAINNET`, `FUTURENET`. |
| `SOROBAN_RPC_URL` | Yes | Must match the canonical URL for the chosen network. Custom URLs are rejected. |

### Supported network combinations

| `STELLAR_NETWORK` | Required `SOROBAN_RPC_URL` | `NETWORK_PASSPHRASE_MAP` value |
|---|---|---|
| `TESTNET` | `https://soroban-testnet.stellar.org` | `Test SDF Network ; September 2015` |
| `MAINNET` | `https://soroban.stellar.org` | `Public Global Stellar Network ; September 2014` |
| `FUTURENET` | `https://rpc-futurenet.stellar.org` | `Test SDF Future Network ; October 2022` |

### `validateStellarConfig()` return value

```js
{
  network: "TESTNET",                            // string — the validated network name
  rpcUrl: "https://soroban-testnet.stellar.org", // string — the canonical RPC URL
  passphrase: "Test SDF Network ; September 2015" // string — the canonical passphrase
}
```

### `getStellarConfig()` return value

```js
{
  rpcUrl: "https://soroban-testnet.stellar.org",
  networkPassphrase: "Test SDF Network ; September 2015"
}
```

### Errors

| Condition | Error message |
|---|---|
| `STELLAR_NETWORK` missing | `STELLAR_NETWORK is required` |
| `SOROBAN_RPC_URL` missing | `SOROBAN_RPC_URL is required` |
| `STELLAR_NETWORK` not in `VALID_NETWORKS` | `Invalid STELLAR_NETWORK: <value>` |
| RPC URL does not match the expected URL for the network | `Mismatch: STELLAR_NETWORK=<N> requires SOROBAN_RPC_URL="<expected>", but got "<actual>". This combination would cause on-chain validation failures.` |
| `getNetworkPassphrase` / `getExpectedRpc` called with unknown network | `Unknown network: <value>` |
| `getStellarConfig()` called before `validate()` | `Config not validated. Call validate() first.` |

### Example

```js
// src/index.js (bootstrap)
const { validateStellarConfig } = require('./config/stellar');
validateStellarConfig(); // hard fail if misconfigured

// In a Soroban service
const { getStellarConfig } = require('./config/stellar');
const { rpcUrl, networkPassphrase } = getStellarConfig();
```

```bash
# .env
STELLAR_NETWORK=TESTNET
SOROBAN_RPC_URL=https://soroban-testnet.stellar.org
```

---

## 4. config/cache.js — Escrow Cache TTL

**Source:** [`src/config/cache.js`](../src/config/cache.js)

Parses the in-memory escrow cache TTL from environment variables and exposes a typed config object. Used by the escrow read service to decide how long to hold a cached escrow state before re-querying.

### Exports

| Export | Type | Description |
|---|---|---|
| `cacheConfig` | `{ escrowTtl: number }` | Module-level singleton parsed at load time. `escrowTtl` is in **milliseconds**. |
| `parseCacheConfig(env?)` | `(env?) => { escrowTtl: number }` | Parses the TTL from a given env map. Safe to call multiple times (used in tests). |

### Environment variables

| Variable | Default | Constraint | Description |
|---|---|---|---|
| `ESCROW_CACHE_TTL_SECONDS` | `30` | positive integer | In-memory escrow cache TTL in seconds. Converted to milliseconds on load. |

> **Note:** The Redis-backed escrow cache has separate variables: `REDIS_ESCROW_CACHE_ENABLED`, `REDIS_ESCROW_CACHE_TTL_SECONDS` (clamped to `5–300`), and `REDIS_ESCROW_LEDGER_GAP_THRESHOLD`. Those are consumed directly by the Redis cache layer, not by this module.

### `cacheConfig` shape

```js
{
  escrowTtl: 30000  // number — TTL in milliseconds (ESCROW_CACHE_TTL_SECONDS × 1000)
}
```

### Fallback behaviour

- If `ESCROW_CACHE_TTL_SECONDS` is absent → `escrowTtl = 30000` (30 s)
- If the value is not a finite positive integer (e.g. `"abc"`, `"-5"`, `"0"`) → `escrowTtl = 30000`

### Example

```js
const { cacheConfig } = require('./config/cache');
const ttl = cacheConfig.escrowTtl; // e.g. 30000 ms

// In tests, override without module cache issues:
const { parseCacheConfig } = require('./config/cache');
const cfg = parseCacheConfig({ ESCROW_CACHE_TTL_SECONDS: '60' });
// cfg.escrowTtl === 60000
```

```bash
# .env
ESCROW_CACHE_TTL_SECONDS=60
```

---

## 5. config/escrowMap.js — Invoice-to-Escrow Address Resolution

**Source:** [`src/config/escrowMap.js`](../src/config/escrowMap.js)

Resolves an invoice ID to its on-chain LiquifactEscrow Stellar contract address using a JSON configuration supplied through `ESCROW_ADDR_BY_INVOICE`. Used by `GET /api/escrow/:invoiceId` to find the contract before querying Soroban.

### Exports

| Export | Type | Description |
|---|---|---|
| `resolveEscrowAddress(invoiceId)` | `(string) => string` | Returns the Stellar contract address for the invoice. Throws `EscrowNotFoundError` if no active mapping exists; throws `EscrowMapConfigError` if the config JSON is malformed. |
| `EscrowNotFoundError` | `Error subclass` | Thrown when no active mapping exists for an invoice in the current environment. |
| `EscrowMapConfigError` | `Error subclass` | Thrown when `ESCROW_ADDR_BY_INVOICE` is present but structurally invalid. |
| `_resetCache()` | `() => void` | Clears the module-level in-memory parse cache. **Test-only.** |

### Environment variables

| Variable | Required | Description |
|---|---|---|
| `ESCROW_ADDR_BY_INVOICE` | No | JSON string mapping invoices to escrow contract addresses. See schema below. |
| `NODE_ENV` | No | Used to select the correct per-environment mapping. Defaults to `defaultEnvironment` from the config JSON. |

### `ESCROW_ADDR_BY_INVOICE` JSON schema

```jsonc
{
  "mappings": [
    {
      "invoiceId": "inv_123",          // string — invoice identifier
      "escrowAddress": "GABC...123",   // string — valid Stellar address (G... or C..., 56 chars)
      "environment": "development",    // string — matches NODE_ENV
      "isActive": true                 // boolean — false entries are skipped
    }
  ],
  "defaultEnvironment": "development", // string — fallback when NODE_ENV is unset
  "allowlistEnabled": true,            // boolean — reserved for future use
  "cacheEnabled": true,                // boolean — reserved for future use
  "cacheTtlSeconds": 300               // number  — reserved for future use
}
```

**Stellar address validation:** each `escrowAddress` must match `/^[CG][A-Z2-7]{55}$/`.

### `resolveEscrowAddress(invoiceId)` resolution logic

1. Parse and cache `ESCROW_ADDR_BY_INVOICE` JSON (cached in memory after first call).
2. Determine the current environment from `process.env.NODE_ENV`, falling back to `defaultEnvironment`.
3. Find the first mapping where `invoiceId` matches, `isActive !== false`, and `environment` matches the current env.
4. Return `escrowAddress` if found; throw `EscrowNotFoundError` otherwise.

### Error classes

#### `EscrowNotFoundError`

```js
err.name      // "EscrowNotFoundError"
err.message   // "No active escrow contract mapped for invoiceId: <invoiceId>"
err.invoiceId // string — the invoice ID that was looked up
```

**HTTP translation:** callers should map this to `404` or `422`.

#### `EscrowMapConfigError`

```js
err.name    // "EscrowMapConfigError"
err.message // Descriptive message, e.g.:
            //   "ESCROW_ADDR_BY_INVOICE is not valid JSON. Check your environment configuration."
            //   "ESCROW_ADDR_BY_INVOICE.mappings must be an array."
            //   "Each mapping must have a string invoiceId."
            //   "Mapping for <id> has an invalid Stellar escrowAddress."
```

**HTTP translation:** callers should map this to `500` (server misconfiguration).

### Example

```js
const { resolveEscrowAddress, EscrowNotFoundError } = require('./config/escrowMap');

try {
  const address = resolveEscrowAddress('inv_demo_001');
  // address === "GABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890ABCDEFGHIJKLM"
} catch (err) {
  if (err instanceof EscrowNotFoundError) {
    return res.status(404).json({ error: err.message });
  }
  throw err; // EscrowMapConfigError or unexpected
}
```

```bash
# .env
ESCROW_ADDR_BY_INVOICE='{"mappings":[{"invoiceId":"inv_demo_001","escrowAddress":"GABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890ABCDEFGHIJKLM","environment":"development","isActive":true}],"defaultEnvironment":"development","allowlistEnabled":true}'
```

---

## 6. config/apiKeys.js — API Key Registry

**Source:** [`src/config/apiKeys.js`](../src/config/apiKeys.js)

Parses and validates the static API key store from `API_KEYS`. Builds an O(1) lookup map used by the `apiKeyAuth` middleware to authenticate service-to-service requests.

### Exports

| Export | Type | Description |
|---|---|---|
| `loadApiKeyRegistry(env?)` | `(env?) => Map<string, ApiKeyEntry>` | Parses `env.API_KEYS` and returns a `Map` keyed by the raw key string. Called fresh on every invocation — no module-level caching, so tests can override `process.env.API_KEYS` freely. |
| `parseApiKeys(raw)` | `(string?) => ApiKeyEntry[]` | Splits a semicolon-separated string of JSON entries and validates each. Returns `[]` for absent/blank input. |
| `buildKeyRegistry(entries)` | `(ApiKeyEntry[]) => Map<string, ApiKeyEntry>` | Converts a validated entry list to a Map. Throws on duplicate keys. |
| `validateEntry(entry, index)` | `(unknown, number) => ApiKeyEntry` | Validates a single raw entry object. Throws a descriptive `Error` on any constraint violation. |
| `API_KEY_PREFIX` | `string` | `'lf_'` — required prefix for every key. |
| `MIN_KEY_LENGTH` | `number` | `10` — minimum total length of the key string (prefix included). |
| `VALID_SCOPES` | `string[]` | `['invoices:read', 'invoices:write', 'escrow:read']` |

### Environment variables

| Variable | Required | Description |
|---|---|---|
| `API_KEYS` | No | Semicolon-separated list of JSON key entries. Absent/blank → empty registry (API key auth disabled). |

### `ApiKeyEntry` shape

```js
{
  key:      string,    // raw key, starts with "lf_", min 10 chars
  clientId: string,    // unique service identifier
  scopes:   string[],  // non-empty subset of VALID_SCOPES
  revoked:  boolean    // true → key rejected at auth time (default false)
}
```

### `API_KEYS` format

Semicolon-separated JSON objects:

```
API_KEYS={"key":"lf_service_a_key","clientId":"billing","scopes":["invoices:read","invoices:write"]};{"key":"lf_legacy_key","clientId":"legacy","scopes":["invoices:read"],"revoked":true}
```

### Validation rules (per entry)

| Field | Rule |
|---|---|
| `key` | Non-empty string, starts with `lf_`, min 10 chars total |
| `clientId` | Non-empty string |
| `scopes` | Non-empty array; each element must be in `VALID_SCOPES` |
| `revoked` | Boolean when present; omit to default to `false` |
| Duplicate keys | Rejected by `buildKeyRegistry` — same `key` string appearing twice throws |

### Errors

| Condition | Error message pattern |
|---|---|
| Entry is not a JSON object | `API_KEYS[<i>]: entry must be a JSON object` |
| `key` missing or empty | `API_KEYS[<i>]: "key" must be a non-empty string` |
| `key` lacks `lf_` prefix | `API_KEYS[<i>]: "key" must start with "lf_"` |
| `key` too short | `API_KEYS[<i>]: "key" must be at least 10 characters long` |
| `clientId` missing or empty | `API_KEYS[<i>]: "clientId" must be a non-empty string` |
| `scopes` empty or not an array | `API_KEYS[<i>]: "scopes" must be a non-empty array` |
| Unknown scope value | `API_KEYS[<i>]: unknown scope "<s>". Valid scopes: invoices:read, invoices:write, escrow:read` |
| `revoked` not a boolean | `API_KEYS[<i>]: "revoked" must be a boolean when present` |
| Invalid JSON in an entry | `API_KEYS[<i>]: failed to parse JSON — <parse error>` |
| Duplicate key string | `API_KEYS: duplicate key detected for clientId "<id>"` |

### Example

```js
const { loadApiKeyRegistry } = require('./config/apiKeys');

const registry = loadApiKeyRegistry();
const entry = registry.get(req.headers['x-api-key']);

if (!entry || entry.revoked) {
  return res.status(401).json({ error: 'Invalid or revoked API key.' });
}

if (!entry.scopes.includes('invoices:read')) {
  return res.status(403).json({ error: 'Insufficient scope.' });
}
```

```bash
# .env — key rotation example: add new key first, then revoke old key in a second deploy
API_KEYS={"key":"lf_new_key_abc123","clientId":"billing","scopes":["invoices:read"]};{"key":"lf_old_key_xyz789","clientId":"billing","scopes":["invoices:read"],"revoked":true}
```

---

## 7. config/escrowVersions.js — Wasm Schema Version Registry

**Source:** [`src/config/escrowVersions.js`](../src/config/escrowVersions.js)

Maintains a registry of known LiquifactEscrow wasm release versions and their corresponding on-chain `SCHEMA_VERSION` (a `u32` in the contract's persistent storage). Also provides helpers to fetch the live on-chain version via Soroban RPC and compare it against the registry.

### Exports

| Export | Type | Description |
|---|---|---|
| `REGISTRY` | `Record<string, number>` | Maps semver tag → `SCHEMA_VERSION` integer for all known releases. |
| `getOnChainSchemaVersion(contractId?)` | `(string?) => Promise<number>` | Reads `SCHEMA_VERSION` from the deployed contract via `callSorobanContract`. Falls back to `ESCROW_CONTRACT_ID` env var when `contractId` is omitted. |
| `compareVersions(onChainVersion)` | `(number) => CompareResult` | Compares an on-chain version against the highest entry in `REGISTRY`. |
| `isValidContractId(contractId)` | `(string) => boolean` | Returns `true` if the value is a Stellar contract address matching `/^C[A-Z2-7]{55}$/`. |

### `REGISTRY` (current known versions)

```js
{
  '1.0.0': 1,
  '1.1.0': 2,
  '1.2.0': 3,
}
```

Add a new entry here whenever a wasm upgrade increments `SCHEMA_VERSION`.

### Environment variables

| Variable | Required | Description |
|---|---|---|
| `ESCROW_CONTRACT_ID` | No | Default contract address for `getOnChainSchemaVersion()` when none is passed as an argument. Must match `^C[A-Z2-7]{55}$`. |

### `compareVersions(onChainVersion)` return value

```js
{
  status: 'current' | 'ahead' | 'unknown',
  knownVersion: string | null   // semver tag, or null when no match
}
```

| `status` | Meaning |
|---|---|
| `current` | `onChainVersion` matches the highest `REGISTRY` entry. |
| `ahead` | `onChainVersion` is higher than every registry entry — the registry needs updating. |
| `unknown` | `onChainVersion` is lower than the maximum and does not match any entry. |

### Errors thrown by `getOnChainSchemaVersion`

| Condition | `.code` | Error message |
|---|---|---|
| `contractId` is missing or invalid | `INVALID_CONTRACT_ID` | `Invalid or missing ESCROW_CONTRACT_ID` |
| Soroban RPC call fails | `RPC_ERROR` | `RPC read failed: <underlying message>` |

The function never calls `process.exit`. All failures are rejected promises with the structured error above.

### Example

```js
const { getOnChainSchemaVersion, compareVersions, REGISTRY } = require('./config/escrowVersions');

const onChainVersion = await getOnChainSchemaVersion('CABC...123');
const { status, knownVersion } = compareVersions(onChainVersion);

if (status === 'ahead') {
  logger.warn({ onChainVersion }, 'On-chain schema ahead of registry — update REGISTRY');
}
```

```js
// Check a known version without RPC
const { compareVersions } = require('./config/escrowVersions');
compareVersions(3); // { status: 'current', knownVersion: '1.2.0' }
compareVersions(4); // { status: 'ahead',   knownVersion: '1.2.0' }
compareVersions(0); // { status: 'unknown', knownVersion: null    }
```

---

## 8. Environment Variable Quick Reference

All variables consumed by `src/config/`. See `.env.example` for the full list including variables consumed by other modules.

| Variable | Module | Default | Required |
|---|---|---|---|
| `NODE_ENV` | index | `development` | No |
| `PORT` | index | `3001` | No |
| `JWT_SECRET` | index | — | **Yes** |
| `CORS_ALLOWED_ORIGINS` | index / cors | — | No |
| `CORS_ORIGINS` | cors | — | No (deprecated alias) |
| `CORS_MAX_AGE` | cors | `600` | No |
| `SOROBAN_RPC_URL` | index / stellar | `https://soroban-testnet.stellar.org` | No (validated at boot) |
| `NETWORK_PASSPHRASE` | index | `Test SDF Network ; September 2015` | No |
| `STELLAR_NETWORK` | stellar | — | **Yes** (at boot validation) |
| `SOROBAN_BATCH_CONCURRENCY` | index | `5` | No |
| `SOROBAN_BATCH_TIMEOUT_MS` | index | `5000` | No |
| `ESCROW_INDEXER_ENABLED` | index | `false` | No |
| `ESCROW_INDEXER_STALE_THRESHOLD_SECONDS` | index | `300` | No |
| `KYC_PROVIDER_URL` | index | — | No (must pair with API key) |
| `KYC_PROVIDER_API_KEY` | index | — | No (must pair with URL) |
| `KYC_PROVIDER_SECRET` | index | — | No |
| `ESCROW_CACHE_TTL_SECONDS` | cache | `30` | No |
| `ESCROW_ADDR_BY_INVOICE` | escrowMap | — | No |
| `API_KEYS` | apiKeys | — | No |
| `ESCROW_CONTRACT_ID` | escrowVersions | — | No |

---

## 9. Error Reference

Summary of all errors raised by `src/config/` modules, their origin, and recommended HTTP mapping for route handlers.

| Error / condition | Module | Throw type | Recommended HTTP status |
|---|---|---|---|
| Missing / invalid env var at boot | `index` | `Error` (wraps `ZodError`) | — (prevents startup) |
| `get()` before `validate()` | `index` | `Error` | — (programming error) |
| Blocked browser origin | `cors` | `Error` with `.status=403` | `403 Forbidden` |
| `STELLAR_NETWORK` missing | `stellar` | `Error` | — (prevents startup) |
| `SOROBAN_RPC_URL` missing | `stellar` | `Error` | — (prevents startup) |
| Network/RPC mismatch | `stellar` | `Error` | — (prevents startup) |
| Unknown network in `getNetworkPassphrase` / `getExpectedRpc` | `stellar` | `Error` | `500 Internal Server Error` |
| Invalid `ESCROW_ADDR_BY_INVOICE` JSON | `escrowMap` | `EscrowMapConfigError` | `500 Internal Server Error` |
| No active escrow mapping for invoice | `escrowMap` | `EscrowNotFoundError` | `404 Not Found` |
| Invalid/missing `ESCROW_CONTRACT_ID` | `escrowVersions` | `Error` (`.code='INVALID_CONTRACT_ID'`) | `400 Bad Request` |
| Soroban RPC read failure | `escrowVersions` | `Error` (`.code='RPC_ERROR'`) | `502 Bad Gateway` |
| Invalid JSON in `API_KEYS` entry | `apiKeys` | `Error` | — (prevents startup or first use) |
| Duplicate key in `API_KEYS` | `apiKeys` | `Error` | — (prevents startup or first use) |
| Unknown scope in `API_KEYS` entry | `apiKeys` | `Error` | — (prevents startup or first use) |
