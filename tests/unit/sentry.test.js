'use strict';

describe('Sentry observability module - Enhanced Scrubbing', () => {
  let mockSentry;
  let initialEnv;
  let sentry;

  beforeEach(() => {
    jest.resetModules();
    initialEnv = { ...process.env };

    mockSentry = {
      init: jest.fn(),
      captureException: jest.fn(),
      withScope: jest.fn((cb) => cb({ 
        setTag: jest.fn(),
        setExtra: jest.fn(),
        setUser: jest.fn()
      })),
      Handlers: {
        requestHandler: jest.fn(() => (req, res, next) => next()),
      },
    };

    jest.doMock('@sentry/node', () => mockSentry);
    sentry = require('../../src/observability/sentry');
  });

  afterEach(() => {
    process.env = initialEnv;
    jest.resetAllMocks();
  });

  describe('Initialization', () => {
    it('does not initialize Sentry when SENTRY_DSN is unset', () => {
      delete process.env.SENTRY_DSN;
      const consoleSpy = jest.spyOn(console, 'log');

      sentry.initSentry();

      expect(mockSentry.init).not.toHaveBeenCalled();
      expect(sentry.isEnabled()).toBe(false);
      expect(consoleSpy).toHaveBeenCalledWith('Sentry DSN not provided, observability disabled');
      consoleSpy.mockRestore();
    });

    it('initializes Sentry when SENTRY_DSN is present', () => {
      process.env.SENTRY_DSN = 'https://public@sentry.io/123';
      process.env.SENTRY_RELEASE = 'liquifact-backend@1.0.0';
      process.env.SENTRY_ENVIRONMENT = 'staging';
      const consoleSpy = jest.spyOn(console, 'log');

      sentry.initSentry();

      expect(mockSentry.init).toHaveBeenCalledWith(
        expect.objectContaining({
          dsn: 'https://public@sentry.io/123',
          release: 'liquifact-backend@1.0.0',
          environment: 'staging',
          beforeSend: expect.any(Function),
          beforeSendTransaction: expect.any(Function),
        })
      );
      expect(sentry.isEnabled()).toBe(true);
      expect(consoleSpy).toHaveBeenCalledWith('Sentry initialized with enhanced event scrubbing');
      consoleSpy.mockRestore();
    });
  });

  describe('isSensitiveKey', () => {
    it('identifies sensitive field names', () => {
      expect(sentry.isSensitiveKey('authorization')).toBe(true);
      expect(sentry.isSensitiveKey('token')).toBe(true);
      expect(sentry.isSensitiveKey('password')).toBe(true);
      expect(sentry.isSensitiveKey('x-api-key')).toBe(true);
      expect(sentry.isSensitiveKey('apikey')).toBe(true);
      expect(sentry.isSensitiveKey('secret')).toBe(true);
      expect(sentry.isSensitiveKey('invoice')).toBe(true);
      expect(sentry.isSensitiveKey('private_key')).toBe(true);
    });

    it('is case insensitive', () => {
      expect(sentry.isSensitiveKey('Authorization')).toBe(true);
      expect(sentry.isSensitiveKey('TOKEN')).toBe(true);
      expect(sentry.isSensitiveKey('X-API-KEY')).toBe(true);
    });

    it('returns false for non-sensitive keys', () => {
      expect(sentry.isSensitiveKey('username')).toBe(false);
      expect(sentry.isSensitiveKey('email')).toBe(false);
      expect(sentry.isSensitiveKey('id')).toBe(false);
    });
  });

  describe('hasSensitivePattern', () => {
    it('identifies invoice patterns', () => {
      expect(sentry.hasSensitivePattern('invoice_12345678')).toBe(true);
      expect(sentry.hasSensitivePattern('INVOICE-98765432')).toBe(true);
      expect(sentry.hasSensitivePattern('invoice 12345678')).toBe(true);
    });

    it('identifies token patterns', () => {
      expect(sentry.hasSensitivePattern('12345678901234567890123456789012')).toBe(true);
      expect(sentry.hasSensitivePattern('abcdef1234567890abcdef1234567890')).toBe(true);
    });

    it('identifies JWT patterns', () => {
      expect(sentry.hasSensitivePattern('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c')).toBe(true);
    });

    it('returns false for non-sensitive strings', () => {
      expect(sentry.hasSensitivePattern('hello world')).toBe(false);
      expect(sentry.hasSensitivePattern('12345')).toBe(false);
      expect(sentry.hasSensitivePattern('normal-text')).toBe(false);
    });
  });

  describe('deepScrub', () => {
    it('scrubs top-level sensitive fields', () => {
      const input = {
        username: 'john',
        password: 'secret123',
        email: 'john@example.com',
        token: 'abc123'
      };
      const result = sentry.deepScrub(input);
      expect(result.username).toBe('john');
      expect(result.password).toBe(sentry.REDACTED);
      expect(result.email).toBe('john@example.com');
      expect(result.token).toBe(sentry.REDACTED);
    });

    it('scrubs nested sensitive fields', () => {
      const input = {
        user: {
          name: 'john',
          password: 'secret123'
        },
        auth: {
          token: 'abc123',
          metadata: {
            api_key: 'key456'
          }
        }
      };
      const result = sentry.deepScrub(input);
      expect(result.user.password).toBe(sentry.REDACTED);
      expect(result.auth.token).toBe(sentry.REDACTED);
      expect(result.auth.metadata.api_key).toBe(sentry.REDACTED);
    });

    it('scrubs arrays containing sensitive data', () => {
      const input = [
        { password: 'secret123' },
        { token: 'abc123' },
        'not sensitive'
      ];
      const result = sentry.deepScrub(input);
      expect(result[0].password).toBe(sentry.REDACTED);
      expect(result[1].token).toBe(sentry.REDACTED);
      expect(result[2]).toBe('not sensitive');
    });

    it('redacts invoice patterns', () => {
      const input = {
        invoice_id: 'inv_12345678',
        details: 'Invoice number: INV-98765432',
        normal: 'hello'
      };
      const result = sentry.deepScrub(input);
      expect(result.invoice_id).toBe(sentry.REDACTED_INVOICE);
      expect(result.details).toBe(sentry.REDACTED_INVOICE);
      expect(result.normal).toBe('hello');
    });

    it('respects depth limit', () => {
      const deepObject = { level1: { level2: { level3: { level4: { level5: { data: 'test' } } } } } };
      const result = sentry.deepScrub(deepObject, sentry.MAX_DEPTH + 1);
      expect(result).toBe('[MAX_DEPTH_REACHED]');
    });

    it('handles null and undefined values', () => {
      expect(sentry.deepScrub(null)).toBe(null);
      expect(sentry.deepScrub(undefined)).toBe(undefined);
    });

    it('handles primitive types', () => {
      expect(sentry.deepScrub('hello')).toBe('hello');
      expect(sentry.deepScrub(123)).toBe(123);
      expect(sentry.deepScrub(true)).toBe(true);
    });

    it('handles mixed nested structures', () => {
      const input = {
        data: {
          users: [
            { id: 1, password: 'secret' },
            { id: 2, token: 'abc' }
          ],
          metadata: {
            auth: {
              api_key: 'key123'
            }
          }
        }
      };
      const result = sentry.deepScrub(input);
      expect(result.data.users[0].password).toBe(sentry.REDACTED);
      expect(result.data.users[1].token).toBe(sentry.REDACTED);
      expect(result.data.metadata.auth.api_key).toBe(sentry.REDACTED);
    });
  });

  describe('scrubUrl', () => {
    it('redacts sensitive query parameters', () => {
      const url = 'https://example.com/api?token=abc123&user=john&password=secret';
      const result = sentry.scrubUrl(url);
      expect(result).not.toContain('abc123');
      expect(result).not.toContain('secret');
      expect(result).toContain(sentry.REDACTED);
    });

    it('redacts invoice IDs in URL paths', () => {
      const url = 'https://example.com/invoice/INV-12345678/details';
      const result = sentry.scrubUrl(url);
      expect(result).not.toContain('INV-12345678');
      expect(result).toContain(sentry.REDACTED_INVOICE);
    });

    it('redacts token-like strings in paths', () => {
      const url = 'https://example.com/api/12345678901234567890123456789012/action';
      const result = sentry.scrubUrl(url);
      expect(result).not.toContain('12345678901234567890123456789012');
      expect(result).toContain(sentry.REDACTED_INVOICE);
    });

    it('handles invalid URLs gracefully', () => {
      const invalid = 'not a url';
      expect(sentry.scrubUrl(invalid)).toBe(invalid);
    });

    it('handles null/undefined', () => {
      expect(sentry.scrubUrl(null)).toBe(null);
      expect(sentry.scrubUrl(undefined)).toBe(undefined);
    });
  });

  describe('scrubBreadcrumbs', () => {
    it('scrubs sensitive data in breadcrumbs', () => {
      const breadcrumbs = [
        {
          type: 'http',
          data: {
            url: 'https://api.example.com?token=secret',
            headers: {
              authorization: 'Bearer token123'
            }
          }
        },
        {
          type: 'log',
          message: 'Invoice INV-12345678 processed'
        }
      ];
      const result = sentry.scrubBreadcrumbs(breadcrumbs);
      expect(result[0].data.url).not.toContain('secret');
      expect(result[0].data.headers.authorization).toBe(sentry.REDACTED);
      expect(result[1].message).toBe(sentry.REDACTED_INVOICE);
    });

    it('handles non-array breadcrumbs', () => {
      const input = { message: 'test' };
      const result = sentry.scrubBreadcrumbs(input);
      expect(result).toEqual(sentry.deepScrub(input));
    });
  });

  describe('scrubEvent', () => {
    it('scrubs full Sentry event', () => {
      const event = {
        message: 'Test error',
        level: 'error',
        request: {
          url: 'https://api.example.com?token=abc123',
          headers: {
            authorization: 'Bearer token456',
            'x-api-key': 'key789'
          },
          data: {
            user: {
              password: 'secret123'
            }
          }
        },
        user: {
          id: 123,
          token: 'user_token'
        },
        extra: {
          payment: {
            invoice: 'INV-98765',
            amount: 100
          }
        },
        breadcrumbs: [
          {
            message: 'API call',
            data: {
              api_key: 'test_key'
            }
          }
        ]
      };
      const result = sentry.scrubEvent(event);
      
      expect(result.request.url).not.toContain('abc123');
      expect(result.request.headers.authorization).toBe(sentry.REDACTED);
      expect(result.request.headers['x-api-key']).toBe(sentry.REDACTED);
      expect(result.request.data.user.password).toBe(sentry.REDACTED);
      expect(result.user.token).toBe(sentry.REDACTED);
      expect(result.extra.payment.invoice).toBe(sentry.REDACTED_INVOICE);
      expect(result.breadcrumbs[0].data.api_key).toBe(sentry.REDACTED);
    });

    it('handles null event', () => {
      expect(sentry.scrubEvent(null)).toBe(null);
    });

    it('handles undefined event', () => {
      expect(sentry.scrubEvent(undefined)).toBe(undefined);
    });

    it('returns original event if scrubbing fails', () => {
      const circularEvent = { get circular() { return this; } };
      const result = sentry.scrubEvent(circularEvent);
      // Spread creates a new object, so use toEqual instead of toBe
      expect(result).toEqual(circularEvent);
    });
  });

  describe('scrubRequest', () => {
    it('scrubs request object', () => {
      const request = {
        method: 'POST',
        url: 'https://api.example.com/invoice/INV-12345',
        query_string: 'token=abc123&action=pay',
        headers: {
          authorization: 'Bearer secret',
          'x-api-key': 'key123'
        },
        data: {
          payment: {
            invoice_id: 'INV-67890',
            amount: 100
          }
        }
      };
      const result = sentry.scrubRequest(request);
      
      expect(result.url).not.toContain('INV-12345');
      expect(result.query_string).not.toContain('abc123');
      expect(result.headers.authorization).toBe(sentry.REDACTED);
      expect(result.headers['x-api-key']).toBe(sentry.REDACTED);
      expect(result.data.payment.invoice_id).toBe(sentry.REDACTED_INVOICE);
    });

    it('handles null request', () => {
      expect(sentry.scrubRequest(null)).toBe(null);
    });
  });

  describe('captureException', () => {
    it('captures exceptions with request context when enabled', () => {
      process.env.SENTRY_DSN = 'https://public@sentry.io/123';
      sentry.initSentry();

      const req = {
        id: 'cid-123',
        method: 'POST',
        originalUrl: '/api/invoices',
        headers: { authorization: 'Bearer secret-token', 'x-api-key': 'abc123' },
        body: { invoice: { amount: 100 }, customer: 'Acme' },
        query: { debug: 'true' },
        user: { id: 'user-1', email: 'user@example.com' },
      };

      const error = new Error('boom');
      sentry.captureException(error, req);

      expect(mockSentry.withScope).toHaveBeenCalled();
      expect(mockSentry.captureException).toHaveBeenCalledWith(error);
    });

    it('handles capture when Sentry is disabled', () => {
      delete process.env.SENTRY_DSN;
      sentry.initSentry();

      const error = new Error('boom');
      sentry.captureException(error, {});

      expect(mockSentry.captureException).not.toHaveBeenCalled();
    });
  });

  describe('Integration with Sentry beforeSend', () => {
    it('scrubs events in beforeSend hook', () => {
      process.env.SENTRY_DSN = 'https://test@test.ingest.sentry.io/123';
      sentry.initSentry();

      const initCall = mockSentry.init.mock.calls[0][0];
      expect(initCall.beforeSend).toBeDefined();

      const event = {
        message: 'Test',
        request: {
          url: 'https://example.com?token=secret'
        }
      };

      const scrubbed = initCall.beforeSend(event);
      expect(scrubbed.request.url).not.toContain('secret');
      expect(scrubbed.request.url).toContain(sentry.REDACTED);
    });

    it('scrubs events in beforeSendTransaction hook', () => {
      process.env.SENTRY_DSN = 'https://test@test.ingest.sentry.io/123';
      sentry.initSentry();

      const initCall = mockSentry.init.mock.calls[0][0];
      expect(initCall.beforeSendTransaction).toBeDefined();

      const event = {
        message: 'Test transaction',
        extra: {
          api_key: 'key123'
        }
      };

      const scrubbed = initCall.beforeSendTransaction(event);
      expect(scrubbed.extra.api_key).toBe(sentry.REDACTED);
    });
  });
});
