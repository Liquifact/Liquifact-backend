const crypto = require('crypto');
const pino = require('pino');

function resolveLevel() {
  if (process.env.LOG_LEVEL) {
    return process.env.LOG_LEVEL;
  }
  if (process.env.NODE_ENV === 'test') {
    return 'silent';
  }
  return 'info';
}

function buildTransport() {
  const pretty = process.env.LOG_PRETTY === 'true';
  if (!pretty) {
    return undefined;
  }
  return {
    target: 'pino-pretty',
    options: { colorize: true, translateTime: 'SMS' },
  };
}

const redactPaths = [
  'req.headers.authorization',
  'req.headers["x-api-key"]',
  'req.headers.cookie',
  '*.secret',
  '*.seed',
  '*.password',
  '*.token',
];

const logger = pino.pino({
  level: resolveLevel(),
  redact: {
    paths: redactPaths,
    censor: '[REDACTED]',
    remove: false,
  },
  transport: buildTransport(),
  base: undefined,
});

const REQUEST_ID_PATTERN = /^[a-zA-Z0-9._-]{1,128}$/;

/**
 * Assigns a request id to every request. An incoming `x-request-id` header is
 * reused when it is a safe token; otherwise a UUID is generated. The id is
 * exposed as `req.id` and echoed back in the `x-request-id` response header.
 */
function requestIdMiddleware(req, res, next) {
  const incoming = req.get('x-request-id');
  const id = incoming && REQUEST_ID_PATTERN.test(incoming) ? incoming : crypto.randomUUID();
  req.id = id;
  res.setHeader('x-request-id', id);
  next();
}

/**
 * Emits one structured log line per completed request with the request id,
 * method, path, status code and duration in milliseconds.
 */
function httpLogger(req, res, next) {
  const start = process.hrtime.bigint();
  res.on('finish', () => {
    const durationMs = Number(process.hrtime.bigint() - start) / 1e6;
    const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info';
    logger[level](
      {
        reqId: req.id,
        method: req.method,
        url: req.originalUrl || req.url,
        statusCode: res.statusCode,
        durationMs: Math.round(durationMs * 100) / 100,
      },
      'request completed',
    );
  });
  next();
}

module.exports = logger;
module.exports.logger = logger;
module.exports.redactPaths = redactPaths;
module.exports.requestIdMiddleware = requestIdMiddleware;
module.exports.httpLogger = httpLogger;
