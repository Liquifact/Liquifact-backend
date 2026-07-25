/**
 * Centralized typed configuration module with runtime validation.
 * Uses Zod for schema validation and type safety.
 * @module config
 */

const z = require('zod');

/**
 * Complete configuration schema with defaults and validation.
 * Secrets have no defaults - must be provided.
 * @type {z.ZodObject<any>}
 */
const ConfigSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
    PORT: z.coerce.number().min(1).max(65535).default(3001),
    JWT_SECRET: z.string().min(32), // No default for security
    JWT_ALGORITHMS: z.string().optional().default('HS256'), // Comma-separated allowlist, e.g. HS256,RS256
    JWT_ISSUER: z.string().optional(), // Optional issuer claim to enforce
    JWT_AUDIENCE: z.string().optional(), // Optional audience claim to enforce
    CURSOR_SECRET: z.string().min(32).optional(), // Dedicated marketplace cursor HMAC secret
    CURSOR_TTL_ENABLED: z.enum(['true', 'false']).default('false'),
    CURSOR_TTL_SECONDS: z.coerce.number().int().min(1).default(3600),
    CORS_ALLOWED_ORIGINS: z.string().optional(), // Comma-separated, optional for dev fallbacks
    SOROBAN_RPC_URL: z.string().url().default('https://soroban-testnet.stellar.org'),
    NETWORK_PASSPHRASE: z.string().default('Test SDF Network ; September 2015'),
    SOROBAN_BATCH_CONCURRENCY: z.coerce.number().min(1).max(50).default(5),
    SOROBAN_BATCH_TIMEOUT_MS: z.coerce.number().min(100).max(30000).default(5000),
    // Escrow indexer configuration
    ESCROW_INDEXER_ENABLED: z.enum(['true', 'false']).default('false'),
    ESCROW_INDEXER_STALE_THRESHOLD_SECONDS: z.coerce.number().min(1).default(300),
    // Graceful shutdown configuration
    SHUTDOWN_TIMEOUT_MS: z.coerce.number().min(0).default(10000),
    // KYC provider — all optional, but URL+key must be provided together in non-test envs.
    // Issue #592 adds bounded numeric knobs so a typo cannot disable timeouts or make
    // retries unbounded.
    KYC_PROVIDER_URL: z.string().url().optional(),
    KYC_PROVIDER_API_KEY: z.string().min(1).optional(),
    KYC_PROVIDER_SECRET: z.string().min(1).optional(),
    // Issue #592 — KYC provider transport hardening. Numeric knobs are clamped
    // so a typo cannot disable the timeout, exhaust retries, or hang the breaker.
    KYC_PROVIDER_TIMEOUT_MS: z.coerce.number().min(100).max(30000).default(5000),
    KYC_PROVIDER_MAX_RETRIES: z.coerce.number().min(0).max(10).default(3),
    KYC_PROVIDER_BASE_DELAY_MS: z.coerce.number().min(0).max(10000).default(200),
    KYC_PROVIDER_MAX_DELAY_MS: z.coerce.number().min(0).max(60000).default(5000),
    KYC_PROVIDER_SIGN_REQUESTS: z.enum(['true', 'false']).default('false'),
    KYC_PROVIDER_VERIFY_RESPONSE_SIGNATURE: z.enum(['true', 'false']).default('false'),
    KYC_PROVIDER_CB_FAILURE_THRESHOLD: z.coerce.number().min(1).max(100).default(5),
    KYC_PROVIDER_CB_RECOVERY_TIMEOUT_MS: z.coerce.number().min(100).max(60000).default(10000),
    // Public base URL for the API, used in the OpenAPI spec servers array.
    // Required in production and must use HTTPS. Falls back to localhost in development/test.
    PUBLIC_API_BASE_URL: z.string().url().optional(),
  })
  .superRefine((data, ctx) => {
    if (data.NODE_ENV === 'test') { return; }
    if (data.NODE_ENV === 'production' && !data.CURSOR_SECRET && !data.JWT_SECRET) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'CURSOR_SECRET or JWT_SECRET must be configured in production.',
        path: ['CURSOR_SECRET'],
      });
    }
    const hasUrl = Boolean(data.KYC_PROVIDER_URL);
    const hasKey = Boolean(data.KYC_PROVIDER_API_KEY);
    if (hasUrl !== hasKey) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'KYC_PROVIDER_URL and KYC_PROVIDER_API_KEY must both be set or both be absent.',
        path: hasUrl ? ['KYC_PROVIDER_API_KEY'] : ['KYC_PROVIDER_URL'],
      });
    }
    if (data.NODE_ENV === 'production') {
      const baseUrl = data.PUBLIC_API_BASE_URL;
      // Require the variable to be present in production
      if (!baseUrl) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            'PUBLIC_API_BASE_URL must be set in production. It is used in the OpenAPI spec servers array.',
          path: ['PUBLIC_API_BASE_URL'],
        });
        return;
      }
      // Require HTTPS — never allow plaintext in production
      let parsed;
      try { parsed = new URL(baseUrl); } catch (_) { parsed = null; }
      if (!parsed || parsed.protocol !== 'https:') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            'PUBLIC_API_BASE_URL must use HTTPS in production.',
          path: ['PUBLIC_API_BASE_URL'],
        });
        return;
      }
      // Reject loopback addresses (127.x.x.x, ::1, [::1], localhost)
      const loopbackPattern = /^(localhost|127(?:\.\d+){3}|::1|\[::1\])$/i;
      if (loopbackPattern.test(parsed.hostname)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            'PUBLIC_API_BASE_URL must not be a loopback address in production.',
          path: ['PUBLIC_API_BASE_URL'],
        });
      }
    }
  });

/**
 * Runtime validated configuration object.
 * @type {z.infer<typeof ConfigSchema>}
 */
let config;

/**
 * Validates environment variables against schema and returns typed config.
 * Throws ZodError on validation failure.
 * Should be called once early in app bootstrap.
 * @returns {z.infer<typeof ConfigSchema>} Validated config.
 */
function validate() {
  const parsed = ConfigSchema.safeParse(process.env);
  if (!parsed.success) {
    throw parsed.error;
  }
  config = parsed.data;
  return config;
}

/**
 * Format and log a redacted summary of validation issues to console.error.
 * Never prints secret values (only key names and validation error messages).
 * @param {z.ZodError} error - The Zod error to summarize.
 * @returns {void}
 */
function logRedactedSummary(error) {
  console.error('Configuration validation failed:');
  if (error && Array.isArray(error.issues)) {
    error.issues.forEach(issue => {
      const key = issue.path.join('.');
      console.error(`- [${key}]: ${issue.message}`);
    });
  } else {
    console.error(error ? error.message : 'Unknown configuration error');
  }
}

/**
 * Getter for validated config. Throws if not validated.
 * @returns {z.infer<typeof ConfigSchema>}
 */
function get() {
  if (!config) {
    throw new Error('Config not validated. Call validate() first.');
  }
  return config;
}

const securityHeaders = {
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'"],
      imgSrc: ["'self'", "data:"],
      connectSrc: ["'self'"],
      fontSrc: ["'self'"],
      objectSrc: ["'none'"],
      mediaSrc: ["'self'"],
      frameSrc: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"]
    }
  },
  referrerPolicy: { policy: 'no-referrer' },
  hsts: { maxAge: 31536000, includeSubDomains: true, preload: true },
  // Less restrictive CSP for Swagger UI docs
  docsContentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:"],
      connectSrc: ["'self'"],
      fontSrc: ["'self'"],
      objectSrc: ["'none'"],
      mediaSrc: ["'self'"],
      frameSrc: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"]
    }
  }
};

module.exports = {
  validate,
  get,
  logRedactedSummary,
  ConfigSchema,
  securityHeaders,
};
