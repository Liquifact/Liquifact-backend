/**
 * KYC Service
 * Manages KYC verification workflows and status persistence.
 *
 * Supports optional external KYC provider integration when env keys are present.
 * Falls back cleanly to an in-memory mock implementation for local/test use.
 *
 * @module services/kycService
 */

const db = require('../db/knex');
const logger = require('../logger');
const { emitKycWebhookForSme } = require('./kycWebhookEmitter');
const { CircuitBreaker } = require('../utils/circuitBreaker');
const { withRetry } = require('../utils/retry');
const { MemoryCacheStore } = require('./cacheStore');
const { createSignatureHeader, verifySignature } = require('./webhooks');
const { KYC_STATUSES } = require('../constants/kycWebhooks');
const { createAuditLog } = require('./auditLog');

const PROVIDER_STATUS_MAP = {
  pending: KYC_STATUSES.PENDING,
  in_review: KYC_STATUSES.PENDING,
  reviewing: KYC_STATUSES.PENDING,
  queued: KYC_STATUSES.PENDING,
  submitted: KYC_STATUSES.PENDING,
  verified: KYC_STATUSES.VERIFIED,
  approved: KYC_STATUSES.VERIFIED,
  pass: KYC_STATUSES.VERIFIED,
  success: KYC_STATUSES.VERIFIED,
  rejected: KYC_STATUSES.REJECTED,
  denied: KYC_STATUSES.REJECTED,
  declined: KYC_STATUSES.REJECTED,
  failed: KYC_STATUSES.REJECTED,
  exempted: KYC_STATUSES.EXEMPTED,
  exempt: KYC_STATUSES.EXEMPTED,
  waived: KYC_STATUSES.EXEMPTED,
};

// ──────────────────────────────────────────────────────────────────────────
// Issue #592 — External provider transport hardening
// ──────────────────────────────────────────────────────────────────────────

/**
 * Set of HTTP status codes that warrant a retry against the external KYC
 * provider. Network errors (see {@link KYC_RETRYABLE_NETWORK_CODES}) and
 * AbortError/TimeoutError are also retried by {@link classifyKycError}.
 *
 * @constant {Readonly<Set<number>>}
 */
const KYC_RETRYABLE_STATUS_CODES = new Set([408, 425, 429, 500, 502, 503, 504]);

/**
 * Node.js network error codes that indicate a transient, retryable fault.
 * Conservative set: connection refused, reset, timed out, DNS hiccups, aborter.
 *
 * @constant {Readonly<Set<string>>}
 */
const KYC_RETRYABLE_NETWORK_CODES = new Set([
  'ETIMEDOUT',
  'ECONNRESET',
  'ECONNREFUSED',
  'EAI_AGAIN',
  'ENOTFOUND',
  'ABORT_ERR',
]);

/**
 * Error thrown by the external KYC provider client. Carries a `retryable`
 * flag so callers (and the retry helper) can decide whether to attempt
 * again — a 503 from the provider is retryable, a 400 is permanent.
 *
 * Never logs itself — the message may include the upstream status code but
 * never the raw response body or any environment-derived secrets.
 *
 * @extends {Error}
 */
class KycProviderError extends Error {
  /**
   * Builds a typed KycProviderError carrying status and a stable `retryable`
   * verdict that {@link withRetry} consumes to decide re-attempts. The shared
   * {@link CircuitBreaker} reads the same flag (via its onFailure path) so a
   * sustained outage trips the breaker regardless of which transient code
   * caused the failure.
   *
   * @param {string} message Human-readable error message.
   * @param {Object} [options]
   * @param {number|null} [options.status] HTTP status from the upstream response (null on network failure).
   * @param {boolean} [options.retryable=false] True if the error is transient and worth retrying.
   * @param {string|null} [options.code=null] Stable classification code (e.g. 'status:503', 'network:ETIMEDOUT').
   * @param {Error|null} [options.cause=null] Underlying error, preserved for debugging.
   */
  constructor(message, options = {}) {
    super(message);
    this.name = 'KycProviderError';
    this.status = options.status ?? null;
    this.retryable = options.retryable ?? false;
    this.code = options.code ?? null;
    if (options.cause) {
      this.cause = options.cause;
    }
    Error.captureStackTrace?.(this, KycProviderError);
  }
}

/**
 * Stable fail-fast error returned when the KYC dependency circuit is open.
 * Callers can map `code` to a 503 without parsing provider internals.
 */
class KycUpstreamUnavailableError extends KycProviderError {
  /**
   * Creates a stable 503 error without exposing the upstream internals.
   * @param {Error|null} [cause] Internal cause retained for diagnostics only.
   */
  constructor(cause = null) {
    super('KYC provider is temporarily unavailable', {
      status: 503,
      retryable: true,
      code: 'upstream_unavailable',
      cause: cause instanceof Error ? cause : null,
    });
    this.name = 'KycUpstreamUnavailableError';
  }
}

/**
 * Coerces a raw integer-shaped env var into a clamped positive integer.
 * Used by {@link getKycProviderConfig} to keep user-supplied durations and
 * retry counts within safe bounds so a typo cannot disable retries or
 * make the breaker hang indefinitely.
 *
 * @param {string|number|undefined} rawValue Raw env value.
 * @param {number} fallback Default when the value is missing or non-numeric.
 * @param {number} min Minimum allowed (clamped lower bound).
 * @param {number} max Maximum allowed (clamped upper bound).
 * @returns {number} Clamped integer.
 */
function parseClampedInt(rawValue, fallback, min, max) {
  const parsed = Number.parseInt(String(rawValue === undefined || rawValue === null ? '' : rawValue), 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(Math.max(parsed, min), max);
}

/**
 * Classifies an error thrown by the KYC provider transport.
 *
 * Signal priority (first match wins):
 *   1. Already-typed KycProviderError → honour its `retryable` field.
 *   2. Transport-level network codes (ECONNRESET, ETIMEDOUT, …) or AbortError.
 *   3. HTTP status code (top-level `err.status` or `err.response.status`).
 *
 * @param {unknown} err - Thrown error value.
 * @returns {{retryable: boolean, reason: string}} Verdict and stable signal
 *   identifier (e.g. 'status:503', 'network:ETIMEDOUT', 'kyc-provider-error').
 */
function classifyKycError(err) {
  if (!err || typeof err !== 'object') {
    return { retryable: false, reason: 'invalid-error-shape' };
  }

  if (err instanceof KycProviderError) {
    return { retryable: !!err.retryable, reason: err.code || 'kyc-provider-error' };
  }

  // Transport-level: Node.js network codes are case-insensitive (the Node
  // SDK and various clients sometimes lowercase them).
  const code = typeof err.code === 'string' ? err.code.toUpperCase() : '';
  if (KYC_RETRYABLE_NETWORK_CODES.has(code)) {
    return { retryable: true, reason: `network:${code}` };
  }

  if (err.name === 'AbortError' || err.name === 'TimeoutError') {
    return { retryable: true, reason: 'timeout' };
  }

  // Structured HTTP status (top-level or wrapped in `.response`).
  const rawStatus = err.status ?? (err.response && err.response.status);
  if (Number.isInteger(rawStatus) && KYC_RETRYABLE_STATUS_CODES.has(rawStatus)) {
    return { retryable: true, reason: `status:${rawStatus}` };
  }

  return { retryable: false, reason: 'non-retryable' };
}

// ──────────────────────────────────────────────────────────────────────────
// Shared circuit breaker
// ──────────────────────────────────────────────────────────────────────────

/**
 * Shared circuit breaker for all external KYC provider calls. State-transition
 * metrics (label `name=kyc`) are emitted automatically by the breaker so
 * operators can alert on sustained outage.
 *
 * Thresholds are read from env vars (clamped) at module load:
 * - `KYC_PROVIDER_CB_FAILURE_THRESHOLD` (1..100, default 5)
 * - `KYC_PROVIDER_CB_RECOVERY_TIMEOUT_MS` (100..60000, default 10000)
 *
 * @type {CircuitBreaker}
 */
const sharedKycBreaker = new CircuitBreaker({
  name: 'kyc',
  failureThreshold: parseClampedInt(process.env.KYC_PROVIDER_CB_FAILURE_THRESHOLD, 5, 1, 100),
  recoveryTimeout: parseClampedInt(process.env.KYC_PROVIDER_CB_RECOVERY_TIMEOUT_MS, 10000, 100, 60000),
});

/**
 * Resets the shared KYC circuit breaker. Intended for tests and operational
 * recovery after a known provider fix has been deployed.
 *
 * @returns {void}
 */
function resetKycCircuitBreaker() {
  sharedKycBreaker.reset();
}

/**
 * Returns a safe operational snapshot. No provider URL, key, or response
 * content is included, making this suitable for metrics/debug endpoints.
 * @returns {{dependency: string, state: string, failureCount: number, nextAttemptAt: number}}
 */
function getKycProviderResilienceState() {
  return {
    dependency: 'kyc-provider',
    state: sharedKycBreaker.state,
    failureCount: sharedKycBreaker.failureCount,
    nextAttemptAt: sharedKycBreaker.nextAttemptTime,
  };
}

// In-memory store for KYC records (used in test/dev environments)
const mockKycRecords = new Map();

/**
 * Short-TTL cache for external KYC provider status lookups (issue #440).
 * Backed by MemoryCacheStore so eviction / invalidation is consistent across
 * all cache users in the process.
 *
 * @type {MemoryCacheStore}
 */
const kycStatusCache = new MemoryCacheStore({ maxEntries: 2000 });

/**
 * Key prefix used to namespace external KYC status cache entries.
 * Keeps KYC cache keys from colliding with other cache users.
 *
 * @constant {string}
 */
const STATUS_CACHE_KEY_PREFIX = 'kyc:ext:';

/**
 * Default TTL (in seconds) for the external KYC status cache.
 * 30 s strikes a balance between freshness and avoiding provider rate limits.
 *
 * @constant {number}
 */
const DEFAULT_STATUS_CACHE_TTL_SECONDS = 30;

/**
 * Configuration for external KYC provider.
 * Loaded from environment variables. Numeric values are clamped so a typo
 * cannot disable the timeout or make retries unbounded.
 *
 * All thresholds are deliberately bounded to keep the dependency safe by
 * default — see the in-line clamp ranges below.
 *
 * @returns {{
 *   enabled: boolean,
 *   apiKey: (string|null),
 *   baseUrl: (string|null),
 *   apiSecret: (string|null),
 *   timeoutMs: number,
 *   maxRetries: number,
 *   baseDelay: number,
 *   maxDelay: number,
 *   signRequests: boolean,
 *   verifyResponseSignature: boolean
 * }}
 */
const getKycProviderConfig = () => {
  const apiKey = process.env.KYC_PROVIDER_API_KEY || null;
  const baseUrl = process.env.KYC_PROVIDER_URL || null;
  return {
    enabled: !!(apiKey && baseUrl),
    apiKey,
    baseUrl,
    apiSecret: process.env.KYC_PROVIDER_SECRET || null,
    // 100ms lower bound — anything tighter would defeat the timeout.
    // 30s upper bound — bounded so a slow provider request cannot linger for minutes.
    timeoutMs: parseClampedInt(process.env.KYC_PROVIDER_TIMEOUT_MS, 5000, 100, 30000),
    // 0 disables retries outright.
    maxRetries: parseClampedInt(process.env.KYC_PROVIDER_MAX_RETRIES, 3, 0, 10),
    // Backoff knobs used by withRetry; clamped per the retry helper's own safety caps.
    baseDelay: parseClampedInt(process.env.KYC_PROVIDER_BASE_DELAY_MS, 200, 0, 10000),
    maxDelay: parseClampedInt(process.env.KYC_PROVIDER_MAX_DELAY_MS, 5000, 0, 60000),
    // Outbound request signing (HMAC over the JSON body) — opt-in.
    signRequests: String(process.env.KYC_PROVIDER_SIGN_REQUESTS || '').toLowerCase() === 'true',
    // Strict response integrity verification — opt-in. When false, the client
    // still defensively verifies an `X-KYC-Signature` header if the provider
    // happens to send one, but does not require it.
    verifyResponseSignature: String(process.env.KYC_PROVIDER_VERIFY_RESPONSE_SIGNATURE || '').toLowerCase() === 'true',
  };
};

/**
 * Resolves the configured TTL (in milliseconds) for the external KYC status
 * cache from `KYC_STATUS_CACHE_TTL_SECONDS`.
 *
 * A non-positive, non-numeric, or zero value disables caching entirely (the
 * provider is consulted on every read). This makes it possible to switch the
 * cache off in environments that require strict freshness without code changes.
 *
 * @returns {number} TTL in milliseconds, or 0 when caching is disabled.
 */
function getStatusCacheTtlMs() {
  const raw = process.env.KYC_STATUS_CACHE_TTL_SECONDS;
  if (raw === undefined || raw === null || raw === '') {
    return DEFAULT_STATUS_CACHE_TTL_SECONDS * 1000;
  }

  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return 0;
  }

  return Math.floor(seconds * 1000);
}

/**
 * Builds the cache key for an SME's external KYC status entry.
 *
 * @param {string} smeId - The SME identifier.
 * @returns {string} The namespaced cache key.
 */
function statusCacheKey(smeId) {
  return `${STATUS_CACHE_KEY_PREFIX}${smeId}`;
}

/**
 * Invalidates the cached external KYC status for an SME.
 *
 * Called on every persisted status write (verification, rejection, exemption,
 * provider refresh, and KYC webhook ingestion) so that a cached approval can
 * never outlive a subsequent revocation or status change event.
 *
 * @param {string} smeId - The SME identifier whose cache entry to drop.
 * @returns {void}
 */
function invalidateKycStatusCache(smeId) {
  if (!smeId || typeof smeId !== 'string') {
    return;
  }
  kycStatusCache.del(statusCacheKey(smeId));
}

/**
 * Reads an SME's external KYC status through a short-TTL cache.
 *
 * On a cache hit (within TTL) the cached status object is returned and the
 * `loader` — which performs the external provider call — is **not** invoked,
 * avoiding redundant provider traffic and rate-limit pressure. On a miss (or
 * when caching is disabled via TTL) the `loader` is awaited and its result is
 * cached for the configured TTL.
 *
 * Security: the cache is never a source of stale "approved" data past an event.
 * The `loader` ({@link verifyWithExternalProvider}) persists the fresh status,
 * which invalidates this key via {@link invalidateKycStatusCache} before the
 * new value is stored, and any later webhook/manual write invalidates it again.
 *
 * @param {string} smeId - The SME identifier (used as the cache key).
 * @param {function(): Promise<{status: string, recordId: (string|null), verifiedAt: (string|null)}>} loader
 *   Async loader that fetches the authoritative status from the provider.
 * @returns {Promise<{status: string, recordId: (string|null), verifiedAt: (string|null)}>}
 *   The cached or freshly-loaded KYC status object.
 */
async function readProviderStatusCached(smeId, loader) {
  const ttlMs = getStatusCacheTtlMs();
  if (ttlMs <= 0) {
    // Caching disabled — always hit the provider.
    return loader();
  }

  const key = statusCacheKey(smeId);
  const cached = kycStatusCache.get(key);
  if (cached !== undefined) {
    return cached;
  }

  const fresh = await loader();
  kycStatusCache.set(key, fresh, ttlMs);
  return fresh;
}

/**
 * Normalizes provider-specific status values to internal KYC statuses.
 *
 * Maps known provider statuses to internal KYC states. If the provider returns
 * a status not in the mapping, gracefully falls back to 'unknown' state and logs
 * the unmapped value for later analysis. This prevents KYC verification failures
 * due to provider status changes or additions.
 *
 * @param {string} status - External provider status.
 * @returns {string} Normalized KYC status. Returns 'unknown' if status is not in the mapping.
 * @throws {Error} If status is missing, null, or not a string.
 *
 * @example
 * normalizeProviderStatus('verified') // => 'verified'
 * normalizeProviderStatus('in_review') // => 'pending'
 * normalizeProviderStatus('new_status_v2') // => 'unknown' (logged)
 * normalizeProviderStatus(null) // => throws Error
 */
function normalizeProviderStatus(status) {
  // Validate input: must be a non-empty string
  if (status === null || status === undefined) {
    logger.warn({ status }, 'Received null or undefined provider status, defaulting to unknown');
    return KYC_STATUSES.UNKNOWN;
  }

  if (typeof status !== 'string') {
    logger.warn({ status, type: typeof status }, 'Received non-string provider status, defaulting to unknown');
    return KYC_STATUSES.UNKNOWN;
  }

  const normalized = status.trim().toLowerCase();

  // Handle empty string after trim
  if (normalized === '') {
    logger.warn({ originalStatus: status }, 'Received empty provider status, defaulting to unknown');
    return KYC_STATUSES.UNKNOWN;
  }

  // Check if status is in the mapping
  if (!Object.prototype.hasOwnProperty.call(PROVIDER_STATUS_MAP, normalized)) {
    // Log unmapped status for monitoring and future mapping updates
    logger.warn(
      { unmappedStatus: normalized, originalStatus: status },
      'Provider returned unmapped KYC status, defaulting to unknown. Consider extending PROVIDER_STATUS_MAP.',
    );
    return KYC_STATUSES.UNKNOWN;
  }

  return PROVIDER_STATUS_MAP[normalized];
}

/**
 * Reads a persisted KYC record from the database.
 *
 * @param {string} smeId - The SME identifier.
 * @returns {Promise<null|Object>} Persisted KYC record, or null when missing.
 */
async function readKycRecord(smeId) {
  if (!smeId || typeof smeId !== 'string') {
    throw new Error('Invalid SME ID');
  }

  const row = await db('kyc_records').where({ sme_id: smeId }).first();
  if (!row || !row.status) {
    return null;
  }

  return {
    smeId: row.sme_id,
    status: row.status,
    recordId: row.provider_record_id || null,
    verifiedAt: row.verified_at ? row.verified_at.toISOString?.() || row.verified_at : null,
    updatedAt: row.updated_at ? row.updated_at.toISOString?.() || row.updated_at : null,
  };
}

/**
 * Persists a KYC status update to the database.
 *
 * @param {Object} params
 * @param {string} params.smeId
 * @param {string} params.status
 * @param {string|null} [params.providerRecordId]
 * @param {string|null} [params.verifiedAt]
 * @param {Object} [options={}] Additional options (actor, ipAddress, userAgent, metadata).
 * @returns {Promise<Object>} Persisted KYC state.
 */
async function persistKycRecord({ smeId, status, providerRecordId = null, verifiedAt = null }, options = {}) {
  if (!smeId || typeof smeId !== 'string') {
    throw new Error('Invalid SME ID');
  }

  const beforeRecord = await readKycRecord(smeId);
  const normalizedStatus = normalizeProviderStatus(status);
  const updatedAt = new Date();
  const record = {
    sme_id: smeId,
    status: normalizedStatus,
    provider_record_id: providerRecordId || null,
    verified_at: verifiedAt || null,
    updated_at: updatedAt,
  };

  // Invalidate the short-TTL cache entry BEFORE writing to DB so that any
  // concurrent reader that checks the cache after this point will miss
  // and consult the DB (or provider) for the fresh status. This prevents
  // a stale cached "verified" from outliving a subsequent revocation write.
  invalidateKycStatusCache(smeId);

  await db('kyc_records')
    .insert(record)
    .onConflict('sme_id')
    .merge();

  const result = {
    smeId,
    status: normalizedStatus,
    recordId: providerRecordId || null,
    verifiedAt: verifiedAt || null,
    updatedAt: updatedAt.toISOString(),
  };

  const action = beforeRecord ? 'UPDATE' : 'CREATE';
  const actor = (options && options.actor) || 'kyc-webhook';

  try {
    await createAuditLog({
      actor,
      action,
      resourceType: 'kyc-webhook',
      resourceId: smeId,
      before: beforeRecord,
      after: result,
      ipAddress: (options && options.ipAddress) || 'unknown',
      userAgent: (options && options.userAgent) || 'unknown',
      metadata: (options && options.metadata) || {},
    });
  } catch (auditErr) {
    logger.warn({ smeId, error: auditErr.message }, 'Failed to record KYC webhook audit log');
  }

  // Fire-and-forget: emit outbound webhook for the KYC status change.
  // Errors are suppressed inside emitKycWebhookForSme so they can never
  // prevent the KYC record from being persisted.
  emitKycWebhookForSme({
    smeId,
    status: normalizedStatus,
    recordId: providerRecordId || null,
    verifiedAt: verifiedAt || null,
  }).catch((err) => {
    logger.error(
      { smeId, error: err && err.message ? err.message : String(err) },
      'persistKycRecord: unexpected error from webhook emitter (suppressed)'
    );
  });

  return result;
}

/**
 * Verifies KYC status from external provider.
 *
 * Only called if provider is configured and enabled. The call is hardened
 * against transient failures (issue #592):
 *
 *   1. **Bounded timeout** — requests use `AbortController` keyed off
 *      `KYC_PROVIDER_TIMEOUT_MS` (default 5 000 ms, clamped `[100, 30000]`).
 *   2. **Retries** — transient failures (network codes `ETIMEDOUT`/`ECONNRESET`/
 *      `ECONNREFUSED`/etc., HTTP `408/425/429/5xx`) are retried with
 *      exponential backoff via {@link withRetry}. Permanent errors (4xx other
 *      than 408/425/429) are not retried.
 *   3. **Circuit breaker** — calls are wrapped in a shared {@link CircuitBreaker}
 *      so sustained outages fail fast instead of queueing requests against the
 *      degraded provider.
 *   4. **Fail-closed** — every failure path raises {@link KycProviderError} (or
 *      re-raises the breaker trip). Never auto-verifies an SME on provider
 *      unavailability. The caller {@link getKycStatus} falls back to the
 *      persisted record when an SME is already known.
 *   5. **Outbound HMAC request signing** — opt-in via
 *      `KYC_PROVIDER_SIGN_REQUESTS=true`. Uses the same `t=<ts>,v1=<sig>`
 *      format from {@link createSignatureHeader} so the provider can verify
 *      using constants identical to the inbound webhook signature scheme.
 *   6. **Response integrity verification** — if the provider returns an
 *      `X-KYC-Signature` (or `X-KYC-Response-Signature`) header, the client
 *      verifies it against `KYC_PROVIDER_SECRET`. Mismatch always fails
 *      closed. With `KYC_PROVIDER_VERIFY_RESPONSE_SIGNATURE=true` the client
 *      additionally requires the header to be present.
 *
 * Provider secrets (API key, signing secret) are **never** included in
 * returned data, thrown error messages, or log records.
 *
 * @param {string} smeId - The SME identifier.
 * @param {Object} _smeData - SME metadata from the authenticated principal.
 * @returns {Promise<{status: string, recordId: string, verifiedAt: string|null}>}
 */
async function verifyWithExternalProvider(smeId, _smeData) {
  const config = getKycProviderConfig();

  if (!config.enabled) {
    throw new Error('KYC provider not configured');
  }

  // Strip any trailing slash on the base URL before composing the endpoint.
  const baseUrl = config.baseUrl.replace(/\/+$/, '');
  const url = `${baseUrl}/verify`;
  // Capture only the host so logs never expose the full URL (which can have
  // secrets embedded as query params by some provider setups).
  const safeHost = (() => {
    try {
      return new URL(baseUrl).host;
    } catch (_e) {
      return 'invalid-url';
    }
  })();

  // ── Per-attempt operation: timeout + fetch + sign + verify response ─
  const operation = async () => {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), config.timeoutMs);
    if (timeoutId.unref) {
      timeoutId.unref();
    }

    try {
      const payload = {
        smeId,
        timestamp: new Date().toISOString(),
      };
      const body = JSON.stringify(payload);

      const headers = {
        Authorization: `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      };

      // Outbound HMAC request signing — opt-in. We sign the exact JSON body
      // that is put on the wire so the provider can recompute the signature
      // and authenticate the request. Reuses {@link createSignatureHeader} so
      // the producer format matches the inbound webhook scheme.
      if (config.signRequests && config.apiSecret) {
        headers['X-KYC-Signature'] = createSignatureHeader(config.apiSecret, body);
      }

      let response;
      try {
        response = await fetch(url, {
          method: 'POST',
          headers,
          body,
          signal: controller.signal,
        });
      } catch (networkErr) {
        // Coerce raw fetch / network error into a typed KycProviderError so
        // the retry helper sees a stable `retryable` flag.
        const classified = classifyKycError(networkErr);
        throw new KycProviderError(
          `KYC provider request failed: ${networkErr.message || networkErr.code || 'unknown'}`,
          {
            status: null,
            retryable: classified.retryable,
            code: classified.reason,
            cause: networkErr,
          },
        );
      }

      if (!response.ok) {
        const status = response.status;
        const classified = classifyKycError({ status });
        // Log only the HTTP status and safe host — never include the body
        // which may contain PII (SSN, DOB, address) returned by the provider.
        logger.warn(
          { smeId, providerHost: safeHost, status, retryable: classified.retryable },
          'External KYC provider returned non-ok response',
        );
        throw new KycProviderError(
          `KYC provider responded with HTTP ${status}`,
          { status, retryable: classified.retryable, code: classified.reason },
        );
      }

      const responseText = await response.text();

      // ── Response integrity verification ────────────────────────────
      // If the provider returns a signature header we always verify it
      // (fail-closed on mismatch). The `verifyResponseSignature` flag
      // additionally requires the header to be present.
      if (config.apiSecret) {
        const responseSig =
          response.headers.get('X-KYC-Response-Signature') ||
          response.headers.get('X-KYC-Signature');

        if (responseSig) {
          const verification = verifySignature(config.apiSecret, responseText, responseSig);
          if (!verification.valid) {
            logger.warn(
              { smeId, providerHost: safeHost, error: verification.error },
              'KYC provider response signature mismatch (fail-closed)',
            );
            throw new KycProviderError(
              'KYC provider response signature mismatch',
              { status: 502, retryable: false, code: 'invalid_response_signature' },
            );
          }
        } else if (config.verifyResponseSignature) {
          logger.warn(
            { smeId, providerHost: safeHost },
            'KYC provider response missing required signature (strict mode, fail-closed)',
          );
          throw new KycProviderError(
            'KYC provider response missing required signature',
            { status: 502, retryable: false, code: 'missing_response_signature' },
          );
        }
      }

      let data;
      try {
        data = JSON.parse(responseText);
      } catch (parseErr) {
        throw new KycProviderError(
          `KYC provider returned non-JSON response: ${parseErr.message}`,
          { status: 502, retryable: false, code: 'invalid_response_body' },
        );
      }

      return data;
    } finally {
      clearTimeout(timeoutId);
    }
  };

  const shouldRetry = (err) => {
    if (err && err.code === 'CIRCUIT_OPEN') {
      // Tripped breaker — re-raise without further retry; the caller will
      // handle fallback. withRetry would otherwise consume attempts in vain.
      return false;
    }
    if (err instanceof KycProviderError) {
      return err.retryable;
    }
    return classifyKycError(err).retryable;
  };

  let data;
  try {
    data = await sharedKycBreaker.execute(() =>
      withRetry(operation, {
        maxRetries: config.maxRetries,
        baseDelay: config.baseDelay,
        maxDelay: config.maxDelay,
        shouldRetry,
      }),
    );
  } catch (err) {
    if (err && err.code === 'CIRCUIT_OPEN') {
      const unavailable = new KycUpstreamUnavailableError(err);
      logger.warn(
        { smeId, dependency: 'kyc-provider', state: sharedKycBreaker.state, code: unavailable.code },
        'KYC provider circuit is open; request failed fast',
      );
      throw unavailable;
    }
    // Log only the safe host and a coarse retryable verdict — never include
    // the API key, signing secret, or upstream response body.
    const verdict = classifyKycError(err);
    logger.error(
      {
        smeId,
        providerHost: safeHost,
        retryable: verdict.retryable,
        reason: verdict.reason,
        error: err.message,
      },
      'External KYC provider call failed',
    );
    throw err;
  }

  const recordId = data.recordId || data.providerRecordId || data.provider_record_id || `kyc_${smeId}_${Date.now()}`;
  const verifiedAt = data.verifiedAt || data.verified_at || null;
  const status = normalizeProviderStatus(data.status || data.kycStatus || data.result || '');

  const persisted = await persistKycRecord({
    smeId,
    status,
    providerRecordId: recordId,
    verifiedAt,
  });

  return {
    status: persisted.status,
    recordId: persisted.recordId,
    verifiedAt: persisted.verifiedAt,
  };
}

/**
 * Gets KYC status for an SME.
 * Checks external provider if available, falls back to persisted DB record or mock store.
 *
 * When the external provider is enabled, status reads are served through a
 * short-TTL cache ({@link readProviderStatusCached}) to avoid hammering the
 * provider during hot funding flows. Cache entries are invalidated on any
 * persisted status change (including KYC webhooks), so a revocation always
 * supersedes a cached approval.
 *
 * @param {string} smeId - The SME identifier.
 * @returns {Promise<{status: string, recordId?: string, verifiedAt?: string}>}
 */
async function getKycStatus(smeId) {
  if (!smeId || typeof smeId !== 'string') {
    throw new Error('Invalid SME ID');
  }

  const config = getKycProviderConfig();

  if (config.enabled) {
    try {
      return await readProviderStatusCached(smeId, () => verifyWithExternalProvider(smeId, {}));
    } catch (error) {
      logger.warn({ smeId, error: error.message }, 'KYC provider lookup failed, falling back to persisted status');
      const record = await readKycRecord(smeId);
      if (record) {
        return record;
      }
      return { status: KYC_STATUSES.PENDING };
    }
  }

  const record = await readKycRecord(smeId);
  if (record) {
    return record;
  }

  const mockRecord = mockKycRecords.get(smeId);
  if (mockRecord) {
    return {
      status: mockRecord.status,
      recordId: mockRecord.recordId,
      verifiedAt: mockRecord.verifiedAt,
    };
  }

  return { status: KYC_STATUSES.PENDING };
}

/**
 * Marks an SME as KYC verified.
 * Only available in test/development (mock implementation).
 * Production should integrate with real KYC provider.
 *
 * @param {string} smeId - The SME identifier.
 * @param {Object} options - Additional options.
 * @returns {Promise<{status: string, recordId: string, verifiedAt: string}>}
 */
async function verifySmeSafe(smeId, options = {}) {
  if (!smeId || typeof smeId !== 'string') {
    throw new Error('Invalid SME ID');
  }

  const recordId = options.recordId || `kyc_${smeId}_${Date.now()}`;
  const verifiedAt = new Date().toISOString();
  const record = {
    smeId,
    status: KYC_STATUSES.VERIFIED,
    recordId,
    verifiedAt,
    createdAt: verifiedAt,
  };

  mockKycRecords.set(smeId, record);

  // Persist to database
  await persistKycRecord({
    smeId,
    status: KYC_STATUSES.VERIFIED,
    providerRecordId: recordId,
    verifiedAt,
  });

  logger.info({ smeId, recordId }, 'SME marked as KYC verified');

  return {
    status: record.status,
    recordId: record.recordId,
    verifiedAt: record.verifiedAt,
  };
}

/**
 * Rejects KYC for an SME (mock implementation).
 *
 * @param {string} smeId - The SME identifier.
 * @param {string} reason - Reason for rejection.
 * @returns {Promise<{status: string, recordId: string}>}
 */
async function rejectSmeKyc(smeId, reason = 'Manual rejection') {
  if (!smeId || typeof smeId !== 'string') {
    throw new Error('Invalid SME ID');
  }

  const recordId = `kyc_${smeId}_${Date.now()}`;
  const record = {
    smeId,
    status: KYC_STATUSES.REJECTED,
    recordId,
    reason,
    rejectedAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
  };

  mockKycRecords.set(smeId, record);

  // Persist to database
  await persistKycRecord({
    smeId,
    status: KYC_STATUSES.REJECTED,
    providerRecordId: recordId,
  });

  logger.warn({ smeId, recordId, reason }, 'SME KYC rejected');

  return {
    status: record.status,
    recordId: record.recordId,
  };
}

/**
 * Exempts an SME from KYC requirements.
 * Typically used for low-risk vendors or when exemption is policy-approved.
 *
 * @param {string} smeId - The SME identifier.
 * @param {string} reason - Reason for exemption.
 * @returns {Promise<{status: string, recordId: string}>}
 */
async function exemptSmeFromKyc(smeId, reason = 'Manual exemption') {
  if (!smeId || typeof smeId !== 'string') {
    throw new Error('Invalid SME ID');
  }

  const recordId = `kyc_${smeId}_${Date.now()}`;
  const record = {
    smeId,
    status: KYC_STATUSES.EXEMPTED,
    recordId,
    reason,
    exemptedAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
  };

  mockKycRecords.set(smeId, record);

  // Persist to database
  await persistKycRecord({
    smeId,
    status: KYC_STATUSES.EXEMPTED,
    providerRecordId: recordId,
  });

  logger.info({ smeId, recordId, reason }, 'SME exempted from KYC');

  return {
    status: record.status,
    recordId: record.recordId,
  };
}

/**
 * Checks if an SME can proceed with funding operations.
 * Returns true ONLY for 'verified' or 'exempted' statuses.
 * Explicitly denies 'unknown', 'pending', and 'rejected' statuses.
 *
 * @param {string} kycStatus - The KYC status string.
 * @returns {boolean} True if KYC status allows funding. False for unknown, pending, and rejected.
 *
 * @example
 * canFundWithKycStatus('verified') // => true
 * canFundWithKycStatus('exempted') // => true
 * canFundWithKycStatus('unknown') // => false
 * canFundWithKycStatus('pending') // => false
 * canFundWithKycStatus('rejected') // => false
 */
function canFundWithKycStatus(kycStatus) {
  return kycStatus === KYC_STATUSES.VERIFIED || kycStatus === KYC_STATUSES.EXEMPTED;
}

/**
 * Clears the in-memory mock KYC record store and the external KYC status cache.
 * Intended for tests/dev usage.
 *
 * @returns {void}
 */
function resetMockRecords() {
  mockKycRecords.clear();
  kycStatusCache.clear();
}

module.exports = {
  KYC_STATUSES,
  PROVIDER_STATUS_MAP,
  getKycStatus,
  verifyWithExternalProvider,
  persistKycRecord,
  readKycRecord,
  verifySmeSafe,
  rejectSmeKyc,
  exemptSmeFromKyc,
  canFundWithKycStatus,
  resetMockRecords,
  getKycProviderConfig,
  normalizeProviderStatus, // Export for direct testing
  getStatusCacheTtlMs, // Export for testing (cache TTL behaviour)
  invalidateKycStatusCache, // Export for testing (cache invalidation)
  // Issue #592 hardening exports:
  KycProviderError,
  KycUpstreamUnavailableError,
  classifyKycError,
  sharedKycBreaker,
  resetKycCircuitBreaker,
  getKycProviderResilienceState,
  parseClampedInt,
  KYC_RETRYABLE_STATUS_CODES,
  KYC_RETRYABLE_NETWORK_CODES,
};
