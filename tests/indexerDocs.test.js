'use strict';

const fs = require('fs');
const path = require('path');

describe('indexer examples documentation', () => {
  test('documents the admin indexer route with runnable curl examples', () => {
    const docPath = path.join(__dirname, '..', 'docs', 'indexer-examples.md');
    expect(fs.existsSync(docPath)).toBe(true);

    const content = fs.readFileSync(docPath, 'utf8');
    expect(content).toContain('/api/admin/indexer/events');
    expect(content).toContain('Authorization: Bearer');
    expect(content).toContain('X-API-Key');
    expect(content).toContain('x-tenant-id');
    expect(content).toContain('curl');
  });
});
