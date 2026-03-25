/**
 * Global test setup
 * Ensures consistent environment across all tests
 */

process.env.NODE_ENV = 'test';

// Silence console.error during tests (optional)
jest.spyOn(console, 'error').mockImplementation(() => {});