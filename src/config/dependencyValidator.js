const z = require('zod');

const DependencyConfigSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  DATABASE_URL: z.string().url().optional(),
  REDIS_URL: z.string().url().optional(),
  REDIS_ESCROW_CACHE_ENABLED: z.enum(['true', 'false']).default('false'),
  STORAGE_IN_MEMORY: z.enum(['true', 'false']).optional(),
  AWS_ACCESS_KEY_ID: z.string().optional(),
  AWS_SECRET_ACCESS_KEY: z.string().optional(),
  ESCROW_SIGNING_MODE: z.enum(['delegated', 'custodial', 'stubbed']).default('stubbed'),
  ESCROW_PLATFORM_SECRET: z.string().optional(),
}).superRefine((data, ctx) => {
  const isProd = data.NODE_ENV === 'production';

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

  if (data.REDIS_ESCROW_CACHE_ENABLED === 'true' && !data.REDIS_URL) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'REDIS_URL is required when REDIS_ESCROW_CACHE_ENABLED is true.',
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
  } else if (data.NODE_ENV !== 'test') {
    if ((data.AWS_ACCESS_KEY_ID && !data.AWS_SECRET_ACCESS_KEY) || (!data.AWS_ACCESS_KEY_ID && data.AWS_SECRET_ACCESS_KEY)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Both AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY must be provided together.',
        path: data.AWS_ACCESS_KEY_ID ? ['AWS_SECRET_ACCESS_KEY'] : ['AWS_ACCESS_KEY_ID'],
      });
    }
  }

  // 4. Escrow: required secret for custodial mode
  if (data.ESCROW_SIGNING_MODE === 'custodial' && !data.ESCROW_PLATFORM_SECRET) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'ESCROW_PLATFORM_SECRET is required when ESCROW_SIGNING_MODE is custodial.',
      path: ['ESCROW_PLATFORM_SECRET'],
    });
  }
});

function validateDependencies() {
  const parsed = DependencyConfigSchema.safeParse(process.env);
  if (!parsed.success) {
    throw parsed.error;
  }
  return parsed.data;
}

module.exports = {
  DependencyConfigSchema,
  validateDependencies,
};
