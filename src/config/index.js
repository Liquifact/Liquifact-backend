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
const ConfigSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().min(1).max(65535).default(3001),
  JWT_SECRET: z.string().min(32), // No default for security
  CORS_ALLOWED_ORIGINS: z.string().optional(), // Comma-separated, optional for dev fallbacks
  SOROBAN_RPC_URL: z.string().url().default('https://soroban-testnet.stellar.org'),
  NETWORK_PASSPHRASE: z.string().default('Test SDF Network ; September 2015'),
  SOROBAN_BATCH_CONCURRENCY: z.coerce.number().min(1).max(50).default(5),
  SOROBAN_BATCH_TIMEOUT_MS: z.coerce.number().min(100).max(30000).default(5000),
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
    console.error('Config validation failed:', parsed.error.format());
    throw new Error(`Invalid configuration: ${parsed.error.message}`);
  }
  config = parsed.data;
  return config;
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

module.exports = {
  validate,
  get,
  ConfigSchema,
};