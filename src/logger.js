'use strict';

/**
 * Minimal structured logger for the LiquiFact backend.
 * Writes JSON lines to stdout (info/debug) and stderr (warn/error)
 * so log aggregators can parse them without a separate library.
 */

function log(level, message, meta = {}) {
  const entry = JSON.stringify({
    level,
    message,
    ...meta,
    timestamp: new Date().toISOString(),
    service: 'liquifact-api',
  });
  if (level === 'error' || level === 'warn') {
    process.stderr.write(entry + '\n');
  } else {
    process.stdout.write(entry + '\n');
  }
}

const logger = {
  info:  (message, meta) => log('info',  message, meta),
  debug: (message, meta) => log('debug', message, meta),
  warn:  (message, meta) => log('warn',  message, meta),
  error: (message, meta) => log('error', message, meta),
};

module.exports = logger;
