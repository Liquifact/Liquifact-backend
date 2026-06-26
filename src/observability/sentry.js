'use strict';

const SENTRY_DSN = process.env.SENTRY_DSN && process.env.SENTRY_DSN.trim();
let Sentry = null;
let enabled = false;

const SENSITIVE_FIELD_NAMES = [
  'authorization',
  'auth',
  'token',
  'password',
  'secret',
  'x-api-key',
  'api-key',
  'apikey',
  'xdr',
  'stellar',
  'invoice',
  'private_key',
  'privateKey',
  'access_token',
  'refresh_token',
  'client_secret',
  'session',
  'cookie',
  'passphrase',
  'pin',
  'otp',
  '2fa'
];

const REDACTED = '[REDACTED]';
const REDACTED_INVOICE = '[REDACTED-INVOICE]';

// Security limits to prevent DoS
const MAX_DEPTH = 20;
const MAX_STRING_LENGTH = 10000;

/**
 * Checks if a key is sensitive (case-insensitive)
 * @param {string} key - The key to check
 * @returns {boolean} True if sensitive
 */
function isSensitiveKey(key) {
  if (!key || typeof key !== 'string') return false;
  const lowerKey = key.toLowerCase();
  return SENSITIVE_FIELD_NAMES.some(name => lowerKey.includes(name.toLowerCase()));
}

/**
 * Checks if a string contains sensitive patterns
 * @param {string} value - The value to check
 * @returns {boolean} True if sensitive pattern found
 */
function hasSensitivePattern(value) {
  if (typeof value !== 'string') return false;
  
  // Limit string length for performance
  if (value.length > MAX_STRING_LENGTH) {
    return true; // Redact long strings as precaution
  }

  const patterns = [
    /invoice[_\s-]?[a-z0-9]{6,}/i,
    /[a-f0-9]{32,}/,
    /[A-Za-z0-9+/]{40,}/,
    /sk_live_[a-zA-Z0-9]{24,}/,
    /rk_live_[a-zA-Z0-9]{24,}/,
    /Bearer\s+[A-Za-z0-9\-_.]+/i,
    /(?:eyJ|AAAA)[A-Za-z0-9_-]{20,}/
  ];

  return patterns.some(pattern => pattern.test(value));
}

/**
 * Deeply scrubs an object, redacting sensitive fields recursively
 * @param {any} obj - The object to scrub
 * @param {number} depth - Current recursion depth
 * @param {string} path - Current path for debugging
 * @returns {any} Scrubbed object
 */
function deepScrub(obj, depth = 0, path = '') {
  // Prevent DoS via deep recursion
  if (depth > MAX_DEPTH) {
    return '[MAX_DEPTH_REACHED]';
  }

  if (obj === null || obj === undefined) {
    return obj;
  }

  // Handle primitive types
  if (typeof obj !== 'object') {
    if (typeof obj === 'string' && hasSensitivePattern(obj)) {
      return REDACTED_INVOICE;
    }
    return obj;
  }

  // Handle arrays
  if (Array.isArray(obj)) {
    return obj.map((item, index) => 
      deepScrub(item, depth + 1, `${path}[${index}]`)
    );
  }

  // Handle objects
  const scrubbed = {};
  for (const [key, value] of Object.entries(obj)) {
    // Check if the key itself is sensitive
    if (isSensitiveKey(key)) {
      // Check if it's invoice-related for specific redaction
      if (key.toLowerCase().includes('invoice')) {
        scrubbed[key] = REDACTED_INVOICE;
      } else {
        scrubbed[key] = REDACTED;
      }
      continue;
    }

    // Check if value is a string with sensitive patterns
    if (typeof value === 'string') {
      // Check for invoice patterns
      if (key.toLowerCase().includes('invoice') || 
          (typeof value === 'string' && /invoice/i.test(value))) {
        scrubbed[key] = REDACTED_INVOICE;
        continue;
      }

      // Check for other sensitive patterns
      if (hasSensitivePattern(value)) {
        scrubbed[key] = REDACTED;
        continue;
      }

      // Check if it's a URL and scrub it
      if (value.startsWith('http://') || value.startsWith('https://')) {
        scrubbed[key] = scrubUrl(value);
        continue;
      }
    }

    // Recursively scrub nested values
    scrubbed[key] = deepScrub(value, depth + 1, `${path}.${key}`);
  }

  return scrubbed;
}

/**
 * Scrub URL query parameters and path segments
 * @param {string} urlString - The URL to scrub
 * @returns {string} Scrubbbed URL
 */
function scrubUrl(urlString) {
  if (!urlString || typeof urlString !== 'string') {
    return urlString;
  }

  try {
    const url = require('url');
    const parsed = url.parse(urlString, true);
    
    // Scrub query parameters
    if (parsed.query && typeof parsed.query === 'object') {
      const scrubbedQuery = deepScrub(parsed.query);
      parsed.search = url.stringify(scrubbedQuery, { encode: true });
    }

    // Scrub path segments that might contain sensitive data
    if (parsed.pathname) {
      const pathSegments = parsed.pathname.split('/');
      const scrubbedSegments = pathSegments.map(segment => {
        // Check if segment looks like an invoice ID, token, etc.
        if (/^[a-f0-9]{32,}$/i.test(segment) || 
            /invoice/i.test(segment) ||
            /^[A-Za-z0-9+/]{40,}$/.test(segment) ||
            /^[A-Za-z0-9\-_]{20,}$/.test(segment)) {
          return REDACTED_INVOICE;
        }
        return segment;
      });
      parsed.pathname = scrubbedSegments.join('/');
    }

    return url.format(parsed);
  } catch (error) {
    // If URL parsing fails, return the original string
    return urlString;
  }
}

/**
 * Scrub request object
 * @param {Object} request - The request object
 * @returns {Object} Scrubbed request
 */
function scrubRequest(request) {
  if (!request) return request;

  const scrubbed = { ...request };

  // Scrub headers
  if (scrubbed.headers) {
    scrubbed.headers = deepScrub(scrubbed.headers);
  }

  // Scrub query string
  if (scrubbed.query_string) {
    scrubbed.query_string = scrubUrl(`?${scrubbed.query_string}`).replace(/^\?/, '');
  }

  // Scrub URL
  if (scrubbed.url) {
    scrubbed.url = scrubUrl(scrubbed.url);
  }

  // Scrub body/data
  if (scrubbed.data) {
    if (typeof scrubbed.data === 'object') {
      scrubbed.data = deepScrub(scrubbed.data);
    } else if (typeof scrubbed.data === 'string') {
      // Try to parse JSON body
      try {
        const parsed = JSON.parse(scrubbed.data);
        scrubbed.data = JSON.stringify(deepScrub(parsed));
      } catch {
        // If not JSON, try to scrub as text
        if (hasSensitivePattern(scrubbed.data)) {
          scrubbed.data = REDACTED;
        }
      }
    }
  }

  // Scrub cookies if present
  if (scrubbed.cookies) {
    scrubbed.cookies = deepScrub(scrubbed.cookies);
  }

  return scrubbed;
}

/**
 * Scrub breadcrumbs
 * @param {Array|Object} breadcrumbs - The breadcrumbs to scrub
 * @returns {Array|Object} Scrubbed breadcrumbs
 */
function scrubBreadcrumbs(breadcrumbs) {
  if (!breadcrumbs) return breadcrumbs;
  if (!Array.isArray(breadcrumbs)) return deepScrub(breadcrumbs);

  return breadcrumbs.map(crumb => {
    if (typeof crumb !== 'object' || crumb === null) return crumb;
    
    const scrubbed = { ...crumb };
    
    // Scrub message
    if (scrubbed.message) {
      scrubbed.message = scrubUrl(scrubbed.message);
      if (hasSensitivePattern(scrubbed.message)) {
        scrubbed.message = REDACTED_INVOICE;
      }
    }
    
    // Scrub data
    if (scrubbed.data) {
      scrubbed.data = deepScrub(scrubbed.data);
    }
    
    return scrubbed;
  });
}

/**
 * Scrubs sensitive information from a Sentry event.
 * @param {Object} event - The Sentry event object.
 * @returns {Object} The scrubbed event object.
 */
function scrubEvent(event) {
  if (!event || typeof event !== 'object') {
    return event;
  }

  try {
    const scrubbed = { ...event };

    // Scrub request
    if (scrubbed.request) {
      scrubbed.request = scrubRequest(scrubbed.request);
    }

    // Scrub breadcrumbs
    if (scrubbed.breadcrumbs) {
      scrubbed.breadcrumbs = scrubBreadcrumbs(scrubbed.breadcrumbs);
    }

    // Scrub extra data
    if (scrubbed.extra) {
      scrubbed.extra = deepScrub(scrubbed.extra);
    }

    // Scrub contexts
    if (scrubbed.contexts) {
      scrubbed.contexts = deepScrub(scrubbed.contexts);
    }

    // Scrub user data
    if (scrubbed.user) {
      scrubbed.user = deepScrub(scrubbed.user);
    }

    // Scrub tags
    if (scrubbed.tags) {
      scrubbed.tags = deepScrub(scrubbed.tags);
    }

    // Scrub message if it contains sensitive data
    if (scrubbed.message && typeof scrubbed.message === 'string') {
      scrubbed.message = scrubUrl(scrubbed.message);
      if (hasSensitivePattern(scrubbed.message)) {
        scrubbed.message = REDACTED_INVOICE;
      }
    }

    return scrubbed;
  } catch (error) {
    console.error('Error scrubbing Sentry event:', error);
    return event; // Return original event if scrubbing fails
  }
}

/**
 * Initializes Sentry with the configured DSN and settings.
 * @returns {void}
 */
function initSentry() {
  if (!SENTRY_DSN) {
    console.log('Sentry DSN not provided, observability disabled');
    return;
  }

  try {
    Sentry = require('@sentry/node');

    Sentry.init({
      dsn: SENTRY_DSN,
      release: process.env.SENTRY_RELEASE || process.env.npm_package_version || 'liquifact-backend@unknown',
      environment: process.env.SENTRY_ENVIRONMENT || process.env.NODE_ENV || 'development',
      attachStacktrace: true,
      normalizeDepth: 5,
      beforeSend: scrubEvent,
      beforeSendTransaction: scrubEvent,
    });

    enabled = true;
    console.log('Sentry initialized with enhanced event scrubbing');
  } catch (err) {
    enabled = false;
    console.warn('Sentry initialization failed:', err.message || err);
  }
}

/**
 * Returns the Sentry request handler middleware.
 * @returns {import('express').RequestHandler} Express middleware.
 */
function requestHandler() {
  if (!enabled || !Sentry || !Sentry.Handlers || !Sentry.Handlers.requestHandler) {
    return (req, res, next) => next();
  }

  return Sentry.Handlers.requestHandler();
}

/**
 * Captures an exception and sends it to Sentry, including request context if provided.
 * @param {Error} error - The exception to capture.
 * @param {import('express').Request} [req] - The Express request object.
 * @returns {void}
 */
function captureException(error, req) {
  if (!enabled || !Sentry || !Sentry.withScope || !Sentry.captureException) {
    return;
  }

  Sentry.withScope((scope) => {
    if (req && scope) {
      const setTag = scope.setTag ? scope.setTag.bind(scope) : () => {};
      const setExtra = scope.setExtra ? scope.setExtra.bind(scope) : () => {};
      const setUser = scope.setUser ? scope.setUser.bind(scope) : () => {};

      setTag('request_id', req.id || 'unknown');
      setTag('method', req.method || 'unknown');
      setTag('url', req.originalUrl || req.url || 'unknown');
      setExtra('headers', deepScrub(req.headers || {}));
      setExtra('query', deepScrub(req.query || {}));
      setExtra('body', deepScrub(req.body || {}));
      if (req.user) {
        setUser(deepScrub(req.user));
      }
    }

    Sentry.captureException(error);
  });
}

module.exports = {
  initSentry,
  requestHandler,
  captureException,
  isEnabled: () => enabled,
  scrubEvent,
  deepScrub,
  scrubUrl,
  scrubRequest,
  scrubBreadcrumbs,
  isSensitiveKey,
  hasSensitivePattern,
  REDACTED,
  REDACTED_INVOICE,
  MAX_DEPTH,
  SENSITIVE_FIELD_NAMES
};
