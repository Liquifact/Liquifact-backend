'use strict';

/**
 * @fileoverview Strict Zod schemas for runtime config write payloads.
 *
 * Exposes named schemas for every admin-writable configuration surface:
 *  - `webhookConfigSchema`     � webhook delivery and retry settings
 *  - `reconciliationConfigSchema` � reconciliation run scheduling
 *  - `kycConfigSchema`         � KYC provider connection settings
 *  - `retentionConfigSchema`   � data-retention and legal-hold rules
 *  - `fraudThresholdsSchema`   � per-tenant fraud & manual-review ceilings
 *  - `runtimeConfigSchema`     � top-level union accepted by POST /api/admin/config
 *
 * Security guarantees applied to every schema:
 *  - `.strict()` � unknown keys are rejected (prevents prototype-pollution payloads).
 *  - String length bounds � prevents oversized inputs reaching the store.
 *  - Numeric range checks � ensures values are within safe operating boundaries.
 *  - Enum allowlists � rejects arbitrary strings for categorical fields.
 *
 * Re-exports the shared helpers from `src/schemas/invoice.js` so callers only
 * need one import for middleware + error formatting.
 *
 * @module schemas/config
 */

const { z } = require('zod');
const {
  createBodyValidator,
  createQueryValidator,
  parseValidationErrors,
  DEFAULT_PROBLEM_TYPE,
  DEFAULT_ERROR_CODE,
} = require('./validationHelper');

// -- Shared primitives --------------------------------------------------------

/**
 * A non-empty string bounded to `maxLen` characters, with whitespace trimmed.
 * Kept as a reusable helper for future schema fields that need named-string bounds.
 *
 * @param {number} maxLen - Maximum character count after trimming.
 * @param {string} label  - Field name used in error messages.
 * @returns {import('zod').ZodString}
 */
function _boundedString(maxLen, label) {
  return z
    .string({ invalid_type_error: `${label} must be a string` })
    .min(1, { message: `${label} must not be empty` })
    .max(maxLen, { message: `${label} must not exceed ${maxLen} characters` })
    .transform((v) => v.trim());
}

/**
 * A URL string bounded to 2048 characters.
 *
 * @param {string} label - Field name used in error messages.
 * @returns {import('zod').ZodEffects}
 */
function boundedUrl(label) {
  return z
    .string({ invalid_type_error: `${label} must be a string` })
    .max(2048, { message: `${label} must not exceed 2048 characters` })
    .url({ message: `${label} must be a valid URL` });
}

/**
 * A finite positive integer within [min, max].
 *
 * @param {number} min - Minimum value (inclusive).
 * @param {number} max - Maximum value (inclusive).
 * @param {string} label - Field name used in error messages.
 * @returns {import('zod').ZodNumber}
 */
function boundedInt(min, max, label) {
  return z
    .number({ invalid_type_error: `${label} must be a number` })
    .int({ message: `${label} must be an integer` })
    .min(min, { message: `${label} must be at least ${min}` })
    .max(max, { message: `${label} must be at most ${max}` });
}

/**
 * A finite positive number within [min, max] (not necessarily an integer).
 *
 * @param {number} min - Minimum value (inclusive).
 * @param {number} max - Maximum value (inclusive).
 * @param {string} label - Field name used in error messages.
 * @returns {import('zod').ZodNumber}
 */
function boundedNumber(min, max, label) {
  return z
    .number({ invalid_type_error: `${label} must be a number` })
    .finite({ message: `${label} must be a finite number` })
    .min(min, { message: `${label} must be at least ${min}` })
    .max(max, { message: `${label} must be at most ${max}` });
}

// -- Webhook config schema ----------------------------------------------------

/**
 * Schema for webhook delivery and retry configuration writes.
 *
 * Fields:
 *  - `url`            � Delivery endpoint (HTTPS URL, max 2048 chars).
 *  - `secret`         � HMAC signing secret (min 16 chars, max 256 chars).
 *  - `events`         � Non-empty array of event-name strings (max 50 items,
 *                       each up to 100 chars).
 *  - `maxRetries`     � Max delivery attempts: integer in [0, 10].
 *  - `timeoutMs`      � Per-attempt timeout: integer in [500, 30000] ms.
 *  - `enabled`        � Boolean toggle (optional, defaults to true).
 *
 * @type {import('zod').ZodObject}
 */
const webhookConfigSchema = z
  .object({
    url: boundedUrl('url'),

    secret: z
      .string({ invalid_type_error: 'secret must be a string' })
      .min(16, { message: 'secret must be at least 16 characters' })
      .max(256, { message: 'secret must not exceed 256 characters' }),

    events: z
      .array(
        z
          .string({ invalid_type_error: 'each event name must be a string' })
          .min(1, { message: 'event name must not be empty' })
          .max(100, { message: 'event name must not exceed 100 characters' }),
        { invalid_type_error: 'events must be an array' },
      )
      .min(1, { message: 'events must contain at least one entry' })
      .max(50, { message: 'events must not exceed 50 entries' }),

    maxRetries: boundedInt(0, 10, 'maxRetries').optional(),

    timeoutMs: boundedInt(500, 30000, 'timeoutMs').optional(),

    enabled: z.boolean({ invalid_type_error: 'enabled must be a boolean' }).optional(),
  })
  .strict(); // reject unknown keys

// -- Reconciliation config schema ---------------------------------------------

/**
 * Schema for reconciliation run scheduling configuration writes.
 *
 * Fields:
 *  - `batchSize`          � Invoices per batch: integer in [1, 500].
 *  - `maxDriftSeconds`    � Acceptable ledger-to-DB drift: integer in [0, 3600].
 *  - `scheduleExpression` � Cron or rate expression (max 100 chars).
 *  - `enabled`            � Boolean toggle (optional).
 *
 * @type {import('zod').ZodObject}
 */
const reconciliationConfigSchema = z
  .object({
    batchSize: boundedInt(1, 500, 'batchSize').optional(),

    maxDriftSeconds: boundedInt(0, 3600, 'maxDriftSeconds').optional(),

    scheduleExpression: z
      .string({ invalid_type_error: 'scheduleExpression must be a string' })
      .min(1, { message: 'scheduleExpression must not be empty' })
      .max(100, { message: 'scheduleExpression must not exceed 100 characters' })
      .optional(),

    enabled: z.boolean({ invalid_type_error: 'enabled must be a boolean' }).optional(),
  })
  .strict()
  .refine((d) => Object.keys(d).length > 0, {
    message: 'At least one reconciliation config field must be provided',
  });

// -- KYC config schema --------------------------------------------------------

/**
 * Schema for KYC provider connection configuration writes.
 *
 * Fields:
 *  - `providerUrl`  � Provider API base URL (HTTPS, max 2048 chars).
 *  - `apiKey`       � Provider API key (min 8 chars, max 256 chars).
 *  - `timeoutMs`    � HTTP timeout for provider calls: integer in [500, 30000] ms.
 *  - `retries`      � Max provider retries: integer in [0, 5].
 *
 * Cross-field rule: `providerUrl` and `apiKey` must both be provided together
 * (or neither if the intent is to clear the configuration via separate logic).
 *
 * @type {import('zod').ZodObject}
 */
const kycConfigSchema = z
  .object({
    providerUrl: boundedUrl('providerUrl'),

    apiKey: z
      .string({ invalid_type_error: 'apiKey must be a string' })
      .min(8, { message: 'apiKey must be at least 8 characters' })
      .max(256, { message: 'apiKey must not exceed 256 characters' }),

    timeoutMs: boundedInt(500, 30000, 'timeoutMs').optional(),

    retries: boundedInt(0, 5, 'retries').optional(),
  })
  .strict();

// -- Retention config schema --------------------------------------------------

/**
 * Schema for data-retention and legal-hold configuration writes.
 *
 * Fields:
 *  - `retentionDays`      � Retention window: integer in [1, 3650] (= 10 years).
 *  - `purgeEnabled`       � Boolean toggle (optional).
 *  - `batchSize`          � Rows per purge batch: integer in [1, 1000].
 *  - `purgeCron`          � Cron expression for scheduled purges (max 100 chars).
 *  - `legalHoldReasons`   � Allowlisted reason codes (max 20 items,
 *                           each string up to 100 chars).
 *
 * @type {import('zod').ZodObject}
 */
const retentionConfigSchema = z
  .object({
    retentionDays: boundedInt(1, 3650, 'retentionDays').optional(),

    purgeEnabled: z.boolean({ invalid_type_error: 'purgeEnabled must be a boolean' }).optional(),

    batchSize: boundedInt(1, 1000, 'batchSize').optional(),

    purgeCron: z
      .string({ invalid_type_error: 'purgeCron must be a string' })
      .min(1, { message: 'purgeCron must not be empty' })
      .max(100, { message: 'purgeCron must not exceed 100 characters' })
      .optional(),

    legalHoldReasons: z
      .array(
        z
          .string({ invalid_type_error: 'each legalHoldReason must be a string' })
          .min(1, { message: 'legalHoldReason must not be empty' })
          .max(100, { message: 'legalHoldReason must not exceed 100 characters' }),
        { invalid_type_error: 'legalHoldReasons must be an array' },
      )
      .max(20, { message: 'legalHoldReasons must not exceed 20 entries' })
      .optional(),
  })
  .strict()
  .refine((d) => Object.keys(d).length > 0, {
    message: 'At least one retention config field must be provided',
  });

// -- CORS config schema ------------------------------------------------------

/**
 * Schema for CORS (Cross-Origin Resource Sharing) configuration writes.
 *
 * Fields:
 *  - `origins`  � Array of allowed origin URLs (max 20 items, each a valid
 *                 URL up to 2048 chars).
 *  - `maxAge`   � Preflight Access-Control-Max-Age in seconds: integer in
 *                 [60, 86400] (min 1 minute, max 24 hours).
 *
 * At least one field must be provided.
 *
 * @type {import('zod').ZodObject}
 */
const corsConfigSchema = z
  .object({
    origins: z
      .array(
        z
          .string({ invalid_type_error: 'each origin must be a string' })
          .url({ message: 'each origin must be a valid URL (e.g. https://app.example.com)' })
          .max(2048, { message: 'each origin must not exceed 2048 characters' })
          .refine((v) => {
            try {
              const url = new URL(v);
              return url.origin === url.href || url.href.endsWith('/') && url.href.slice(0, -1) === url.origin;
            } catch {
              return false;
            }
          }, { message: 'each origin must be a root origin URL without path or query' }),
        { invalid_type_error: 'origins must be an array' },
      )
      .min(1, { message: 'origins must contain at least one entry' })
      .max(20, { message: 'origins must not exceed 20 entries' })
      .optional(),

    maxAge: boundedInt(60, 86400, 'maxAge').optional(),
  })
  .strict()
  .refine((d) => Object.keys(d).length > 0, {
    message: 'At least one CORS config field must be provided',
  });

// -- Fraud thresholds schema --------------------------------------------------

/**
 * Schema for per-tenant fraud and manual-review threshold configuration writes.
 *
 * Fields:
 *  - `fraudCeiling`             � Amounts above this are auto-rejected:
 *                                 finite positive number in [1, 1_000_000_000].
 *  - `manualReviewThreshold`    � Amounts at or above this need human review:
 *                                 finite positive number in [1, 1_000_000_000].
 *
 * Cross-field rule: `manualReviewThreshold` must be = `fraudCeiling` when
 * both fields are supplied, so the manual-review band remains reachable.
 *
 * @type {import('zod').ZodObject}
 */
const fraudThresholdsSchema = z
  .object({
    fraudCeiling: boundedNumber(1, 1_000_000_000, 'fraudCeiling').optional(),

    manualReviewThreshold: boundedNumber(1, 1_000_000_000, 'manualReviewThreshold').optional(),
  })
  .strict()
  .refine((d) => Object.keys(d).length > 0, {
    message: 'At least one fraud threshold field must be provided',
  })
  .superRefine((data, ctx) => {
    if (
      data.fraudCeiling !== undefined &&
      data.manualReviewThreshold !== undefined &&
      data.manualReviewThreshold > data.fraudCeiling
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'manualReviewThreshold must not exceed fraudCeiling',
        path: ['manualReviewThreshold'],
      });
    }
  });

// -- Top-level runtime config schema -----------------------------------------

/**
 * Valid configuration section names accepted by POST /api/admin/config.
 * @type {readonly string[]}
 */
const CONFIG_SECTIONS = /** @type {const} */ ([
  'webhook',
  'reconciliation',
  'kyc',
  'retention',
  'fraudThresholds',
  'cors',
]);

/**
 * Schema for the top-level POST /api/admin/config request body.
 *
 * Shape:
 * ```json
 * {
 *   "section": "webhook",
 *   "config": { ...section-specific fields... }
 * }
 * ```
 *
 * - `section` is an enum of allowed configuration sections.
 * - `config` is validated by the section-specific schema via `.superRefine()`.
 * - Unknown top-level keys are rejected.
 *
 * @type {import('zod').ZodObject}
 */
const runtimeConfigSchema = z
  .object({
    /** The configuration section being written. */
    section: z.enum(
      /** @type {[string, ...string[]]} */ (CONFIG_SECTIONS),
      {
        invalid_type_error: 'section must be a string',
        required_error: 'section is required',
        errorMap: () => ({
          message: `section must be one of: ${CONFIG_SECTIONS.join(', ')}`,
        }),
      },
    ),

    /** Section-specific configuration payload. Validated per-section below. */
    config: z
      .record(z.unknown(), { invalid_type_error: 'config must be an object' })
      .refine((v) => v !== null && typeof v === 'object' && !Array.isArray(v), {
        message: 'config must be a plain object',
      }),
  })
  .strict() // reject unknown top-level keys
  .superRefine((data, ctx) => {
    const sectionSchemas = {
      webhook: webhookConfigSchema,
      reconciliation: reconciliationConfigSchema,
      kyc: kycConfigSchema,
      retention: retentionConfigSchema,
      fraudThresholds: fraudThresholdsSchema,
      cors: corsConfigSchema,
    };

    const sectionSchema = sectionSchemas[data.section];
    if (!sectionSchema) {
      // Enum check above already handles this; belt-and-suspenders guard.
      return;
    }

    const result = sectionSchema.safeParse(data.config);
    if (!result.success) {
      for (const issue of result.error.issues) {
        ctx.addIssue({
          ...issue,
          // Prefix path with "config." so field errors are navigable
          path: ['config', ...issue.path],
        });
      }
    }
  });

// ── Bulk config schema ──────────────────────────────────────────────────────

/**
 * Maximum number of operations allowed in a single bulk config request.
 * Configurable via BULK_CONFIG_MAX_ITEMS env var; defaults to 10.
 * @type {number}
 */
const BULK_CONFIG_MAX_ITEMS = (() => {
  const raw = parseInt(process.env.BULK_CONFIG_MAX_ITEMS || '', 10);
  return Number.isFinite(raw) && raw >= 1 ? raw : 10;
})();

/**
 * Schema for the individual operation item within a bulk config request.
 * Shape: `{ section: string, config: object }`
 *
 * Unlike `runtimeConfigSchema`, this schema does NOT run section-specific
 * validation via `.superRefine()`. Per-item validation is performed in the
 * route handler so that individual failures do not reject the entire batch.
 *
 * @type {import('zod').ZodObject}
 */
const bulkConfigItemSchema = z
  .object({
    section: z.enum(
      /** @type {[string, ...string[]]} */ (CONFIG_SECTIONS),
      {
        invalid_type_error: 'section must be a string',
        required_error: 'section is required',
        errorMap: () => ({
          message: `section must be one of: ${CONFIG_SECTIONS.join(', ')}`,
        }),
      },
    ),
    config: z
      .record(z.unknown(), { invalid_type_error: 'config must be an object' })
      .refine((v) => v !== null && typeof v === 'object' && !Array.isArray(v), {
        message: 'config must be a plain object',
      }),
  })
  .strict();

/**
 * Schema for the POST /api/admin/config/bulk request body.
 *
 * Shape:
 * ```json
 * {
 *   "operations": [
 *     { "section": "webhook", "config": { ... } },
 *     { "section": "cors",    "config": { ... } }
 *   ]
 * }
 * ```
 *
 * - `operations` must contain 1–BULK_CONFIG_MAX_ITEMS items.
 * - Each item must have a valid `section` enum and a `config` object.
 * - Unknown top-level keys are rejected.
 *
 * @type {import('zod').ZodObject}
 */
const bulkConfigSchema = z
  .object({
    operations: z
      .array(bulkConfigItemSchema, {
        invalid_type_error: 'operations must be an array',
        required_error: 'operations is required',
      })
      .min(1, { message: 'operations must contain at least one item' })
      .max(BULK_CONFIG_MAX_ITEMS, {
        message: `operations must not exceed ${BULK_CONFIG_MAX_ITEMS} items`,
      }),
  })
  .strict();

// ── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  // Section schemas (exported for direct use in tests and sub-route validation)
  webhookConfigSchema,
  reconciliationConfigSchema,
  kycConfigSchema,
  retentionConfigSchema,
  fraudThresholdsSchema,
  corsConfigSchema,

  // Top-level schema consumed by the admin config route
  runtimeConfigSchema,

  // Bulk config schema and constants
  bulkConfigSchema,
  bulkConfigItemSchema,
  BULK_CONFIG_MAX_ITEMS,

  // Re-exported helpers
  validateBody,
  parseValidationErrors,

  // Backward-compatible helper
  validateBody,

  // Re-exported constants
  DEFAULT_PROBLEM_TYPE,
  DEFAULT_ERROR_CODE,

  // Constants
  CONFIG_SECTIONS,
};
