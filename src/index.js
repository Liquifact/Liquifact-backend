'use strict';

let app;
let config;

try {
  config = require('./config');
  app = require('./app');
} catch (err) {
  if (err && err.name === 'ConfigError') {
    console.error(err.message);
    process.exit(1);
  }
  throw err;
}

if (require.main === module) {
  const { createServer, installSignalHandlers } = require('./server');
  const server = createServer(app);
  installSignalHandlers(server, { timeoutMs: config.shutdownTimeoutMs });
  server.listen(config.port, () => {
    console.log(`LiquiFact API listening on http://localhost:${config.port} (docs: /docs)`);
  });
}

module.exports = app;
