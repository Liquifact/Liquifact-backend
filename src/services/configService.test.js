'use strict';

/**
 * @fileoverview Unit tests for config service layer.
 *
 * Tests the business logic encapsulated in configService, including:
 * - applyConfig: applying configuration changes for different sections
 * - applyCorsConfig: CORS-specific configuration application
 * - getConfigSections: retrieving valid section names
 */

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-at-least-32-characters-long-string-for-jest';

// ── Module mocks ─────────────────────────────────────────────────────────────

jest.mock('../logger', () => ({
  warn: jest.fn(),
  error: jest.fn(),
  info: jest.fn(),
}));

jest.mock('../config/cors', () => ({
  reloadCorsOrigins: jest.fn(),
  reloadCorsMaxAge: jest.fn(),
}));

// ── Imports ───────────────────────────────────────────────────────────────────

const { applyConfig, applyCorsConfig, getConfigSections } = require('./configService');
const logger = require('../logger');
const { reloadCorsOrigins, reloadCorsMaxAge } = require('../config/cors');

// ═════════════════════════════════════════════════════════════════════════════
// applyConfig tests
// ═════════════════════════════════════════════════════════════════════════════

describe('applyConfig', () => {
  const context = {
    tenantId: 'tenant_test',
    adminClient: 'admin-user',
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('CORS section', () => {
    it('applies CORS config with origins', () => {
      const config = {
        origins: ['https://example.com', 'https://app.example.com'],
      };

      const result = applyConfig('cors', config, context);

      expect(result).toEqual({
        section: 'cors',
        config,
        message: "Configuration section 'cors' validated and accepted.",
      });
      expect(process.env.CORS_ALLOWED_ORIGINS).toBe('https://example.com,https://app.example.com');
      expect(reloadCorsOrigins).toHaveBeenCalledTimes(1);
      expect(logger.info).toHaveBeenCalledWith(
        {
          tenantId: 'tenant_test',
          section: 'cors',
          adminClient: 'admin-user',
        },
        'Admin runtime config update accepted',
      );
    });

    it('applies CORS config with maxAge', () => {
      const config = {
        maxAge: 600,
      };

      const result = applyConfig('cors', config, context);

      expect(result).toEqual({
        section: 'cors',
        config,
        message: "Configuration section 'cors' validated and accepted.",
      });
      expect(process.env.CORS_MAX_AGE).toBe('600');
      expect(reloadCorsMaxAge).toHaveBeenCalledTimes(1);
      expect(logger.info).toHaveBeenCalledWith(
        {
          tenantId: 'tenant_test',
          section: 'cors',
          adminClient: 'admin-user',
        },
        'Admin runtime config update accepted',
      );
    });

    it('applies CORS config with both origins and maxAge', () => {
      const config = {
        origins: ['https://example.com'],
        maxAge: 300,
      };

      const result = applyConfig('cors', config, context);

      expect(result).toEqual({
        section: 'cors',
        config,
        message: "Configuration section 'cors' validated and accepted.",
      });
      expect(process.env.CORS_ALLOWED_ORIGINS).toBe('https://example.com');
      expect(reloadCorsOrigins).toHaveBeenCalledTimes(1);
      expect(process.env.CORS_MAX_AGE).toBe('300');
      expect(reloadCorsMaxAge).toHaveBeenCalledTimes(1);
      expect(logger.info).toHaveBeenCalledWith(
        {
          tenantId: 'tenant_test',
          section: 'cors',
          adminClient: 'admin-user',
        },
        'Admin runtime config update accepted',
      );
    });

    it('handles CORS config with empty origins array', () => {
      const config = {
        origins: [],
      };

      const result = applyConfig('cors', config, context);

      expect(result).toEqual({
        section: 'cors',
        config,
        message: "Configuration section 'cors' validated and accepted.",
      });
      expect(process.env.CORS_ALLOWED_ORIGINS).toBe('');
      expect(reloadCorsOrigins).toHaveBeenCalledTimes(1);
    });
  });

  describe('Other sections (webhook, reconciliation, kyc, retention, fraudThresholds)', () => {
    it('accepts webhook section without applying runtime changes', () => {
      const config = {
        url: 'https://hooks.example.com',
        secret: 'valid-secret-16chars',
        events: ['invoice.created'],
      };

      const result = applyConfig('webhook', config, context);

      expect(result).toEqual({
        section: 'webhook',
        config,
        message: "Configuration section 'webhook' validated and accepted.",
      });
      expect(logger.info).toHaveBeenCalledWith(
        {
          tenantId: 'tenant_test',
          section: 'webhook',
          adminClient: 'admin-user',
        },
        'Admin runtime config update accepted',
      );
      // No CORS functions should be called
      expect(reloadCorsOrigins).not.toHaveBeenCalled();
      expect(reloadCorsMaxAge).not.toHaveBeenCalled();
    });

    it('accepts reconciliation section without applying runtime changes', () => {
      const config = {
        batchSize: 100,
        enabled: true,
      };

      const result = applyConfig('reconciliation', config, context);

      expect(result).toEqual({
        section: 'reconciliation',
        config,
        message: "Configuration section 'reconciliation' validated and accepted.",
      });
      expect(logger.info).toHaveBeenCalledWith(
        {
          tenantId: 'tenant_test',
          section: 'reconciliation',
          adminClient: 'admin-user',
        },
        'Admin runtime config update accepted',
      );
      expect(reloadCorsOrigins).not.toHaveBeenCalled();
      expect(reloadCorsMaxAge).not.toHaveBeenCalled();
    });

    it('accepts kyc section without applying runtime changes', () => {
      const config = {
        providerUrl: 'https://kyc.example.com',
        apiKey: 'valid-key-8chars',
      };

      const result = applyConfig('kyc', config, context);

      expect(result).toEqual({
        section: 'kyc',
        config,
        message: "Configuration section 'kyc' validated and accepted.",
      });
      expect(logger.info).toHaveBeenCalledWith(
        {
          tenantId: 'tenant_test',
          section: 'kyc',
          adminClient: 'admin-user',
        },
        'Admin runtime config update accepted',
      );
      expect(reloadCorsOrigins).not.toHaveBeenCalled();
      expect(reloadCorsMaxAge).not.toHaveBeenCalled();
    });

    it('accepts retention section without applying runtime changes', () => {
      const config = {
        retentionDays: 365,
        purgeEnabled: false,
      };

      const result = applyConfig('retention', config, context);

      expect(result).toEqual({
        section: 'retention',
        config,
        message: "Configuration section 'retention' validated and accepted.",
      });
      expect(logger.info).toHaveBeenCalledWith(
        {
          tenantId: 'tenant_test',
          section: 'retention',
          adminClient: 'admin-user',
        },
        'Admin runtime config update accepted',
      );
      expect(reloadCorsOrigins).not.toHaveBeenCalled();
      expect(reloadCorsMaxAge).not.toHaveBeenCalled();
    });

    it('accepts fraudThresholds section without applying runtime changes', () => {
      const config = {
        fraudCeiling: 5000000,
      };

      const result = applyConfig('fraudThresholds', config, context);

      expect(result).toEqual({
        section: 'fraudThresholds',
        config,
        message: "Configuration section 'fraudThresholds' validated and accepted.",
      });
      expect(logger.info).toHaveBeenCalledWith(
        {
          tenantId: 'tenant_test',
          section: 'fraudThresholds',
          adminClient: 'admin-user',
        },
        'Admin runtime config update accepted',
      );
      expect(reloadCorsOrigins).not.toHaveBeenCalled();
      expect(reloadCorsMaxAge).not.toHaveBeenCalled();
    });
  });

  describe('Context handling', () => {
    it('logs with tenantId from context', () => {
      const config = { url: 'https://example.com', secret: 'valid-16', events: ['evt'] };
      const customContext = { tenantId: 'custom_tenant', adminClient: 'custom_admin' };

      applyConfig('webhook', config, customContext);

      expect(logger.info).toHaveBeenCalledWith(
        expect.objectContaining({
          tenantId: 'custom_tenant',
          adminClient: 'custom_admin',
        }),
        'Admin runtime config update accepted',
      );
    });

    it('logs with adminClient from context', () => {
      const config = { fraudCeiling: 1000000 };
      const customContext = { tenantId: 'tenant_123', adminClient: 'api_key_abc' };

      applyConfig('fraudThresholds', config, customContext);

      expect(logger.info).toHaveBeenCalledWith(
        expect.objectContaining({
          tenantId: 'tenant_123',
          adminClient: 'api_key_abc',
        }),
        'Admin runtime config update accepted',
      );
    });
  });

  describe('Return value structure', () => {
    it('returns object with section, config, and message properties', () => {
      const config = { batchSize: 50 };
      const result = applyConfig('reconciliation', config, context);

      expect(result).toHaveProperty('section');
      expect(result).toHaveProperty('config');
      expect(result).toHaveProperty('message');
      expect(typeof result.section).toBe('string');
      expect(typeof result.config).toBe('object');
      expect(typeof result.message).toBe('string');
    });

    it('message includes the section name', () => {
      const config = { retentionDays: 90 };
      const result = applyConfig('retention', config, context);

      expect(result.message).toContain('retention');
    });
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// applyCorsConfig tests
// ═════════════════════════════════════════════════════════════════════════════

describe('applyCorsConfig', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.CORS_ALLOWED_ORIGINS;
    delete process.env.CORS_MAX_AGE;
  });

  it('updates CORS_ALLOWED_ORIGINS env var and calls reloadCorsOrigins', () => {
    const config = {
      origins: ['https://example.com', 'https://app.example.com'],
    };

    applyCorsConfig(config);

    expect(process.env.CORS_ALLOWED_ORIGINS).toBe('https://example.com,https://app.example.com');
    expect(reloadCorsOrigins).toHaveBeenCalledTimes(1);
  });

  it('updates CORS_MAX_AGE env var and calls reloadCorsMaxAge', () => {
    const config = {
      maxAge: 600,
    };

    applyCorsConfig(config);

    expect(process.env.CORS_MAX_AGE).toBe('600');
    expect(reloadCorsMaxAge).toHaveBeenCalledTimes(1);
  });

  it('handles both origins and maxAge together', () => {
    const config = {
      origins: ['https://example.com'],
      maxAge: 300,
    };

    applyCorsConfig(config);

    expect(process.env.CORS_ALLOWED_ORIGINS).toBe('https://example.com');
    expect(process.env.CORS_MAX_AGE).toBe('300');
    expect(reloadCorsOrigins).toHaveBeenCalledTimes(1);
    expect(reloadCorsMaxAge).toHaveBeenCalledTimes(1);
  });

  it('does not update env vars when origins is not provided', () => {
    const config = {
      maxAge: 600,
    };

    applyCorsConfig(config);

    expect(process.env.CORS_ALLOWED_ORIGINS).toBeUndefined();
    expect(reloadCorsOrigins).not.toHaveBeenCalled();
  });

  it('does not update env vars when maxAge is not provided', () => {
    const config = {
      origins: ['https://example.com'],
    };

    applyCorsConfig(config);

    expect(process.env.CORS_MAX_AGE).toBeUndefined();
    expect(reloadCorsMaxAge).not.toHaveBeenCalled();
  });

  it('handles empty origins array', () => {
    const config = {
      origins: [],
    };

    applyCorsConfig(config);

    expect(process.env.CORS_ALLOWED_ORIGINS).toBe('');
    expect(reloadCorsOrigins).toHaveBeenCalledTimes(1);
  });

  it('handles maxAge of 0', () => {
    const config = {
      maxAge: 0,
    };

    applyCorsConfig(config);

    expect(process.env.CORS_MAX_AGE).toBe('0');
    expect(reloadCorsMaxAge).toHaveBeenCalledTimes(1);
  });

  it('handles single origin', () => {
    const config = {
      origins: ['https://example.com'],
    };

    applyCorsConfig(config);

    expect(process.env.CORS_ALLOWED_ORIGINS).toBe('https://example.com');
    expect(reloadCorsOrigins).toHaveBeenCalledTimes(1);
  });

  it('handles multiple origins', () => {
    const config = {
      origins: ['https://a.com', 'https://b.com', 'https://c.com'],
    };

    applyCorsConfig(config);

    expect(process.env.CORS_ALLOWED_ORIGINS).toBe('https://a.com,https://b.com,https://c.com');
    expect(reloadCorsOrigins).toHaveBeenCalledTimes(1);
  });

  it('handles maxAge as string number', () => {
    const config = {
      maxAge: '600',
    };

    applyCorsConfig(config);

    expect(process.env.CORS_MAX_AGE).toBe('600');
    expect(reloadCorsMaxAge).toHaveBeenCalledTimes(1);
  });

  it('does not call reloadCorsOrigins when origins is undefined', () => {
    const config = {};

    applyCorsConfig(config);

    expect(reloadCorsOrigins).not.toHaveBeenCalled();
  });

  it('does not call reloadCorsMaxAge when maxAge is undefined', () => {
    const config = {};

    applyCorsConfig(config);

    expect(reloadCorsMaxAge).not.toHaveBeenCalled();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// getConfigSections tests
// ═════════════════════════════════════════════════════════════════════════════

describe('getConfigSections', () => {
  it('returns an array of section names', () => {
    const sections = getConfigSections();

    expect(Array.isArray(sections)).toBe(true);
    expect(sections.length).toBeGreaterThan(0);
  });

  it('returns the expected section names', () => {
    const sections = getConfigSections();

    const expectedSections = ['webhook', 'reconciliation', 'kyc', 'retention', 'fraudThresholds', 'cors'];
    expect(sections).toEqual(expect.arrayContaining(expectedSections));
  });

  it('returns only strings', () => {
    const sections = getConfigSections();

    for (const section of sections) {
      expect(typeof section).toBe('string');
    }
  });

  it('returns sections without duplicates', () => {
    const sections = getConfigSections();

    expect(new Set(sections).size).toBe(sections.length);
  });

  it('includes cors section', () => {
    const sections = getConfigSections();

    expect(sections).toContain('cors');
  });

  it('includes webhook section', () => {
    const sections = getConfigSections();

    expect(sections).toContain('webhook');
  });

  it('includes reconciliation section', () => {
    const sections = getConfigSections();

    expect(sections).toContain('reconciliation');
  });

  it('includes kyc section', () => {
    const sections = getConfigSections();

    expect(sections).toContain('kyc');
  });

  it('includes retention section', () => {
    const sections = getConfigSections();

    expect(sections).toContain('retention');
  });

  it('includes fraudThresholds section', () => {
    const sections = getConfigSections();

    expect(sections).toContain('fraudThresholds');
  });
});
