'use strict';

/**
 * Tests for the S3 connectivity health-check probe added to
 * src/services/storage.js (issue #452).
 *
 * Covers:
 *   - reachable bucket → healthy
 *   - missing bucket (NoSuchBucket) → unhealthy
 *   - bad credentials (InvalidAccessKeyId / AccessDenied) → unhealthy
 *   - in-memory fallback mode → in_memory (skipped)
 *   - explicit opt-out (S3_HEALTHCHECK_ENABLED=false) → disabled
 *   - missing bucket name / credentials → not_configured
 *   - sanitizer: never surfaces credentials, endpoint, or signed headers
 *   - runStartupStorageProbe logs but does not throw
 */

const SANITIZED_HINT_ACCESS_DENIED = 'credentials lack permission to access bucket';

describe('Storage S3 connectivity probe (issue #452)', () => {
  let originalEnvdescriptor;
  let originalEnv;
  let storageModule;
  let loggerInfoSpy;
  let loggerWarnSpy;
  let loggerErrorSpy;

  beforeAll(() => {
    originalEnvdescriptor = Object.getOwnPropertyDescriptor(process, 'env');
    originalEnv = { ...process.env };
  });

  beforeEach(() => {
    jest.resetModules();
    process.env = {
      ...originalEnv,
      NODE_ENV: 'development',
      AWS_ACCESS_KEY_ID: 'AKIATESTKEY',
      AWS_SECRET_ACCESS_KEY: 'testsecret',
      S3_BUCKET: 'liquifact-invoices',
      S3_HEALTHCHECK_ENABLED: undefined,
      STORAGE_IN_MEMORY: undefined,
    };
    delete process.env.S3_HEALTHCHECK_ENABLED;
    delete process.env.STORAGE_IN_MEMORY;
    // Re-require after env changes so probe functions re-read env vars.
    storageModule = require('../src/services/storage');
    loggerInfoSpy = jest.spyOn(storageModule.logger, 'info').mockImplementation(() => {});
    loggerWarnSpy = jest.spyOn(storageModule.logger, 'warn').mockImplementation(() => {});
    loggerErrorSpy = jest.spyOn(storageModule.logger, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  afterAll(() => {
    if (originalEnvdescriptor) {
      Object.defineProperty(process, 'env', originalEnvdescriptor);
    } else {
      process.env = originalEnv;
    }
  });

  describe('probeS3Connectivity — reachable', () => {
    it('returns healthy when HeadBucket succeeds', async () => {
      const fakeClient = { send: jest.fn(() => Promise.resolve({})) };
      const result = await storageModule.probeS3Connectivity({ client: fakeClient });
      expect(result.status).toBe('healthy');
      expect(result.bucketConfigured).toBe(true);
      expect(result.credentialsConfigured).toBe(true);
      expect(result.latency).toBeGreaterThanOrEqual(0);
      expect(fakeClient.send).toHaveBeenCalledTimes(1);
      // First arg should be a HeadBucketCommand-like object.
      const sent = fakeClient.send.mock.calls[0][0];
      expect(sent.constructor.name).toBe('HeadBucketCommand');
      expect(sent.input).toEqual({ Bucket: 'liquifact-invoices' });
    });
  });

  describe('probeS3Connectivity — error classification', () => {
    const fakeErrorCases = [
      { name: 'NoSuchBucket', code: 'NoSuchBucket', expectedHint: 'configured bucket not found' },
      { name: 'AccessDenied', code: 'AccessDenied', expectedHint: SANITIZED_HINT_ACCESS_DENIED },
      { name: 'InvalidAccessKeyId', code: 'InvalidAccessKeyId', expectedHint: 'AWS access key id rejected by object storage' },
      { name: 'NetworkingError', code: 'NetworkingError', expectedHint: 'network error contacting object storage' },
    ];

    test.each(fakeErrorCases)(
      'returns unhealthy + sanitized AWS error name for %s',
      async ({ name, code, expectedHint }) => {
        const err = new Error(`${name} fake message contains endpoint https://s3.amazonaws.com and key AKIAFAKE`);
        err.name = name;
        const fakeClient = { send: jest.fn(() => Promise.reject(err)) };

        const result = await storageModule.probeS3Connectivity({ client: fakeClient });
        expect(result.status).toBe('unhealthy');
        expect(result.error).toEqual({ code, hint: expectedHint });
        // Crucially: never leaks the original message (which contained
        // endpoint and key material).
        expect(result.error).not.toHaveProperty('message');
        expect(loggerErrorSpy).toHaveBeenCalled();
        const logArg = loggerErrorSpy.mock.calls[0][0];
        const logStr = JSON.stringify(logArg);
        expect(logStr).not.toContain('AKIAFAKE');
        expect(logStr).not.toContain('s3.amazonaws.com');
        expect(logStr).toContain(code);
      }
    );

    it('collapses unknown error names to UnknownError', async () => {
      const err = new Error('Something containing AKIA-WORST-CASE-KEY and https://endpoint');
      err.name = 'TotallyUnknownWeirdError';
      const fakeClient = { send: jest.fn(() => Promise.reject(err)) };

      const result = await storageModule.probeS3Connectivity({ client: fakeClient });
      expect(result.status).toBe('unhealthy');
      expect(result.error).toEqual({ code: 'UnknownError', hint: 'object storage unreachable' });
      // Original message body must not appear under any field.
      const logStr = JSON.stringify(loggerErrorSpy.mock.calls[0][0]);
      expect(logStr).not.toContain('AKIA-WORST-CASE-KEY');
      expect(logStr).not.toContain('https://endpoint');
    });

    it('returns unhealthy + TimeoutError when probe exceeds timeout', async () => {
      const fakeClient = {
        send: jest.fn(() => new Promise((resolve) => {
          // Never resolves — relies on the timeout race to fire.
          setTimeout(() => resolve({}), 1000);
        })),
      };

      const result = await storageModule.probeS3Connectivity({ client: fakeClient, timeoutMs: 50 });
      expect(result.status).toBe('unhealthy');
      expect(result.error).toEqual({ code: 'TimeoutError', hint: 'object storage probe timed out' });
    });

    it('never includes the input bucket name in the returned object for clean error case', async () => {
      const fakeClient = { send: jest.fn(() => Promise.reject(Object.assign(new Error('x'), { name: 'NoSuchBucket' }))) };
      const result = await storageModule.probeS3Connectivity({ client: fakeClient });
      // Only bucketConfigured (boolean) is exposed, not the actual name.
      expect(result.bucketConfigured).toBe(true);
      expect(result).not.toHaveProperty('bucket');
      expect(result).not.toHaveProperty('bucketName');
    });
  });

  describe('probeS3Connectivity — skip branches', () => {
    it('returns in_memory when NODE_ENV=test', async () => {
      process.env.NODE_ENV = 'test';
      jest.resetModules();
      storageModule = require('../src/services/storage');
      const fakeClient = { send: jest.fn() };
      const result = await storageModule.probeS3Connectivity({ client: fakeClient });
      expect(result.status).toBe('in_memory');
      expect(fakeClient.send).not.toHaveBeenCalled();
    });

    it('returns in_memory when STORAGE_IN_MEMORY=true even with NODE_ENV=development', async () => {
      process.env.NODE_ENV = 'development';
      process.env.STORAGE_IN_MEMORY = 'true';
      jest.resetModules();
      storageModule = require('../src/services/storage');
      const fakeClient = { send: jest.fn() };
      const result = await storageModule.probeS3Connectivity({ client: fakeClient });
      expect(result.status).toBe('in_memory');
      expect(fakeClient.send).not.toHaveBeenCalled();
    });

    it('returns disabled when S3_HEALTHCHECK_ENABLED=false', async () => {
      process.env.S3_HEALTHCHECK_ENABLED = 'false';
      jest.resetModules();
      storageModule = require('../src/services/storage');
      const fakeClient = { send: jest.fn() };
      const result = await storageModule.probeS3Connectivity({ client: fakeClient });
      expect(result.status).toBe('disabled');
      expect(fakeClient.send).not.toHaveBeenCalled();
    });

    it('returns not_configured when S3_BUCKET is missing', async () => {
      delete process.env.S3_BUCKET;
      jest.resetModules();
      storageModule = require('../src/services/storage');
      const fakeClient = { send: jest.fn() };
      const result = await storageModule.probeS3Connectivity({ client: fakeClient });
      expect(result.status).toBe('not_configured');
      expect(result.bucketConfigured).toBe(false);
      expect(fakeClient.send).not.toHaveBeenCalled();
    });

    it('returns not_configured when only access key id is configured', async () => {
      delete process.env.AWS_SECRET_ACCESS_KEY;
      jest.resetModules();
      storageModule = require('../src/services/storage');
      const fakeClient = { send: jest.fn() };
      const result = await storageModule.probeS3Connectivity({ client: fakeClient });
      expect(result.status).toBe('not_configured');
      expect(result.credentialsConfigured).toBe(false);
      expect(fakeClient.send).not.toHaveBeenCalled();
    });

    it('returns not_configured when only secret is configured', async () => {
      delete process.env.AWS_ACCESS_KEY_ID;
      jest.resetModules();
      storageModule = require('../src/services/storage');
      const fakeClient = { send: jest.fn() };
      const result = await storageModule.probeS3Connectivity({ client: fakeClient });
      expect(result.status).toBe('not_configured');
      expect(result.credentialsConfigured).toBe(false);
      expect(fakeClient.send).not.toHaveBeenCalled();
    });

    it('honors STORAGE_HEALTHCHECK_TIMEOUT_MS when no per-call timeout is supplied', async () => {
      process.env.STORAGE_HEALTHCHECK_TIMEOUT_MS = '25';
      jest.resetModules();
      storageModule = require('../src/services/storage');
      const fakeClient = {
        send: jest.fn(() => new Promise((resolve) => { setTimeout(() => resolve({}), 1000); })),
      };
      const t0 = Date.now();
      const result = await storageModule.probeS3Connectivity({ client: fakeClient });
      const elapsed = Date.now() - t0;
      expect(result.status).toBe('unhealthy');
      expect(result.error.code).toBe('TimeoutError');
      // The probe should have returned within a small multiple of the 25ms timeout.
      expect(elapsed).toBeLessThan(500);
    });
  });

  describe('sanitizeStorageError', () => {
    it('returns allowed AWS error names with hints', () => {
      expect(storageModule.sanitizeStorageError({ name: 'NoSuchBucket' }))
        .toEqual({ code: 'NoSuchBucket', hint: 'configured bucket not found' });
      expect(storageModule.sanitizeStorageError({ name: 'AccessDenied' }))
        .toEqual({ code: 'AccessDenied', hint: SANITIZED_HINT_ACCESS_DENIED });
    });

    it('collapses unknown errors to UnknownError', () => {
      expect(storageModule.sanitizeStorageError({ name: 'CompletelyRandomError' }))
        .toEqual({ code: 'UnknownError', hint: 'object storage unreachable' });
      expect(storageModule.sanitizeStorageError(null))
        .toEqual({ code: 'UnknownError', hint: 'object storage unreachable' });
      expect(storageModule.sanitizeStorageError(undefined))
        .toEqual({ code: 'UnknownError', hint: 'object storage unreachable' });
      expect(storageModule.sanitizeStorageError('not an object'))
        .toEqual({ code: 'UnknownError', hint: 'object storage unreachable' });
    });

    it('does not expose err.message under any output field', () => {
      const err = new Error('Contains secret AKIASUPERSECRETKEY and endpoint https://x.example.com');
      err.name = 'NetworkingError';
      const result = storageModule.sanitizeStorageError(err);
      const stringified = JSON.stringify(result);
      expect(stringified).not.toContain('AKIASUPERSECRETKEY');
      expect(stringified).not.toContain('x.example.com');
      expect(stringified).not.toContain('Contains secret');
    });
  });

  describe('runStartupStorageProbe', () => {
    it('logs and returns healthy result without throwing on success', async () => {
      jest.resetModules();
      storageModule = require('../src/services/storage');
      const infoSpy = jest.spyOn(storageModule.logger, 'info').mockImplementation(() => {});

      const fakeProbe = jest.fn(async () => ({ status: 'healthy', latency: 4 }));

      const result = await storageModule.runStartupStorageProbe(fakeProbe);
      expect(fakeProbe).toHaveBeenCalledTimes(1);
      expect(result.status).toBe('healthy');
      expect(infoSpy).toHaveBeenCalled();
      // The log payload must not leak credential material even on success.
      const logStr = JSON.stringify(infoSpy.mock.calls);
      expect(logStr).not.toMatch(/AKIA[A-Z0-9]+/);
      expect(logStr).not.toContain('AWS_SECRET');
      infoSpy.mockRestore();
    });

    it('logs a warning on unhealthy probe and does not throw', async () => {
      jest.resetModules();
      storageModule = require('../src/services/storage');
      const warnSpy = jest.spyOn(storageModule.logger, 'warn').mockImplementation(() => {});

      const fakeProbe = jest.fn(async () => ({
        status: 'unhealthy',
        latency: 7,
        error: { code: 'NoSuchBucket', hint: 'configured bucket not found' },
      }));

      const result = await storageModule.runStartupStorageProbe(fakeProbe);
      expect(result.status).toBe('unhealthy');
      expect(warnSpy).toHaveBeenCalled();
      const warnArgs = JSON.stringify(warnSpy.mock.calls);
      expect(warnArgs).not.toContain('AKIASUPERSECRET');
      expect(warnArgs).not.toContain('x.example.com');
      warnSpy.mockRestore();
    });

    it('logs info on a skipped (in_memory) probe result without throwing', async () => {
      jest.resetModules();
      storageModule = require('../src/services/storage');
      const infoSpy = jest.spyOn(storageModule.logger, 'info').mockImplementation(() => {});

      const fakeProbe = jest.fn(async () => ({ status: 'in_memory' }));

      const result = await storageModule.runStartupStorageProbe(fakeProbe);
      expect(result.status).toBe('in_memory');
      expect(infoSpy).toHaveBeenCalled();
      infoSpy.mockRestore();
    });
  });

  describe('security — credential / endpoint leakage', () => {
    it('does not log or return AWS_SECRET_ACCESS_KEY or AWS_ACCESS_KEY_ID on failure', async () => {
      const err = new Error('Connection refused: https://s3.internal.example.com AKIAFAKE fake key');
      err.name = 'NetworkingError';
      const fakeClient = { send: jest.fn(() => Promise.reject(err)) };
      const result = await storageModule.probeS3Connectivity({ client: fakeClient });

      const serialized = JSON.stringify({
        result,
        errorLog: loggerErrorSpy.mock.calls,
      });

      expect(serialized).not.toMatch(/AKIA[A-Z0-9]+/);
      expect(serialized).not.toContain('s3.internal.example.com');
      expect(serialized).not.toContain('AWS_SECRET_ACCESS_KEY');
      expect(serialized).not.toContain('AWS_ACCESS_KEY_ID');
      // The configured bucket name should also not be returned.
      expect(serialized).not.toContain('liquifact-invoices');
    });
  });
});
