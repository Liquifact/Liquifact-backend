/**
 * Environment Configuration Validation Module
 * 
 * Validates required and optional environment variables at startup.
 * Provides secure, actionable error messages without logging sensitive values.
 * 
 * @module config/env
 */

/**
 * Enum for environment variable validation errors.
 * @enum {string}
 */
const ENV_ERRORS = {
  MISSING: 'MISSING',
  INVALID_TYPE: 'INVALID_TYPE',
  INVALID_VALUE: 'INVALID_VALUE',
  INVALID_RANGE: 'INVALID_RANGE',
};

/**
 * Enum for environment variable types.
 * @enum {string}
 */
const ENV_TYPES = {
  STRING: 'string',
  NUMBER: 'number',
  BOOLEAN: 'boolean',
  URL: 'url',
};

/**
 * Schema definition for all environment variables.
 * Each variable specifies its type, whether it's required, default value, and validation rules.
 * @type {Object<string, Object>}
 */
const ENV_SCHEMA = {
  PORT: {
    type: ENV_TYPES.NUMBER,
    required: false,
    default: 3001,
    validate: (value) => {
      if (value < 1 || value > 65535) {
        return { valid: false, error: ENV_ERRORS.INVALID_RANGE, message: 'Port must be between 1 and 65535' };
      }
      return { valid: true };
    },
  },
  NODE_ENV: {
    type: ENV_TYPES.STRING,
    required: false,
    default: 'development',
    validate: (value) => {
      const validEnvs = ['development', 'production', 'test'];
      if (!validEnvs.includes(value)) {
        return {
          valid: false,
          error: ENV_ERRORS.INVALID_VALUE,
          message: `NODE_ENV must be one of: ${validEnvs.join(', ')}`,
        };
      }
      return { valid: true };
    },
  },
  STELLAR_NETWORK: {
    type: ENV_TYPES.STRING,
    required: false,
    default: 'testnet',
    validate: (value) => {
      const validNetworks = ['testnet', 'public'];
      if (!validNetworks.includes(value)) {
        return {
          valid: false,
          error: ENV_ERRORS.INVALID_VALUE,
          message: `STELLAR_NETWORK must be one of: ${validNetworks.join(', ')}`,
        };
      }
      return { valid: true };
    },
  },
  HORIZON_URL: {
    type: ENV_TYPES.URL,
    required: false,
    default: 'https://horizon-testnet.stellar.org',
    validate: (value) => {
      try {
        const url = new URL(value);
        if (!['http:', 'https:'].includes(url.protocol)) {
          return {
            valid: false,
            error: ENV_ERRORS.INVALID_VALUE,
            message: 'HORIZON_URL must use http or https protocol',
          };
        }
        return { valid: true };
      } catch {
        return {
          valid: false,
          error: ENV_ERRORS.INVALID_VALUE,
          message: 'HORIZON_URL must be a valid URL',
        };
      }
    },
  },
  SOROBAN_RPC_URL: {
    type: ENV_TYPES.URL,
    required: false,
    default: 'https://soroban-testnet.stellar.org',
    validate: (value) => {
      try {
        const url = new URL(value);
        if (!['http:', 'https:'].includes(url.protocol)) {
          return {
            valid: false,
            error: ENV_ERRORS.INVALID_VALUE,
            message: 'SOROBAN_RPC_URL must use http or https protocol',
          };
        }
        return { valid: true };
      } catch {
        return {
          valid: false,
          error: ENV_ERRORS.INVALID_VALUE,
          message: 'SOROBAN_RPC_URL must be a valid URL',
        };
      }
    },
  },
  DATABASE_URL: {
    type: ENV_TYPES.URL,
    required: false,
    default: null,
    validate: (value) => {
      if (!value) return { valid: true };
      try {
        const url = new URL(value);
        // Support postgresql, mysql, mongodb protocols
        const validProtocols = ['postgresql:', 'postgres:', 'mysql:', 'mongodb:', 'mongodb+srv:'];
        if (!validProtocols.includes(url.protocol)) {
          return {
            valid: false,
            error: ENV_ERRORS.INVALID_VALUE,
            message: 'DATABASE_URL must use a valid database protocol',
          };
        }
        return { valid: true };
      } catch {
        return {
          valid: false,
          error: ENV_ERRORS.INVALID_VALUE,
          message: 'DATABASE_URL must be a valid database connection URL',
        };
      }
    },
  },
  REDIS_URL: {
    type: ENV_TYPES.URL,
    required: false,
    default: null,
    validate: (value) => {
      if (!value) return { valid: true };
      try {
        const url = new URL(value);
        if (!url.protocol.startsWith('redis')) {
          return {
            valid: false,
            error: ENV_ERRORS.INVALID_VALUE,
            message: 'REDIS_URL must use redis protocol',
          };
        }
        return { valid: true };
      } catch {
        return {
          valid: false,
          error: ENV_ERRORS.INVALID_VALUE,
          message: 'REDIS_URL must be a valid Redis URL',
        };
      }
    },
  },
};

/**
 * Parses a string environment value to the specified type.
 * 
 * @param {string} value - The string value from process.env
 * @param {string} type - The target type from ENV_TYPES
 * @returns {any} The parsed value
 * @throws {Error} If type conversion fails
 */
function parseValue(value, type) {
  if (value === '' || value === null || value === undefined) {
    return null;
  }

  switch (type) {
    case ENV_TYPES.NUMBER:
      const num = Number(value);
      if (Number.isNaN(num)) {
        throw new Error(`Cannot convert to number: "${value}"`);
      }
      return num;

    case ENV_TYPES.BOOLEAN:
      if (['true', '1', 'yes', 'on'].includes(value.toLowerCase())) {
        return true;
      }
      if (['false', '0', 'no', 'off'].includes(value.toLowerCase())) {
        return false;
      }
      throw new Error(`Cannot convert to boolean: "${value}"`);

    case ENV_TYPES.URL:
      // Trim whitespace for URLs, treat whitespace-only as null
      const trimmed = String(value).trim();
      if (!trimmed) {
        return null;
      }
      return trimmed;

    case ENV_TYPES.STRING:
      return String(value);

    default:
      return value;
  }
}

/**
 * Validates a single environment variable against its schema.
 * 
 * @param {string} key - The environment variable name
 * @param {string} value - The environment variable value
 * @param {Object} schema - The schema definition for this variable
 * @returns {Object} { valid: boolean, value: any, error?: string, message?: string }
 */
function validateVariable(key, value, schema) {
  // Check if required variable is missing
  if (schema.required && (value === undefined || value === '' || value === null)) {
    return {
      valid: false,
      error: ENV_ERRORS.MISSING,
      message: `Missing required environment variable: ${key}`,
    };
  }

  // Use default if not provided
  if (value === undefined || value === '' || value === null) {
    if (schema.default !== undefined && schema.default !== null) {
      return { valid: true, value: schema.default };
    }
    return { valid: true, value: null };
  }

  // Parse the value to the correct type
  let parsedValue;
  try {
    parsedValue = parseValue(value, schema.type);
  } catch (e) {
    return {
      valid: false,
      error: ENV_ERRORS.INVALID_TYPE,
      message: `Invalid type for ${key}: ${e.message}`,
    };
  }

  // Skip validation for null values when not required
  if (parsedValue === null && !schema.required) {
    return { valid: true, value: null };
  }

  // Run custom validation if provided
  if (schema.validate && parsedValue !== null) {
    const validationResult = schema.validate(parsedValue);
    if (!validationResult.valid) {
      return {
        valid: false,
        error: validationResult.error,
        message: validationResult.message,
      };
    }
  }

  return { valid: true, value: parsedValue };
}

/**
 * Validates all environment variables against the schema.
 * Throws an error with actionable message if validation fails.
 * 
 * Security Note:
 * - Sensitive values (DATABASE_URL, REDIS_URL, API keys) are NEVER logged
 * - Error messages contain only variable names and type info, not values
 * - Use stderr for failures to avoid logging to stdout
 * 
 * @param {Object} [env=process.env] - The environment object to validate (defaults to process.env)
 * @returns {Object} The validated and parsed environment configuration
 * @throws {Error} If validation fails, with detailed actionable message
 */
function validateEnv(env = process.env) {
  const validationErrors = [];
  const config = {};

  Object.entries(ENV_SCHEMA).forEach(([key, schema]) => {
    const value = env[key];
    const validation = validateVariable(key, value, schema);

    if (!validation.valid) {
      validationErrors.push({
        key,
        error: validation.error,
        message: validation.message,
      });
    } else {
      config[key] = validation.value;
    }
  });

  // If there are errors, throw with detailed message
  if (validationErrors.length > 0) {
    const errorMessages = validationErrors
      .map((err) => `  • ${err.message}`)
      .join('\n');

    const error = new Error(
      `Environment validation failed:\n${errorMessages}\n\nPlease check your environment configuration.`
    );
    error.name = 'EnvironmentValidationError';
    error.details = validationErrors;
    throw error;
  }

  return config;
}

/**
 * Gets the environment validation schema for documentation purposes.
 * 
 * @returns {Object} A copy of the ENV_SCHEMA
 */
function getEnvSchema() {
  return { ...ENV_SCHEMA };
}

/**
 * Generates markdown documentation for environment variables.
 * 
 * @returns {string} Markdown formatted environment variable documentation
 */
function generateEnvDocumentation() {
  let doc = '### Environment Variables\n\n';
  doc += '| Variable | Type | Required | Default | Description |\n';
  doc += '|----------|------|----------|---------|-------------|\n';

  Object.entries(ENV_SCHEMA).forEach(([key, schema]) => {
    const type = schema.type;
    const required = schema.required ? 'Yes' : 'No';
    const defaultValue = schema.default !== null ? `\`${schema.default}\`` : 'N/A';
    const description = getVariableDescription(key);

    doc += `| \`${key}\` | ${type} | ${required} | ${defaultValue} | ${description} |\n`;
  });

  return doc;
}

/**
 * Returns a human-readable description for each environment variable.
 * 
 * @param {string} key - The environment variable name
 * @returns {string} Description of the variable
 */
function getVariableDescription(key) {
  const descriptions = {
    PORT: 'HTTP server port (1-65535)',
    NODE_ENV: 'Runtime environment (development, production, test)',
    STELLAR_NETWORK: 'Stellar network (testnet, public)',
    HORIZON_URL: 'Horizon API base URL',
    SOROBAN_RPC_URL: 'Soroban RPC endpoint URL',
    DATABASE_URL: 'PostgreSQL database connection URL (optional)',
    REDIS_URL: 'Redis cache connection URL (optional)',
  };

  return descriptions[key] || 'No description available';
}

module.exports = {
  // Main validation function
  validateEnv,

  // Export schema and utilities for testing
  getEnvSchema,
  generateEnvDocumentation,
  parseValue,
  validateVariable,

  // Export enums for testing and documentation
  ENV_ERRORS,
  ENV_TYPES,
  ENV_SCHEMA,
};
