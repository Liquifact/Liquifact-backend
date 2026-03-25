const express = require('express');
const errorHandler = require('../../src/middleware/errorHandler');

/**
 * Create a minimal Express app for isolated testing
 * @param {Function} routeSetup - function to define routes
 * @returns {Express.Application}
 */
const createTestApp = (routeSetup) => {
  const app = express();

  app.use(express.json());

  if (routeSetup) {
    routeSetup(app);
  }

  // Attach error handler last
  app.use(errorHandler);

  return app;
};

module.exports = createTestApp;