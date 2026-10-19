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
  try {
    return {
      target: 'pino-pretty',
      options: { colorize: true, translateTime: 'SMS' },
    };
  } catch (_err) {
    return undefined;
  }
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

module.exports = logger;
module.exports.redactPaths = redactPaths;