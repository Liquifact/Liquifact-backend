'use strict';

let Sentry = null;
let enabled = false;

const SENSITIVE_FIELD_NAMES = [
  'authorization',
  'token',
  'password',
  'secret',
  'x-api-key',
  'api-key',
  'apikey',
  'api_key',
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
  if (!key || typeof key !== 'string') { return false; }
  const lowerKey = key.toLowerCase();
  return SENSITIVE_FIELD_NAMES.some(name => lowerKey.includes(name.toLowerCase()));
}

/**
 * Checks if a string contains sensitive patterns
 * @param {string} value - The value to check
 * @returns {boolean} True if sensitive pattern found
 */
function hasSensitivePattern(value) {
  if (typeof value !== 'string') { return false; }
  
  if (value.length > MAX_STRING_LENGTH) {
    return true;
  }

  const patterns = [
    /invoice[_\s-]?[a-z0-9-]{6,}/i,
    /[a-f0-9]{32,}/,
    /[A-Za-z0-9+/]{40,}/,
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
  if (depth > MAX_DEPTH) {
    return '[MAX_DEPTH_REACHED]';
  }

  if (obj === null || obj === undefined) {
    return obj;
  }

  if (typeof obj !== 'object') {
    if (typeof obj === 'string' && hasSensitivePattern(obj)) {
      return REDACTED_INVOICE;
    }
    return obj;
  }

  if (Array.isArray(obj)) {
    return obj.map((item, index) => 
      deepScrub(item, depth + 1, `${path}[${index}]`)
    );
  }

  const scrubbed = {};
  for (const [key, value] of Object.entries(obj)) {
    if (isSensitiveKey(key)) {
      if (key.toLowerCase().includes('invoice')) {
        scrubbed[key] = REDACTED_INVOICE;
      } else {
        scrubbed[key] = REDACTED;
      }
      continue;
    }

    if (typeof value === 'string') {
      if (key.toLowerCase().includes('invoice') || /invoice/i.test(value)) {
        scrubbed[key] = REDACTED_INVOICE;
        continue;
      }

      if (hasSensitivePattern(value)) {
        scrubbed[key] = REDACTED;
        continue;
      }

      if (value.startsWith('http://') || value.startsWith('https://')) {
        scrubbed[key] = scrubUrl(value);
        continue;
      }
    }

    scrubbed[key] = deepScrub(value, depth + 1, `${path}.${key}`);
  }

  return scrubbed;
}

/**
 * Scrub URL query parameters and path segments
 * @param {string} urlString - The URL to scrub
 * @returns {string} Scrubbed URL
 */
function scrubUrl(urlString) {
  if (!urlString || typeof urlString !== 'string') {
    return urlString;
  }

  try {
    const url = require('url');
    const parsed = url.parse(urlString, true);
    
    if (parsed.query && typeof parsed.query === 'object') {
      const scrubbedQuery = deepScrub(parsed.query);
      const entries = Object.entries(scrubbedQuery);
      if (entries.length > 0) {
        parsed.search = '?' + entries.map(([k, v]) => `${k}=${v}`).join('&');
      }
    }

    if (parsed.pathname) {
      const pathSegments = parsed.pathname.split('/');
      const scrubbedSegments = pathSegments.map(segment => {
        if (/^[a-f0-9]{32,}$/i.test(segment) || 
            /invoice/i.test(segment) ||
            /^[A-Za-z0-9+/]{40,}$/.test(segment) ||
            /^[A-Za-z0-9\-_]{20,}$/.test(segment) ||
            /^INV[-_][a-z0-9]{4,}$/i.test(segment)) {
          return REDACTED_INVOICE;
        }
        return segment;
      });
      parsed.pathname = scrubbedSegments.join('/');
    }

    const formatted = url.format(parsed);
    // Avoid encoding plain text that url.parse treated as a bare pathname
    if (!parsed.protocol && !parsed.host && !/[\/?#]/.test(urlString)) {
      return urlString;
    }
    return formatted;
  } catch {
    return urlString;
  }
}

/**
 * Scrub request object
 * @param {Object} request - The request object
 * @returns {Object} Scrubbed request
 */
function scrubRequest(request) {
  if (!request) { return request; }

  const scrubbed = { ...request };

  if (scrubbed.headers) {
    scrubbed.headers = deepScrub(scrubbed.headers);
  }

  if (scrubbed.query_string) {
    scrubbed.query_string = scrubUrl(`?${scrubbed.query_string}`).replace(/^\?/, '');
  }

  if (scrubbed.url) {
    scrubbed.url = scrubUrl(scrubbed.url);
  }

  if (scrubbed.data) {
    if (typeof scrubbed.data === 'object') {
      scrubbed.data = deepScrub(scrubbed.data);
    } else if (typeof scrubbed.data === 'string') {
      try {
        const parsed = JSON.parse(scrubbed.data);
        scrubbed.data = JSON.stringify(deepScrub(parsed));
      } catch {
        if (hasSensitivePattern(scrubbed.data)) {
          scrubbed.data = REDACTED;
        }
      }
    }
  }

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
  if (!breadcrumbs) { return breadcrumbs; }
  if (!Array.isArray(breadcrumbs)) { return deepScrub(breadcrumbs); }

  return breadcrumbs.map(crumb => {
    if (typeof crumb !== 'object' || crumb === null) { return crumb; }
    
    const scrubbed = { ...crumb };
    
    if (scrubbed.message) {
      scrubbed.message = scrubUrl(scrubbed.message);
      if (hasSensitivePattern(scrubbed.message)) {
        scrubbed.message = REDACTED_INVOICE;
      }
    }
    
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

    if (scrubbed.request) {
      scrubbed.request = scrubRequest(scrubbed.request);
    }

    if (scrubbed.breadcrumbs) {
      scrubbed.breadcrumbs = scrubBreadcrumbs(scrubbed.breadcrumbs);
    }

    if (scrubbed.extra) {
      scrubbed.extra = deepScrub(scrubbed.extra);
    }

    if (scrubbed.contexts) {
      scrubbed.contexts = deepScrub(scrubbed.contexts);
    }

    if (scrubbed.user) {
      scrubbed.user = deepScrub(scrubbed.user);
    }

    if (scrubbed.tags) {
      scrubbed.tags = deepScrub(scrubbed.tags);
    }

    if (scrubbed.message && typeof scrubbed.message === 'string') {
      scrubbed.message = scrubUrl(scrubbed.message);
      if (hasSensitivePattern(scrubbed.message)) {
        scrubbed.message = REDACTED_INVOICE;
      }
    }

    return scrubbed;
  } catch (error) {
    console.error('Error scrubbing Sentry event:', error);
    return event;
  }
}

/**
 * Initializes Sentry with the configured DSN and settings.
 * @returns {void}
 */
function initSentry() {
  const dsn = process.env.SENTRY_DSN && process.env.SENTRY_DSN.trim();
  if (!dsn) {
    console.log('Sentry DSN not provided, observability disabled');
    return;
  }

  try {
    Sentry = require('@sentry/node');

    Sentry.init({
      dsn,
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
