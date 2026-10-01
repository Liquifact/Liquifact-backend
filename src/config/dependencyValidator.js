'use strict';

const z = require('zod');

/**
 * Configuration invariants for the backend runtime.
 *
 * This module owns the validation of environment dependencies that the
 * application relies on at startup. The goal is to fail fast and deterministically
 * when the configuration would lead to an unsafe or inconsistent state.
 *
 * Invariants:
 *   1. Production requires a database URL with credentials.
 *   2. Redis must use the redis:/rediss: protocol and must be present when the
 *      escrow cache is enabled.
 *   3. Storage backends must not conflict (in-memory vs. AWS credentials) and
 *      AWS credentials must be provided as a pair.
 *   4. Custodial escrow signing requires a platform secret.
 *
 * The validator is pure and side-effect free: given the same input it always
 * produces the same result. This makes it safe to retry and to run concurrently.
 */

const NODE_ENVS = ['development', 'production', 'test'];
const ESCRO_SIGNING_MODES = ['delegated', 'custodial', 'stubbed'];

const booleanString = z.enum(['true', 'false']);

const DependencyConfigSchema = z.object({
  NODE_ENV: z.enum(NODE_ENVS).default('development'),
  DATABASE_URL: z.string().url().optional(),
  REDIS_URL: z.string().url().optional(),
  REDIS_ESCRO_CACHE_ENABLED: booleanString.default('false'),
  STORAGE_IN_MEMORY: booleanString.optional(),
  AWS_ACCESS_KEY_ID: z.string().min(1).optional(),
  AWS_SECRET_ACCESS_KEY: z.string().min(1).optional(),
  ESCROW_SIGNING_MODE: z.enum(ESCRO_SIGNING_MODES).default('stubbed'),
  ESCRO_PLATFORM_SECRET: z.string().min(1).optional(),
})
  .strict()
  .superRefine((data, ctx) => {
    const isProd = data.NODE_ENV === 'production';
    const isTest = data.NODE_ENV === 'test';

    // 1. Database: missing required variable & credentials
    if (isProd && !data.DATABASE_URL) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'DATABASE_URL is required in production.',
        path: ['DATABASE_URL'],
      });
    } else if (data.DATABASE_URL) {
      try {
        const url = new URL(data.DATABASE_URL);
        if (isProd && (!url.username || !url.password)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'DATABASE_URL must include credentials in production.',
            path: ['DATABASE_URL'],
          });
        }
      } catch (_) {
        // Handled by z.string().url()
      }
    }

    // 2. Redis: invalid URL & optional dependency absent
    if (data.REDIS_URL) {
      try {
        const redisUrl = new URL(data.REDIS_URL);
        if (redisUrl.protocol !== 'redis:' && redisUrl.protocol !== 'rediss:') {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'REDIS_URL must use redis: or rediss: protocol.',
            path: ['REDIS_URL'],
          });
        }
      } catch (_) {
        // Handled by z.string().url()
      }
    }

    if (data.REDIS_ESCRO_CACHE_ENABLED === 'true' && !data.REDIS_URL) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'REDIS_URL is required when REDIS_ESCRO_CACHE_ENABLED is true.',
        path: ['REDIS_URL'],
      });
    }

    // 3. Storage: conflicting flags
    if (data.STORAGE_IN_MEMORY === 'true') {
      if (data.AWS_ACCESS_KEY_ID || data.AWS_SECRET_ACCESS_KEY) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'STORAGE_IN_MEMORY cannot be true when AWS credentials are provided.',
          path: ['STORAGE_IN_MEMORY'],
        });
      }
    } else if (!isTest) {
      if ((data.AWS_ACCESS_KEY_ID && !data.AWS_SECRET_ACCESS_KEY) || (!data.AWS_ACCESS_KEY_ID && data.AWS_SECRET_ACCESS_KEY)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Both AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY must be provided together.',
          path: data.AWS_ACCESS_KEY_ID ? ['AWS_SECRET_ACCESS_KEY'] : ['AWS_ACCESS_KEY_ID'],
        });
      }
    }

    // 4. Escrow: required secret for custodial mode
    if (data.ESCRO_SIGNING_MODE === 'custodial' && !data.ESCRO_PLATFORM_SECRET) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'ESCRO_PLATFORM_SECRET is required when ESCRO_SIGNING_MODE is custodial.',
        path: ['ESCRO_PLATFORM_SECRET'],
      });
    }
  });

/**
 * Validate the current process environment against the dependency schema.
 *
 * Throws a zod error on failure so the application can fail fast during startup.
 * Returns the parsed and normalized configuration on success.
 */
function validateDependencies(env = process.env) {
  const parsed = DependencyConfigSchema.safeParse(env);
  if (!parsed.success) {
    throw parsed.error;
  }
  return parsed.data;
}

module.exports = {
  DependencyConfigSchema,
  validateDependencies,
};
