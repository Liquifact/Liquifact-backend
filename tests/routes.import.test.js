'use strict';

/**
 * @fileoverview Module-resolution smoke test.
 *
 * Every file under src/routes/ is required at runtime — a MISSING_MODULE
 * error in any of them (e.g. `require('../middleware/apiKey')` when the
 * file is actually `apiKeyAuth.js`) will crash the server on startup.
 *
 * This test simply requires every module under src/routes/ and fails loudly
 * if any of them throws MODULE_NOT_FOUND or any other load-time error,
 * preventing missing-module regressions from reaching production.
 *
 * @module tests/routes.import.test
 */

const fs = require('fs');
const path = require('path');

const ROUTES_DIR = path.resolve(__dirname, '..', 'src', 'routes');

/**
 * Recursively collects all `.js` file paths under a directory, excluding
 * `node_modules` and any file whose name or parent directory starts with `_`.
 *
 * @param {string} dir - Directory to walk.
 * @param {string[]} [files=[]] - Accumulator array.
 * @returns {string[]} Absolute file paths.
 */
function collectJsFiles(dir, files = []) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      // Skip hidden dirs and node_modules
      if (entry.name.startsWith('_') || entry.name === 'node_modules') continue;
      collectJsFiles(fullPath, files);
    } else if (entry.isFile() && entry.name.endsWith('.js') && !entry.name.startsWith('_')) {
      files.push(fullPath);
    }
  }
  return files;
}

describe('Route imports resolve without errors', () => {
  const routeFiles = collectJsFiles(ROUTES_DIR);

  test('at least one route file was discovered', () => {
    expect(routeFiles.length).toBeGreaterThan(0);
  });

  describe.each(routeFiles)('require(%s)', (filePath) => {
    // Derive a human-readable name: the path relative to src/routes/
    const relativePath = path.relative(ROUTES_DIR, filePath);
    const displayName = relativePath.startsWith('.') ? relativePath : `./${relativePath}`;

    it(`requires without throwing`, () => {
      // Clear the require cache for this file so the test always does a
      // fresh resolution and catches any new missing-module regressions.
      const resolved = require.resolve(filePath);
      delete require.cache[resolved];

      expect(() => {
        // The require itself — if this throws MODULE_NOT_FOUND or any
        // other error the test will fail with a clear message.
        require(filePath);
      }).not.toThrow();
    });
  });
});
