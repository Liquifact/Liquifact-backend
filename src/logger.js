'use strict';

/**
 * Structured JSON logger (pino) with request correlation IDs and secret
 * redaction.
 *
 * - JSON lines on stdout by default; pretty output when LOG_PRETTY=true.
 * - Level from LOG_LEVEL (default `info`; `silent` under Jest unless set).
 * - Authorization / API key / cookie headers and body fields named
 *   secret|seed|password|token are written as `[REDACTED]`.
 */

const crypto = require('crypto');
const pino = require('pino');

function resolveLevel() {
  if (process.env.LOG_LEVEL) {
    return process.env.LOG_LEVEL;
  }
  if (process.env.NODE_ENV === 'test' || process.env.JEST_WORKER_ID !== undefined) {
    return 'silent';
  }
  return 'info';
}

const redactPaths = [
  'req.headers.authorization',
  'req.headers["x-api-key"]',
  'req.headers.cookie',
  'headers.authorization',
  'headers["x-api-key"]',
  'headers.cookie',
  'body.secret',
  'body.seed',
  'body.password',
  'body.token',
  '*.secret',
  '*.seed',
  '*.password',
  '*.token',
];

/**
 * Destination indirection: log lines go to `currentStream`, which defaults to
 * process.stdout and can be swapped (e.g. by tests) via setDestination().
 */
let currentStream = null;
const destination = {
  write(chunk) {
    return (currentStream || process.stdout).write(chunk);
  },
};

const options = {
  level: resolveLevel(),
  base: undefined,
  redact: { paths: redactPaths, censor: '[REDACTED]' },
  serializers: { err: pino.stdSerializers.err },
};

const logger = process.env.LOG_PRETTY === 'true'
  ? pino({
    ...options,
    transport: { target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:standard' } },
  })
  : pino(options, destination);

/**
 * Redirect log output to another writable (an object with `write(chunk)`).
 * Pass `null` to restore stdout. Has no effect when LOG_PRETTY=true.
 * @param {{ write: (chunk: string) => unknown } | null} stream
 */
function setDestination(stream) {
  currentStream = stream;
}

const REQUEST_ID_PATTERN = /^[A-Za-z0-9._-]{8,128}$/;

/**
 * Assigns a correlation id to every request. An inbound `X-Request-Id` is
 * reused only when it matches REQUEST_ID_PATTERN (blocks newline/control
 * character injection); otherwise a random UUID is generated. The id is set
 * on `req.id`, echoed in the `X-Request-Id` response header, and a child
 * logger bound to it is exposed as `req.log`.
 */
function requestIdMiddleware(req, res, next) {
  const incoming = req.get('x-request-id');
  const id = incoming && REQUEST_ID_PATTERN.test(incoming) ? incoming : crypto.randomUUID();
  req.id = id;
  req.log = logger.child({ reqId: id });
  res.setHeader('X-Request-Id', id);
  next();
}

/**
 * The templated route for a request (e.g. `/api/invoices/:id`), or null when
 * no route matched. Must be read while the request is still inside its router,
 * because Express resets `req.baseUrl` once the router returns.
 */
function templatedRoute(req) {
  if (req.route && typeof req.route.path === 'string') {
    return `${req.baseUrl || ''}${req.route.path}`;
  }
  return null;
}

/**
 * Emits one structured access log line per completed request with
 * reqId, method, templated route, status, durationMs, contentLength and
 * userAgent. Request bodies and headers are never logged. `/health` is
 * logged at debug.
 */
function httpLogger(req, res, next) {
  const start = process.hrtime.bigint();
  let route = null;
  const originalEnd = res.end;
  res.end = function end(...args) {
    if (route === null) {
      route = templatedRoute(req);
    }
    return originalEnd.apply(this, args);
  };

  res.on('finish', () => {
    const durationMs = Number(process.hrtime.bigint() - start) / 1e6;
    const contentLength = res.getHeader('content-length');
    const entry = {
      reqId: req.id,
      method: req.method,
      route: route || 'unmatched',
      status: res.statusCode,
      durationMs: Math.round(durationMs * 100) / 100,
      contentLength: contentLength === undefined ? undefined : Number(contentLength),
      userAgent: req.get('user-agent'),
    };
    const level = req.path === '/health' ? 'debug' : 'info';
    logger[level](entry, 'request completed');
  });
  next();
}

module.exports = logger;
module.exports.logger = logger;
module.exports.redactPaths = redactPaths;
module.exports.REQUEST_ID_PATTERN = REQUEST_ID_PATTERN;
module.exports.requestIdMiddleware = requestIdMiddleware;
module.exports.httpLogger = httpLogger;
module.exports.setDestination = setDestination;
