const {
  CORS_REJECTION_MESSAGE,
  createCorsOptions,
  createCorsRejectionError,
  getAllowedOriginsFromEnv,
  getDevelopmentFallbackOrigins,
  isCorsOriginRejectedError,
  parseAllowedOrigins,
} = require('./cors');

describe('CORS configuration helper', () => {
  describe('parseAllowedOrigins', () => {
    it('parses comma-separated origins', () => {
      expect(
        parseAllowedOrigins('https://app.example.com,https://admin.example.com')
      ).toEqual(['https://app.example.com', 'https://admin.example.com']);
    });

    it('trims whitespace and removes empty values', () => {
      expect(
        parseAllowedOrigins(' https://app.example.com, , https://admin.example.com ,,')
      ).toEqual(['https://app.example.com', 'https://admin.example.com']);
    });

    it('returns null for missing values', () => {
      expect(parseAllowedOrigins(undefined)).toBeNull();
    });
  });

  describe('getAllowedOriginsFromEnv', () => {
    it('uses the explicit allowlist when configured', () => {
      expect(
        getAllowedOriginsFromEnv({
          NODE_ENV: 'production',
          CORS_ALLOWED_ORIGINS: 'https://app.example.com,https://admin.example.com',
        })
      ).toEqual(['https://app.example.com', 'https://admin.example.com']);
    });

    it('uses development localhost fallback when unset in development', () => {
      expect(
        getAllowedOriginsFromEnv({
          NODE_ENV: 'development',
        })
      ).toEqual(getDevelopmentFallbackOrigins());
    });

    it('fails closed outside development when unset', () => {
      expect(
        getAllowedOriginsFromEnv({
          NODE_ENV: 'production',
        })
      ).toEqual([]);
    });
  });

  describe('createCorsOptions', () => {
    it('allows requests without an origin header', () => {
      const callback = jest.fn();

      createCorsOptions({
        NODE_ENV: 'production',
        CORS_ALLOWED_ORIGINS: 'https://app.example.com',
      }).origin(undefined, callback);

      expect(callback).toHaveBeenCalledWith(null, true);
    });

    it('rejects blocked origins with the dedicated CORS error', () => {
      const callback = jest.fn();

      createCorsOptions({
        NODE_ENV: 'production',
        CORS_ALLOWED_ORIGINS: 'https://app.example.com',
      }).origin('https://evil.example.com', callback);

      const [error] = callback.mock.calls[0];
      expect(error.message).toBe(CORS_REJECTION_MESSAGE);
      expect(error.status).toBe(403);
      expect(isCorsOriginRejectedError(error)).toBe(true);
    });
  });

  describe('CORS rejection helpers', () => {
    it('creates a 403 rejection error', () => {
      const error = createCorsRejectionError();

      expect(error.message).toBe(CORS_REJECTION_MESSAGE);
      expect(error.status).toBe(403);
    });

    it('does not classify unrelated errors as CORS rejections', () => {
      expect(isCorsOriginRejectedError(new Error('Other error'))).toBe(false);
    });
  });
});
