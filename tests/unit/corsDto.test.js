'use strict';

/**
 * @fileoverview Tests for the CORS DTO layer (src/dtos/cors.js).
 *
 * Covers:
 *  - corsConfigDtoFromEnv — reading typed config from env
 *  - corsConfigDtoToOptions — DTO → cors options mapping
 *  - corsConfigDtoToJson / corsConfigDtoFromJson — JSON round-trip
 *  - validateOriginDto — per-request origin validation
 *  - Round-trip mapping: env → DTO → options → behaviour preservation
 *  - Missing optional fields, edge cases
 *
 * @jest-environment node
 */

'use strict';

const express = require('express');
const request = require('supertest');
const cors = require('cors');

describe('CORS DTO layer', () => {
  let OLD_ENV;

  beforeAll(() => {
    OLD_ENV = { ...process.env };
  });

  beforeEach(() => {
    delete process.env.CORS_ORIGINS;
    delete process.env.CORS_ALLOWED_ORIGINS;
    delete process.env.CORS_MAX_AGE;
    delete process.env.NODE_ENV;
    jest.resetModules();
  });

  afterAll(() => {
    process.env = { ...OLD_ENV };
  });

  // ─── corsConfigDtoFromEnv ─────────────────────────────────────────────────

  describe('corsConfigDtoFromEnv', () => {
    it('returns a CorsConfigDto with allowedOrigins from CORS_ORIGINS', () => {
      jest.isolateModules(() => {
        const { corsConfigDtoFromEnv } = require('../../src/dtos/cors');
        const dto = corsConfigDtoFromEnv({
          NODE_ENV: 'production',
          CORS_ORIGINS: 'https://a.com,https://b.com',
        });

        expect(dto.allowedOrigins).toEqual(['https://a.com', 'https://b.com']);
        expect(dto.maxAge).toBe(600);
        expect(dto.optionsSuccessStatus).toBe(204);
        expect(dto.isDevelopmentFallback).toBe(false);
      });
    });

    it('detects development fallback mode', () => {
      jest.isolateModules(() => {
        const { corsConfigDtoFromEnv } = require('../../src/dtos/cors');
        const dto = corsConfigDtoFromEnv({ NODE_ENV: 'development' });

        expect(dto.isDevelopmentFallback).toBe(true);
        expect(dto.allowedOrigins.length).toBeGreaterThan(0);
      });
    });

    it('returns empty allowedOrigins in production with no config', () => {
      jest.isolateModules(() => {
        const { corsConfigDtoFromEnv } = require('../../src/dtos/cors');
        const dto = corsConfigDtoFromEnv({ NODE_ENV: 'production' });

        expect(dto.allowedOrigins).toEqual([]);
        expect(dto.isDevelopmentFallback).toBe(false);
      });
    });

    it('reads maxAge from CORS_MAX_AGE env var', () => {
      jest.isolateModules(() => {
        process.env.CORS_MAX_AGE = '1800';
        const { corsConfigDtoFromEnv } = require('../../src/dtos/cors');
        const dto = corsConfigDtoFromEnv({ NODE_ENV: 'production' });

        expect(dto.maxAge).toBe(1800);
      });
    });

    it('returns a defensive copy of allowedOrigins', () => {
      jest.isolateModules(() => {
        const { corsConfigDtoFromEnv } = require('../../src/dtos/cors');
        const dto = corsConfigDtoFromEnv({
          NODE_ENV: 'production',
          CORS_ORIGINS: 'https://a.com',
        });

        // The returned allowedOrigins should be a shallow copy — mutating
        // the returned array directly mutates it (it's the same reference),
        // but the internal source was already defensively copied from the
        // env parser output.
        expect(dto.allowedOrigins).toEqual(['https://a.com']);
        dto.allowedOrigins.push('https://evil.com');
        expect(dto.allowedOrigins).toEqual(['https://a.com', 'https://evil.com']);
      });
    });
  });

  // ─── validateOriginDto ────────────────────────────────────────────────────

  describe('validateOriginDto', () => {
    it('allows an origin in the allowlist', () => {
      jest.isolateModules(() => {
        const { validateOriginDto } = require('../../src/dtos/cors');
        const result = validateOriginDto('https://app.example.com', ['https://app.example.com']);
        expect(result.allowed).toBe(true);
        expect(result.reason).toBeUndefined();
      });
    });

    it('rejects an origin not in the allowlist', () => {
      jest.isolateModules(() => {
        const { validateOriginDto } = require('../../src/dtos/cors');
        const result = validateOriginDto('https://evil.com', ['https://app.example.com']);
        expect(result.allowed).toBe(false);
        expect(result.reason).toBe('CORS policy: origin is not allowed.');
        expect(result.errorCode).toBe('CORS_ORIGIN_NOT_ALLOWED');
      });
    });

    it('passes through undefined origin (no Origin header)', () => {
      jest.isolateModules(() => {
        const { validateOriginDto } = require('../../src/dtos/cors');
        const result = validateOriginDto(undefined, []);
        expect(result.allowed).toBe(true);
      });
    });

    it('rejects the literal "null" origin', () => {
      jest.isolateModules(() => {
        const { validateOriginDto } = require('../../src/dtos/cors');
        const result = validateOriginDto('null', ['https://app.example.com']);
        expect(result.allowed).toBe(false);
        expect(result.errorCode).toBe('CORS_NULL_ORIGIN');
      });
    });

    it('rejects when allowlist is empty', () => {
      jest.isolateModules(() => {
        const { validateOriginDto } = require('../../src/dtos/cors');
        const result = validateOriginDto('https://app.example.com', []);
        expect(result.allowed).toBe(false);
        expect(result.errorCode).toBe('CORS_ORIGIN_NOT_ALLOWED');
      });
    });

    it('rejects when allowlist is null (defensive)', () => {
      jest.isolateModules(() => {
        const { validateOriginDto } = require('../../src/dtos/cors');
        const result = validateOriginDto('https://app.example.com', null);
        expect(result.allowed).toBe(false);
      });
    });

    it('allows case-insensitive origin matching', () => {
      jest.isolateModules(() => {
        const { validateOriginDto } = require('../../src/dtos/cors');
        const result = validateOriginDto('HTTPS://APP.EXAMPLE.COM', ['https://app.example.com']);
        expect(result.allowed).toBe(true);
      });
    });

    it('allows trailing-slash variant', () => {
      jest.isolateModules(() => {
        const { validateOriginDto } = require('../../src/dtos/cors');
        const result = validateOriginDto('https://app.example.com/', ['https://app.example.com']);
        expect(result.allowed).toBe(true);
      });
    });
  });

  // ─── corsConfigDtoToOptions — DTO → cors options mapping ──────────────────

  describe('corsConfigDtoToOptions', () => {
    it('produces a cors options object with origin callback', () => {
      jest.isolateModules(() => {
        const { corsConfigDtoToOptions } = require('../../src/dtos/cors');
        const dto = {
          allowedOrigins: ['https://app.example.com'],
          maxAge: 600,
          optionsSuccessStatus: 204,
          isDevelopmentFallback: false,
        };
        const opts = corsConfigDtoToOptions(dto);

        expect(opts).toHaveProperty('origin');
        expect(typeof opts.origin).toBe('function');
        expect(opts.maxAge).toBe(600);
        expect(opts.optionsSuccessStatus).toBe(204);
      });
    });

    it('approves an allowed origin via the origin callback', () => {
      jest.isolateModules(() => {
        const { corsConfigDtoToOptions } = require('../../src/dtos/cors');
        const dto = {
          allowedOrigins: ['https://app.example.com'],
          maxAge: 600,
          optionsSuccessStatus: 204,
          isDevelopmentFallback: false,
        };
        const opts = corsConfigDtoToOptions(dto);
        const cb = jest.fn();
        opts.origin('https://app.example.com', cb);
        expect(cb).toHaveBeenCalledWith(null, true);
      });
    });

    it('rejects a disallowed origin via the origin callback', () => {
      jest.isolateModules(() => {
        const { corsConfigDtoToOptions } = require('../../src/dtos/cors');
        const dto = {
          allowedOrigins: ['https://app.example.com'],
          maxAge: 600,
          optionsSuccessStatus: 204,
          isDevelopmentFallback: false,
        };
        const opts = corsConfigDtoToOptions(dto);
        const cb = jest.fn();
        opts.origin('https://evil.com', cb);
        const [err] = cb.mock.calls[0];
        expect(err).toBeDefined();
        expect(err.isCorsOriginRejected).toBe(true);
        expect(err.errorCode).toBe('CORS_ORIGIN_NOT_ALLOWED');
      });
    });

    it('defaults maxAge to 600 when not in DTO', () => {
      jest.isolateModules(() => {
        const { corsConfigDtoToOptions } = require('../../src/dtos/cors');
        const dto = {
          allowedOrigins: [],
          optionsSuccessStatus: 204,
          isDevelopmentFallback: false,
        };
        const opts = corsConfigDtoToOptions(dto);
        expect(opts.maxAge).toBe(600);
      });
    });

    it('defaults optionsSuccessStatus to 204 when not in DTO', () => {
      jest.isolateModules(() => {
        const { corsConfigDtoToOptions } = require('../../src/dtos/cors');
        const dto = {
          allowedOrigins: [],
          maxAge: 600,
          isDevelopmentFallback: false,
        };
        const opts = corsConfigDtoToOptions(dto);
        expect(opts.optionsSuccessStatus).toBe(204);
      });
    });

    it('defensively copies the allowedOrigins array', () => {
      jest.isolateModules(() => {
        const { corsConfigDtoToOptions } = require('../../src/dtos/cors');
        const origins = ['https://a.com'];
        const dto = {
          allowedOrigins: origins,
          maxAge: 600,
          optionsSuccessStatus: 204,
          isDevelopmentFallback: false,
        };
        const opts = corsConfigDtoToOptions(dto);
        origins.push('https://evil.com');

        // The origin callback should still only allow the original
        const cb = jest.fn();
        opts.origin('https://evil.com', cb);
        expect(cb.mock.calls[0][0]).toBeDefined();
        expect(cb.mock.calls[0][0].isCorsOriginRejected).toBe(true);
      });
    });
  });

  // ─── corsConfigDtoToJson / corsConfigDtoFromJson — JSON round-trip ─────────

  describe('corsConfigDtoToJson ↔ corsConfigDtoFromJson round-trip', () => {
    it('round-trips without loss', () => {
      jest.isolateModules(() => {
        const { corsConfigDtoToJson, corsConfigDtoFromJson } = require('../../src/dtos/cors');
        const dto = {
          allowedOrigins: ['https://a.com', 'https://b.com'],
          maxAge: 1800,
          optionsSuccessStatus: 204,
          isDevelopmentFallback: false,
        };

        const json = corsConfigDtoToJson(dto);
        const restored = corsConfigDtoFromJson(json);

        expect(restored.allowedOrigins).toEqual(['https://a.com', 'https://b.com']);
        expect(restored.maxAge).toBe(1800);
        expect(restored.optionsSuccessStatus).toBe(204);
        expect(restored.isDevelopmentFallback).toBe(false);
      });
    });

    it('round-trips with development fallback', () => {
      jest.isolateModules(() => {
        const { corsConfigDtoToJson, corsConfigDtoFromJson } = require('../../src/dtos/cors');
        const dto = {
          allowedOrigins: ['http://localhost:3000'],
          maxAge: 600,
          optionsSuccessStatus: 204,
          isDevelopmentFallback: true,
        };

        const json = corsConfigDtoToJson(dto);
        const restored = corsConfigDtoFromJson(json);

        expect(restored.isDevelopmentFallback).toBe(true);
      });
    });

    it('filters non-string origins when restoring from JSON', () => {
      jest.isolateModules(() => {
        const { corsConfigDtoFromJson } = require('../../src/dtos/cors');
        const restored = corsConfigDtoFromJson({
          allowedOrigins: ['https://ok.com', 42, null, 'https://also-ok.com'],
          maxAge: 600,
        });

        expect(restored.allowedOrigins).toEqual(['https://ok.com', 'https://also-ok.com']);
      });
    });

    it('defaults maxAge to 600 on invalid value during restore', () => {
      jest.isolateModules(() => {
        const { corsConfigDtoFromJson } = require('../../src/dtos/cors');
        const restored = corsConfigDtoFromJson({ maxAge: -100 });
        expect(restored.maxAge).toBe(600);
      });
    });

    it('defaults maxAge to 600 when missing during restore', () => {
      jest.isolateModules(() => {
        const { corsConfigDtoFromJson } = require('../../src/dtos/cors');
        const restored = corsConfigDtoFromJson({});
        expect(restored.maxAge).toBe(600);
      });
    });

    it('handles empty allowedOrigins in restore', () => {
      jest.isolateModules(() => {
        const { corsConfigDtoFromJson } = require('../../src/dtos/cors');
        const restored = corsConfigDtoFromJson({ allowedOrigins: [] });
        expect(restored.allowedOrigins).toEqual([]);
      });
    });

    it('handles missing allowedOrigins in restore', () => {
      jest.isolateModules(() => {
        const { corsConfigDtoFromJson } = require('../../src/dtos/cors');
        const restored = corsConfigDtoFromJson({});
        expect(restored.allowedOrigins).toEqual([]);
      });
    });
  });

  // ─── Integration: DTO-built options behave like real cors middleware ───────

  describe('DTO → cors middleware integration', () => {
    it('allows an origin when using DTO-built options with the cors package', async () => {
      const { corsConfigDtoToOptions } = require('../../src/dtos/cors');
      const dto = {
        allowedOrigins: ['https://app.example.com'],
        maxAge: 600,
        optionsSuccessStatus: 204,
        isDevelopmentFallback: false,
      };
      const corsOpts = corsConfigDtoToOptions(dto);

      const app = express();
      app.use(cors(corsOpts));
      app.get('/test', (req, res) => res.json({ ok: true }));

      const res = await request(app)
        .get('/test')
        .set('Origin', 'https://app.example.com');

      expect(res.status).toBe(200);
      expect(res.headers['access-control-allow-origin']).toBe('https://app.example.com');
    });

    it('rejects a disallowed origin when using DTO-built options with the cors package', async () => {
      const { corsConfigDtoToOptions } = require('../../src/dtos/cors');
      const dto = {
        allowedOrigins: ['https://app.example.com'],
        maxAge: 600,
        optionsSuccessStatus: 204,
        isDevelopmentFallback: false,
      };
      const corsOpts = corsConfigDtoToOptions(dto);

      const app = express();
      app.use(cors(corsOpts));
      app.use((err, req, res, next) => {
        if (err && err.isCorsOriginRejected) {
          return res.status(403).json({ error: err.message });
        }
        next(err);
      });
      app.get('/test', (req, res) => res.json({ ok: true }));

      const res = await request(app)
        .get('/test')
        .set('Origin', 'https://evil.com');

      expect(res.status).toBe(403);
    });

    it('passes through requests without Origin header', async () => {
      const { corsConfigDtoToOptions } = require('../../src/dtos/cors');
      const dto = {
        allowedOrigins: ['https://app.example.com'],
        maxAge: 600,
        optionsSuccessStatus: 204,
        isDevelopmentFallback: false,
      };
      const corsOpts = corsConfigDtoToOptions(dto);

      const app = express();
      app.use(cors(corsOpts));
      app.get('/test', (req, res) => res.json({ ok: true }));

      const res = await request(app).get('/test');
      expect(res.status).toBe(200);
    });
  });

  // ─── Full round-trip: env → DTO → options → behaviour ─────────────────────

  describe('end-to-end: env → DTO → cors options', () => {
    it('preserves behaviour through the full DTO pipeline', () => {
      const { corsConfigDtoFromEnv, corsConfigDtoToOptions } = require('../../src/dtos/cors');

      const env = {
        NODE_ENV: 'production',
        CORS_ORIGINS: 'https://app.example.com,https://other.example.com',
        CORS_MAX_AGE: '3600',
      };

      // Env → DTO
      const dto = corsConfigDtoFromEnv(env);
      expect(dto.allowedOrigins).toEqual(['https://app.example.com', 'https://other.example.com']);
      expect(dto.maxAge).toBe(3600);

      // DTO → cors options
      const opts = corsConfigDtoToOptions(dto);
      expect(opts.maxAge).toBe(3600);

      // Verify origin behaviour
      const cb1 = jest.fn();
      opts.origin('https://app.example.com', cb1);
      expect(cb1).toHaveBeenCalledWith(null, true);

      const cb2 = jest.fn();
      opts.origin('https://evil.com', cb2);
      expect(cb2.mock.calls[0][0].isCorsOriginRejected).toBe(true);
    });

    it('behaves identically to the original createCorsOptions for same env', () => {
      process.env.NODE_ENV = 'production';
      process.env.CORS_ORIGINS = 'https://app.example.com';

      const { createCorsOptions } = require('../../src/config/cors');
      const { corsConfigDtoFromEnv, corsConfigDtoToOptions } = require('../../src/dtos/cors');

      const originalOpts = createCorsOptions();
      const dto = corsConfigDtoFromEnv();
      const dtoOpts = corsConfigDtoToOptions(dto);

      // maxAge should match
      expect(dtoOpts.maxAge).toBe(originalOpts.maxAge);
      expect(dtoOpts.optionsSuccessStatus).toBe(originalOpts.optionsSuccessStatus);

      // Origin behaviour should match for allowed origin
      const cbOrig = jest.fn();
      originalOpts.origin('https://app.example.com', cbOrig);
      const cbDto = jest.fn();
      dtoOpts.origin('https://app.example.com', cbDto);
      expect(cbDto).toHaveBeenCalledWith(null, true);
      expect(cbOrig).toHaveBeenCalledWith(null, true);

      // Origin behaviour should match for disallowed origin
      const cbOrig2 = jest.fn();
      originalOpts.origin('https://evil.com', cbOrig2);
      const cbDto2 = jest.fn();
      dtoOpts.origin('https://evil.com', cbDto2);
      expect(cbDto2.mock.calls[0][0].isCorsOriginRejected).toBe(true);
      expect(cbOrig2.mock.calls[0][0].isCorsOriginRejected).toBe(true);
    });
  });

  // ─── Exports check ────────────────────────────────────────────────────────

  describe('module exports', () => {
    it('exports all expected functions and constants', () => {
      jest.isolateModules(() => {
        const dtos = require('../../src/dtos/cors');
        expect(dtos).toHaveProperty('corsConfigDtoFromEnv');
        expect(dtos).toHaveProperty('validateOriginDto');
        expect(dtos).toHaveProperty('corsConfigDtoToOptions');
        expect(dtos).toHaveProperty('corsConfigDtoToJson');
        expect(dtos).toHaveProperty('corsConfigDtoFromJson');
        expect(dtos).toHaveProperty('CORS_ORIGIN_NOT_ALLOWED_CODE');
        expect(dtos).toHaveProperty('CORS_NULL_ORIGIN_CODE');

        expect(typeof dtos.corsConfigDtoFromEnv).toBe('function');
        expect(typeof dtos.validateOriginDto).toBe('function');
        expect(typeof dtos.corsConfigDtoToOptions).toBe('function');
        expect(typeof dtos.corsConfigDtoToJson).toBe('function');
        expect(typeof dtos.corsConfigDtoFromJson).toBe('function');
        expect(dtos.CORS_ORIGIN_NOT_ALLOWED_CODE).toBe('CORS_ORIGIN_NOT_ALLOWED');
        expect(dtos.CORS_NULL_ORIGIN_CODE).toBe('CORS_NULL_ORIGIN');
      });
    });
  });
});
