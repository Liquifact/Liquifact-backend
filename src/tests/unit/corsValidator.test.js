const { validateCorsOrigin } = require('../../utils/corsValidator');

describe('CORS Validation Helper', () => {
  const allowedOrigins = ['https://liquifact.com', 'https://api.liquifact.com'];

  it('should allow requests with a valid, whitelisted origin', () => {
    expect(validateCorsOrigin('https://liquifact.com', allowedOrigins)).toBe(true);
  });

  it('should allow requests with no origin (e.g., non-browser/server-to-server requests)', () => {
    expect(validateCorsOrigin(undefined, allowedOrigins)).toBe(true);
  });

  it('should allow all origins if the wildcard "*" is in the allowed list', () => {
    expect(validateCorsOrigin('https://random-site.com', ['*'])).toBe(true);
  });

  it('should reject requests with an unlisted origin with the correct message', () => {
    expect(() => validateCorsOrigin('https://malicious.com', allowedOrigins))
      .toThrow('Not allowed by CORS');
  });

  it('should attach a 403 status code to the rejection error', () => {
    try {
      validateCorsOrigin('https://malicious.com', allowedOrigins);
      expect(true).toBe(false); 
    } catch (error) {
      expect(error.status).toBe(403);
    }
  });
});