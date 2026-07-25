'use strict';

/**
 * Server entry point.
 * Binds the Express app to a port. Kept separate from app setup so
 * the app module can be imported in tests without starting a server.
 */

const app = require('./index');
const { validate, logRedactedSummary } = require('./config');
const shutdownCoordinator = require('./utils/shutdownCoordinator');

/**
 * Validates the application configuration at startup before the server starts listening.
 * In test environment, the validation is skipped to preserve lazy loading behavior.
 * Fails fast by logging a redacted summary of errors and exiting with a non-zero code.
 * @returns {void}
 */
function runBootConfigValidation() {
  if (process.env.NODE_ENV === 'test') {
    return;
  }
  try {
    validate();
  } catch (error) {
    logRedactedSummary(error);
    process.exit(1);
  }
}

runBootConfigValidation();

const PORT = process.env.PORT || 3001;

const server = app.listen(PORT, () => {
  console.log(`LiquiFact API running at http://localhost:${PORT}`);
});

shutdownCoordinator.register({ server });
shutdownCoordinator.setupSignalListeners();

