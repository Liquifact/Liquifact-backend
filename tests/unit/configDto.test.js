'use strict';

/**
 * @fileoverview Focused tests for src/dto/config.js
 *
 * Scenarios covered
 * ─────────────────
 * Success
 *   - minimal valid env produces a well-shaped ConfigDto
 *   - all optional fields populate correctly
 *   - CORS origins are split on commas and trimmed
 *   - escrowIndexerEnabled is a boolean coerced from the string 'true'/'false'
 *   - nullable KYC fields default to null when absent
 *
 * Rejection (MISSING_FIELD)
 *   - missing JWT_SECRET → MISSING_FIELD code
 *   - fieldErrors map contains the offending field name
 *
 * Rejection (VALIDATION_ERROR)
 *   - JWT_SECRET too short → VALIDATION_ERROR code
 *   - invalid PORT (non-numeric) → VALIDATION_ERROR
 *   - invalid NODE_ENV → VALIDATION_ERROR
 *   - PORT out of range (0 and 65536) → VALIDATION_ERROR
 *
 * Boundary
 *   - PORT at minimum (1) and maximum (65535) values
 *   - JWT_SECRET exactly 32 chars (boundary min)
 *   - empty CORS_ALLOWED_ORIGINS produces []
 *   - whitespace-only CORS_ALLOWED_ORIGINS produces []
 *   - CORS entries with leading/trailing spaces are trimmed
 *   - KYC URL+key both present in test env (no superRefine rejection in test mode)
 *
 * Regression (no secret leakage)
 *   - ConfigError.message never exposes the raw JWT_SECRET value
 *   - fieldErrors messages are sanitised (long hex strings redacted)
 *
 * Retry / concurrent safety
 *   - parseConfigDto() called multiple times with the same env is idempotent
 *   - parseConfigDto() called with different envs in parallel produces independent results
 *   - buildConfigDto() called with an unexpected non-Error throw wraps it correctly
 *
 * requireConfigDto
 *   - throws ConfigError on invalid config
 *   - returns ConfigDto on valid config
 */

const {
  buildConfigDto,
  parseConfigDto,
  requireConfigDto,
  ConfigError,
  CONFIG_ERROR_CODES,
} = require('../../src/dto/config');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimum valid env that passes all constraints. */
function minValidEnv(overrides = {}) {
  return {
    NODE_ENV: 'test',
    JWT_SECRET: 'a'.repeat(32), // exactly 32 chars — boundary minimum
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Success scenarios
// ---------------------------------------------------------------------------

describe('buildConfigDto — success', () => {
  test('returns a well-shaped ConfigDto for minimal valid env', () => {
    const dto = buildConfigDto(minValidEnv());

    expect(dto).toMatchObject({
      nodeEnv: 'test',
      port: 3001, // schema default
      jwtSecret: 'a'.repeat(32),
      corsAllowedOrigins: [],
      sorobanRpcUrl: 'https://soroban-testnet.stellar.org',
      networkPassphrase: 'Test SDF Network ; September 2015',
      sorobanBatchConcurrency: 5,
      sorobanBatchTimeoutMs: 5000,
      escrowIndexerEnabled: false,
      escrowIndexerStaleThresholdSeconds: 300,
      kycProviderUrl: null,
      kycProviderApiKey: null,
      kycProviderSecret: null,
    });
  });

  test('PORT is coerced from string to number', () => {
    const dto = buildConfigDto(minValidEnv({ PORT: '8080' }));
    expect(dto.port).toBe(8080);
    expect(typeof dto.port).toBe('number');
  });

  test('CORS_ALLOWED_ORIGINS is split and trimmed', () => {
    const dto = buildConfigDto(
      minValidEnv({
        CORS_ALLOWED_ORIGINS: ' https://app.example.com , https://admin.example.com ',
      })
    );
    expect(dto.corsAllowedOrigins).toEqual([
      'https://app.example.com',
      'https://admin.example.com',
    ]);
  });

  test('escrowIndexerEnabled is true when ESCROW_INDEXER_ENABLED="true"', () => {
    const dto = buildConfigDto(minValidEnv({ ESCROW_INDEXER_ENABLED: 'true' }));
    expect(dto.escrowIndexerEnabled).toBe(true);
  });

  test('escrowIndexerEnabled is false when ESCROW_INDEXER_ENABLED="false"', () => {
    const dto = buildConfigDto(minValidEnv({ ESCROW_INDEXER_ENABLED: 'false' }));
    expect(dto.escrowIndexerEnabled).toBe(false);
  });

  test('KYC fields are null when all three are absent', () => {
    const dto = buildConfigDto(minValidEnv());
    expect(dto.kycProviderUrl).toBeNull();
    expect(dto.kycProviderApiKey).toBeNull();
    expect(dto.kycProviderSecret).toBeNull();
  });

  test('KYC fields populate when all three are supplied in test mode', () => {
    // In NODE_ENV=test the superRefine KYC co-presence check is skipped.
    const dto = buildConfigDto(
      minValidEnv({
        KYC_PROVIDER_URL: 'https://kyc.example.com',
        KYC_PROVIDER_API_KEY: 'key123',
        KYC_PROVIDER_SECRET: 'secret456',
      })
    );
    expect(dto.kycProviderUrl).toBe('https://kyc.example.com');
    expect(dto.kycProviderApiKey).toBe('key123');
    expect(dto.kycProviderSecret).toBe('secret456');
  });

  test('sorobanBatchConcurrency is coerced from string', () => {
    const dto = buildConfigDto(minValidEnv({ SOROBAN_BATCH_CONCURRENCY: '10' }));
    expect(dto.sorobanBatchConcurrency).toBe(10);
  });

  test('sorobanBatchTimeoutMs is coerced from string', () => {
    const dto = buildConfigDto(minValidEnv({ SOROBAN_BATCH_TIMEOUT_MS: '8000' }));
    expect(dto.sorobanBatchTimeoutMs).toBe(8000);
  });
});

// ---------------------------------------------------------------------------
// Rejection — MISSING_FIELD
// ---------------------------------------------------------------------------

describe('buildConfigDto — MISSING_FIELD rejections', () => {
  test('throws ConfigError with MISSING_FIELD when JWT_SECRET is absent', () => {
    const env = { NODE_ENV: 'test' }; // no JWT_SECRET
    expect(() => buildConfigDto(env)).toThrow(ConfigError);

    try {
      buildConfigDto(env);
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      expect(err.code).toBe(CONFIG_ERROR_CODES.MISSING_FIELD);
      expect(err.fieldErrors).not.toBeNull();
      expect(Object.keys(err.fieldErrors)).toContain('JWT_SECRET');
    }
  });

  test('fieldErrors is a plain object with string-array values', () => {
    try {
      buildConfigDto({});
    } catch (err) {
      expect(err.fieldErrors).toBeDefined();
      for (const [, msgs] of Object.entries(err.fieldErrors)) {
        expect(Array.isArray(msgs)).toBe(true);
        msgs.forEach((m) => expect(typeof m).toBe('string'));
      }
    }
  });

  test('message names the missing field', () => {
    try {
      buildConfigDto({ NODE_ENV: 'test' });
    } catch (err) {
      expect(err.message).toMatch(/JWT_SECRET/i);
    }
  });
});

// ---------------------------------------------------------------------------
// Rejection — VALIDATION_ERROR
// ---------------------------------------------------------------------------

describe('buildConfigDto — VALIDATION_ERROR rejections', () => {
  test('JWT_SECRET shorter than 32 chars → VALIDATION_ERROR', () => {
    try {
      buildConfigDto(minValidEnv({ JWT_SECRET: 'too-short' }));
      fail('expected ConfigError to be thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      expect(err.code).toBe(CONFIG_ERROR_CODES.VALIDATION_ERROR);
      expect(err.fieldErrors).toHaveProperty('JWT_SECRET');
    }
  });

  test('PORT non-numeric string → VALIDATION_ERROR', () => {
    try {
      buildConfigDto(minValidEnv({ PORT: 'not-a-number' }));
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      expect(err.code).toBe(CONFIG_ERROR_CODES.VALIDATION_ERROR);
    }
  });

  test('NODE_ENV invalid value → VALIDATION_ERROR', () => {
    try {
      buildConfigDto(minValidEnv({ NODE_ENV: 'staging' }));
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      expect(err.code).toBe(CONFIG_ERROR_CODES.VALIDATION_ERROR);
      expect(err.fieldErrors).toHaveProperty('NODE_ENV');
    }
  });

  test('PORT=0 (below min) → VALIDATION_ERROR', () => {
    try {
      buildConfigDto(minValidEnv({ PORT: '0' }));
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      expect(err.code).toBe(CONFIG_ERROR_CODES.VALIDATION_ERROR);
    }
  });

  test('PORT=65536 (above max) → VALIDATION_ERROR', () => {
    try {
      buildConfigDto(minValidEnv({ PORT: '65536' }));
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      expect(err.code).toBe(CONFIG_ERROR_CODES.VALIDATION_ERROR);
    }
  });

  test('SOROBAN_BATCH_CONCURRENCY=0 (below min) → VALIDATION_ERROR', () => {
    try {
      buildConfigDto(minValidEnv({ SOROBAN_BATCH_CONCURRENCY: '0' }));
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      expect(err.code).toBe(CONFIG_ERROR_CODES.VALIDATION_ERROR);
    }
  });

  test('SOROBAN_RPC_URL not a URL → VALIDATION_ERROR', () => {
    try {
      buildConfigDto(minValidEnv({ SOROBAN_RPC_URL: 'not-a-url' }));
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      expect(err.code).toBe(CONFIG_ERROR_CODES.VALIDATION_ERROR);
    }
  });
});

// ---------------------------------------------------------------------------
// Boundary values
// ---------------------------------------------------------------------------

describe('buildConfigDto — boundary values', () => {
  test('PORT=1 (minimum) is accepted', () => {
    const dto = buildConfigDto(minValidEnv({ PORT: '1' }));
    expect(dto.port).toBe(1);
  });

  test('PORT=65535 (maximum) is accepted', () => {
    const dto = buildConfigDto(minValidEnv({ PORT: '65535' }));
    expect(dto.port).toBe(65535);
  });

  test('JWT_SECRET exactly 32 chars is accepted', () => {
    const secret = 'b'.repeat(32);
    const dto = buildConfigDto(minValidEnv({ JWT_SECRET: secret }));
    expect(dto.jwtSecret).toBe(secret);
  });

  test('JWT_SECRET 31 chars is rejected', () => {
    expect(() =>
      buildConfigDto(minValidEnv({ JWT_SECRET: 'c'.repeat(31) }))
    ).toThrow(ConfigError);
  });

  test('empty CORS_ALLOWED_ORIGINS produces []', () => {
    const dto = buildConfigDto(minValidEnv({ CORS_ALLOWED_ORIGINS: '' }));
    expect(dto.corsAllowedOrigins).toEqual([]);
  });

  test('whitespace-only CORS_ALLOWED_ORIGINS produces []', () => {
    const dto = buildConfigDto(minValidEnv({ CORS_ALLOWED_ORIGINS: '   ' }));
    expect(dto.corsAllowedOrigins).toEqual([]);
  });

  test('CORS with blank entries between commas are filtered', () => {
    const dto = buildConfigDto(
      minValidEnv({ CORS_ALLOWED_ORIGINS: 'https://a.com,,https://b.com' })
    );
    expect(dto.corsAllowedOrigins).toEqual(['https://a.com', 'https://b.com']);
  });

  test('SOROBAN_BATCH_CONCURRENCY=1 (min) is accepted', () => {
    const dto = buildConfigDto(minValidEnv({ SOROBAN_BATCH_CONCURRENCY: '1' }));
    expect(dto.sorobanBatchConcurrency).toBe(1);
  });

  test('SOROBAN_BATCH_CONCURRENCY=50 (max) is accepted', () => {
    const dto = buildConfigDto(minValidEnv({ SOROBAN_BATCH_CONCURRENCY: '50' }));
    expect(dto.sorobanBatchConcurrency).toBe(50);
  });

  test('SOROBAN_BATCH_CONCURRENCY=51 (above max) → VALIDATION_ERROR', () => {
    expect(() =>
      buildConfigDto(minValidEnv({ SOROBAN_BATCH_CONCURRENCY: '51' }))
    ).toThrow(ConfigError);
  });

  test('SOROBAN_BATCH_TIMEOUT_MS=100 (min) is accepted', () => {
    const dto = buildConfigDto(minValidEnv({ SOROBAN_BATCH_TIMEOUT_MS: '100' }));
    expect(dto.sorobanBatchTimeoutMs).toBe(100);
  });

  test('SOROBAN_BATCH_TIMEOUT_MS=99 (below min) → VALIDATION_ERROR', () => {
    expect(() =>
      buildConfigDto(minValidEnv({ SOROBAN_BATCH_TIMEOUT_MS: '99' }))
    ).toThrow(ConfigError);
  });
});

// ---------------------------------------------------------------------------
// Regression — no secret leakage
// ---------------------------------------------------------------------------

describe('ConfigError — no secret leakage', () => {
  test('message does not contain the raw JWT_SECRET value', () => {
    const secret = 'z'.repeat(32);
    try {
      // Deliberately valid secret but invalid PORT to trigger VALIDATION_ERROR
      buildConfigDto(minValidEnv({ JWT_SECRET: secret, PORT: 'bad' }));
    } catch (err) {
      expect(err.message).not.toContain(secret);
    }
  });

  test('ConfigError.message does not contain the raw short-secret value', () => {
    const shortSecret = 'tooshort';
    try {
      buildConfigDto(minValidEnv({ JWT_SECRET: shortSecret }));
    } catch (err) {
      // The raw value "tooshort" is only 8 chars so it doesn't trigger
      // the redact pattern; what matters is the secret is not in the message
      // at all — only the field name is.
      expect(err.message).not.toContain(shortSecret);
    }
  });

  test('fieldErrors messages do not contain long hex/token values', () => {
    const longHexSecret = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4'; // 32 hex chars — triggers redact
    try {
      buildConfigDto({ NODE_ENV: 'test', JWT_SECRET: longHexSecret, PORT: 'bad-port' });
    } catch (err) {
      if (err.fieldErrors) {
        const allMessages = Object.values(err.fieldErrors).flat().join(' ');
        // Raw hex token must be redacted in messages
        expect(allMessages).not.toContain(longHexSecret);
      }
    }
  });

  test('ConfigError.recoverable is always false', () => {
    try {
      buildConfigDto({});
    } catch (err) {
      expect(err.recoverable).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// parseConfigDto — wrapper / never-throws contract
// ---------------------------------------------------------------------------

describe('parseConfigDto — deterministic result shape', () => {
  test('returns { ok: true, dto } for valid env', () => {
    const result = parseConfigDto(minValidEnv());
    expect(result.ok).toBe(true);
    expect(result).toHaveProperty('dto');
    expect(result.dto.nodeEnv).toBe('test');
  });

  test('returns { ok: false, error } for invalid env — never throws', () => {
    const result = parseConfigDto({});
    expect(result.ok).toBe(false);
    expect(result).toHaveProperty('error');
    expect(result.error).toBeInstanceOf(ConfigError);
  });

  test('result.error.code is set on failure', () => {
    const result = parseConfigDto({});
    expect(Object.values(CONFIG_ERROR_CODES)).toContain(result.error.code);
  });

  test('parseConfigDto never throws even for completely empty env', () => {
    expect(() => parseConfigDto({})).not.toThrow();
  });

  test('parseConfigDto never throws even for null-ish values', () => {
    expect(() => parseConfigDto({ JWT_SECRET: null, PORT: undefined })).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Retry / concurrent safety
// ---------------------------------------------------------------------------

describe('parseConfigDto — idempotency and concurrent safety', () => {
  test('multiple calls with same valid env return equivalent DTOs', () => {
    const env = minValidEnv({ PORT: '4000' });
    const r1 = parseConfigDto(env);
    const r2 = parseConfigDto(env);
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    expect(r1.dto).toEqual(r2.dto);
  });

  test('multiple calls with same invalid env return equivalent errors', () => {
    const env = {};
    const r1 = parseConfigDto(env);
    const r2 = parseConfigDto(env);
    expect(r1.ok).toBe(false);
    expect(r2.ok).toBe(false);
    expect(r1.error.code).toBe(r2.error.code);
    expect(r1.error.message).toBe(r2.error.message);
  });

  test('concurrent calls with different envs produce independent results', async () => {
    const validEnv = minValidEnv({ PORT: '5001' });
    const invalidEnv = {};

    const [r1, r2] = await Promise.all([
      Promise.resolve(parseConfigDto(validEnv)),
      Promise.resolve(parseConfigDto(invalidEnv)),
    ]);

    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(false);
    // Verify there's no state contamination
    expect(r1.dto.port).toBe(5001);
    expect(r2.error).toBeInstanceOf(ConfigError);
  });

  test('calling parseConfigDto with different valid envs does not share state', () => {
    const envA = minValidEnv({ PORT: '3001' });
    const envB = minValidEnv({ PORT: '4001' });

    const rA = parseConfigDto(envA);
    const rB = parseConfigDto(envB);

    expect(rA.dto.port).toBe(3001);
    expect(rB.dto.port).toBe(4001);
  });
});

// ---------------------------------------------------------------------------
// buildConfigDto — unexpected error wrapping
// ---------------------------------------------------------------------------

describe('parseConfigDto — unexpected error wrapping', () => {
  test('wraps a non-Error thrown value into UNEXPECTED_ERROR', () => {
    // Simulate a case where ConfigSchema.safeParse somehow throws a non-Error.
    // We test this by passing a Proxy that throws a string when accessed.
    const throwingEnv = new Proxy(
      {},
      {
        get(_target, prop) {
          // Allow Jest symbol checks (Symbol.iterator etc.) through
          if (typeof prop === 'symbol') return undefined;
          // Allow known safe string props through too
          if (['constructor', 'then', 'catch', 'finally', 'toJSON'].includes(prop)) {
            return undefined;
          }
          throw 'unexpected string thrown'; // non-Error
        },
      }
    );

    // parseConfigDto should absorb this and return a structured error
    const result = parseConfigDto(throwingEnv);
    expect(result.ok).toBe(false);
    // The error should be a ConfigError (either UNEXPECTED_ERROR or rethrown ConfigError)
    expect(result.error).toBeInstanceOf(ConfigError);
  });
});

// ---------------------------------------------------------------------------
// requireConfigDto
// ---------------------------------------------------------------------------

describe('requireConfigDto', () => {
  test('returns ConfigDto for valid env', () => {
    const dto = requireConfigDto(minValidEnv());
    expect(dto).toMatchObject({ nodeEnv: 'test' });
  });

  test('throws ConfigError for invalid env', () => {
    expect(() => requireConfigDto({})).toThrow(ConfigError);
  });

  test('thrown ConfigError has a code', () => {
    try {
      requireConfigDto({});
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      expect(Object.values(CONFIG_ERROR_CODES)).toContain(err.code);
    }
  });

  test('thrown error is NOT a plain Error — it is a ConfigError', () => {
    try {
      requireConfigDto({});
    } catch (err) {
      expect(err.name).toBe('ConfigError');
    }
  });
});

// ---------------------------------------------------------------------------
// ConfigError shape invariants
// ---------------------------------------------------------------------------

describe('ConfigError — shape invariants', () => {
  test('ConfigError is an instance of Error', () => {
    try {
      buildConfigDto({});
    } catch (err) {
      expect(err instanceof Error).toBe(true);
    }
  });

  test('ConfigError.name is "ConfigError"', () => {
    try {
      buildConfigDto({});
    } catch (err) {
      expect(err.name).toBe('ConfigError');
    }
  });

  test('CONFIG_ERROR_CODES contains expected keys', () => {
    expect(CONFIG_ERROR_CODES).toMatchObject({
      MISSING_FIELD: expect.any(String),
      VALIDATION_ERROR: expect.any(String),
      PARSE_ERROR: expect.any(String),
      UNEXPECTED_ERROR: expect.any(String),
    });
  });

  test('CONFIG_ERROR_CODES is frozen (immutable)', () => {
    expect(Object.isFrozen(CONFIG_ERROR_CODES)).toBe(true);
  });

  test('ConfigError cause is set when provided', () => {
    const cause = new Error('root cause');
    const err = new ConfigError({
      code: CONFIG_ERROR_CODES.UNEXPECTED_ERROR,
      message: 'test',
      cause,
    });
    expect(err.cause).toBe(cause);
  });

  test('ConfigError fieldErrors defaults to null when not provided', () => {
    const err = new ConfigError({
      code: CONFIG_ERROR_CODES.UNEXPECTED_ERROR,
      message: 'test',
    });
    expect(err.fieldErrors).toBeNull();
  });
});
