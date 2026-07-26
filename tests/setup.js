/**
 * Global test setup
 * Ensures consistent environment across all tests
 */

process.env.NODE_ENV = 'test';

const { resetRouteMounts } = require('../src/utils/routeMountRegistry');

beforeEach(() => {
  resetRouteMounts();
});

// Silence console.error during tests (optional)
jest.spyOn(console, 'error').mockImplementation(() => {});
