/**
 * LiquiFact API Gateway
 * Express server bootstrap for invoice financing, auth, and Stellar integration.
 */

const { createApp } = require('./app');
const { RepositoryRegistry } = require('./repositories');

const PORT = process.env.PORT || 3001;

// Initialize repositories using the registry
const registry = new RepositoryRegistry();
const { invoiceRepo, escrowRepo } = registry;

// Create the app with dependencies
const app = createApp({
  invoiceRepo,
  escrowRepo
});

/**
 * Returns a server-like object that supertest can use.
 * When test mode, we wrap the app to be server-like for supertest.
 * @returns {Object} An object with a listen method and the app.
 */
const createServer = () => {
  const server = app.listen(PORT, () => {
    if (process.env.NODE_ENV !== 'test') {
      console.warn(`LiquiFact API running at http://localhost:${PORT}`);
    }
  });
  return server;
};

/**
 * Starts the Express server.
 *
 * @returns {import('http').Server} The started server.
 */
const startServer = () => {
  return createServer();
};

/**
 * Resets the in-memory store (for testing purposes).
 * 
 * @returns {void}
 */
const resetStore = () => {
  if (invoiceRepo.clear) {
    invoiceRepo.clear();
  }
};

// Start server if not in test mode
if (process.env.NODE_ENV !== 'test') {
  startServer();
}

// Export app and state for testing
module.exports = { app, startServer, resetStore };
