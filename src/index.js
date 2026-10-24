'use strict';

const app = require('./app');
const config = require('./config');
const logger = require('./logger');

if (require.main === module) {
  const server = app.listen(config.port, () => {
    logger.info(
      { port: config.port, env: config.env },
      `LiquiFact API listening on http://localhost:${config.port} (docs: /docs)`,
    );
  });

  const shutdown = (signal) => {
    logger.info({ signal }, 'shutting down');
    server.close(() => process.exit(0));
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

module.exports = app;
