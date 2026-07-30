'use strict';

/**
 * @fileoverview Unit tests for the streaming CSV helpers exported by
 * auditLogStore: escapeCsvField, rowToCsvLine, createCsvTransform, and
 * streamAuditEvents.
 *
 * All database interactions are replaced by in-process mock streams so
 * that these tests run entirely without a real database connection.
 */

const { Readable, Writable, pipeline } = require('stream');
const { promisify } = require('util');

const pipelineAsync = promisify(pipeline);

jest.mock('../src/db/knex');

const defaultKnex = require('../src/db/knex');

const {
  escapeCsvField,
  CSV_HEADERS,
  REDACTED,
  appendAuditEvent,
  redactValue,
  normalizeMetadata,
  rowToCsvLine,
  createCsvTransform,
  streamAuditEvents,
} = require('../src/services/auditLogStore');

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Collects all string chunks emitted by a readable into one string. */
function collectStream(readable) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    readable.on('data', (chunk) => chunks.push(String(chunk)));
    readable.on('end', () => resolve(chunks.join('')));
    readable.on('error', reject);
  });
}

/** Creates an object-mode Readable that emits the supplied rows then ends. */
function rowsToStream(rows) {
  return Readable.from(rows, { objectMode: true });
}

/** Builds a minimal audit_log_events DB row. */
function makeRow(overrides = {}) {
  return {
    id: 1,
    created_at: new Date('2024-01-15T10:00:00Z'),
    actor_id: 'admin-1',
    action: 'UPDATE',
    target_type: 'invoice',
    target_id: 'inv-001',
    status_code: 200,
    ip_address: '127.0.0.1',
    user_agent: 'Mozilla/5.0',
    ...overrides,
  };
}

// ── escapeCsvField ────────────────────────────────────────────────────────────

describe('escapeCsvField', () => {
  it('returns plain values unchanged', () => {
    expect(escapeCsvField('hello')).toBe('hello');
    expect(escapeCsvField(42)).toBe('42');
    expect(escapeCsvField(200)).toBe('200');
  });

  it('converts null / undefined to empty string', () => {
    expect(escapeCsvField(null)).toBe('');
    expect(escapeCsvField(undefined)).toBe('');
  });

  it('wraps values containing commas in double-quotes', () => {
    expect(escapeCsvField('a,b,c')).toBe('"a,b,c"');
  });

  it('wraps values containing double-quotes and doubles them (RFC 4180)', () => {
    expect(escapeCsvField('say "hello"')).toBe('"say ""hello"""');
  });

  it('wraps values containing newlines', () => {
    expect(escapeCsvField('line1\nline2')).toBe('"line1\nline2"');
  });

  // Formula-injection safety (OWASP / spreadsheet DDE)
  it('prefixes = with a single quote to neutralise formula injection', () => {
    expect(escapeCsvField('=SUM(A1:A10)')).toBe("'=SUM(A1:A10)");
  });

  it('prefixes + with a single quote', () => {
    expect(escapeCsvField('+cmd|...')).toBe("'+cmd|...");
  });

  it('prefixes - with a single quote', () => {
    expect(escapeCsvField('-2+3')).toBe("'-2+3");
  });

  it('prefixes @ with a single quote', () => {
    expect(escapeCsvField('@SUM(1+1)')).toBe("'@SUM(1+1)");
  });

  it('handles a value that needs both injection-prefix and quoting (comma)', () => {
    // =HYPERLINK("...","click") — starts with =, contains a comma
    const val = '=HYPERLINK("url","click")';
    const result = escapeCsvField(val);
    // Should be prefixed with ' then wrapped because it now contains quotes
    expect(result.startsWith("\"'=")).toBe(true);
    expect(result.endsWith('"')).toBe(true);
  });

  it('leaves a normal leading hyphen in a negative number unaffected (numeric)', () => {
    // Numbers are coerced to string; "-100" starts with - so it gets prefixed
    expect(escapeCsvField(-100)).toBe("'-100");
  });

  // ── Leading-whitespace regression (issue fix) ─────────────────────────────

  it('neutralizes a field with a leading space then "=" (whitespace bypass)', () => {
    expect(escapeCsvField(' =HYPERLINK("http://evil.com")')).toBe(
      '"\' =HYPERLINK(""http://evil.com"")"'
    );
  });

  it('neutralizes a field with multiple leading spaces then "+"', () => {
    expect(escapeCsvField('   +cmd')).toBe("'   +cmd");
  });

  it('neutralizes a field with a leading tab then "=" (tab-prefix bypass)', () => {
    expect(escapeCsvField('\t=MALICIOUS()')).toBe("'\t=MALICIOUS()");
  });

  it('neutralizes a field with a leading carriage return then "="', () => {
    expect(escapeCsvField('\r=MALICIOUS()')).toBe('"\'\r=MALICIOUS()"');
  });

  it('neutralizes a field with leading space then "-"', () => {
    expect(escapeCsvField(' -2+3')).toBe("' -2+3");
  });

  it('neutralizes a field with leading space then "@"', () => {
    expect(escapeCsvField(' @SUM(1)')).toBe("' @SUM(1)");
  });

  // ── Pipe (|) prefix (OWASP DDE) ──────────────────────────────────────────

  it('prefixes | with a single quote (DDE/pipe injection)', () => {
    expect(escapeCsvField('|calc.exe')).toBe("'|calc.exe");
  });

  it('neutralizes a field with leading space then "|"', () => {
    expect(escapeCsvField(' |calc.exe')).toBe("' |calc.exe");
  });

  // ── Whitespace-only and all-whitespace edge cases ─────────────────────────

  it('does not prefix whitespace-only values', () => {
    expect(escapeCsvField('   ')).toBe('   ');
    expect(escapeCsvField('\t')).toBe('\t');
  });

  it.each([
    ['=', '=SUM(A1:A2)', "'=SUM(A1:A2)"],
    ['+', '+SUM(A1:A2)', "'+SUM(A1:A2)"],
    ['-', '-SUM(A1:A2)', "'-SUM(A1:A2)"],
    ['@', '@SUM(A1:A2)', "'@SUM(A1:A2)"],
    ['|', '|calc.exe', "'|calc.exe"],
    ['leading space', '  =SUM(A1:A2)', "'  =SUM(A1:A2)"],
    ['leading tab', '\t=SUM(A1:A2)', "'\t=SUM(A1:A2)"],
    ['leading CR', '\r=SUM(A1:A2)', '"\'\r=SUM(A1:A2)"'],
  ])('neutralizes formula lead %s', (_label, value, expected) => {
    expect(escapeCsvField(value)).toBe(expected);
  });
});

// ── redactValue / normalizeMetadata ──────────────────────────────────────────

describe('redactValue and normalizeMetadata', () => {
  it('preserves null and undefined values when redacting leaf values', () => {
    expect(redactValue(null)).toBeNull();
    expect(redactValue(undefined)).toBeUndefined();
  });

  it('redacts every sensitive key pattern recursively', () => {
    const input = {
      password: 'p',
      clientSecret: 's',
      refresh_token: 't',
      apiKey: 'api',
      'api-key': 'api-dash',
      authorization: 'Bearer secret',
      private_key: 'pk',
      privateKey: 'pk2',
      seedPhrase: 'seed',
      mnemonic: 'words',
      nested: {
        tokenValue: 'nested-token',
        safe: 'keep',
        list: [{ passwordHash: 'hash' }, { value: 'plain' }],
      },
    };

    expect(redactValue(input)).toEqual({
      password: REDACTED,
      clientSecret: REDACTED,
      refresh_token: REDACTED,
      apiKey: REDACTED,
      'api-key': REDACTED,
      authorization: REDACTED,
      private_key: REDACTED,
      privateKey: REDACTED,
      seedPhrase: REDACTED,
      mnemonic: REDACTED,
      nested: {
        tokenValue: REDACTED,
        safe: 'keep',
        list: [{ passwordHash: REDACTED }, { value: 'plain' }],
      },
    });
  });

  it('normalizes non-object metadata to an empty object', () => {
    expect(normalizeMetadata(null)).toEqual({});
    expect(normalizeMetadata('tenant-alpha')).toEqual({});
  });

  it('returns redacted metadata for object input', () => {
    expect(normalizeMetadata({ tenantId: 'tenant-alpha', token: 'secret' })).toEqual({
      tenantId: 'tenant-alpha',
      token: REDACTED,
    });
  });
});

// ── appendAuditEvent ──────────────────────────────────────────────────────────

describe('appendAuditEvent', () => {
  beforeEach(() => {
    defaultKnex.mockReset();
  });

  it('serializes a normalized, redacted audit event record', async () => {
    const insert = jest.fn().mockResolvedValue();
    const mockKnex = jest.fn(() => ({ insert }));

    await appendAuditEvent(
      {
        eventType: 'invoice.updated',
        action: 'UPDATE',
        actorType: 'user',
        actorId: 'actor-1',
        targetType: 'invoice',
        targetId: 'inv-001',
        requestId: 'req-1',
        route: '/api/invoices/inv-001',
        method: 'PATCH',
        statusCode: 200,
        ipAddress: '127.0.0.1',
        userAgent: 'jest',
        metadata: {
          tenantId: 'tenant-alpha',
          authorization: 'Bearer secret',
          nested: { apiKey: 'key' },
        },
      },
      { db: mockKnex }
    );

    expect(mockKnex).toHaveBeenCalledWith('audit_log_events');
    expect(insert).toHaveBeenCalledWith({
      event_type: 'invoice.updated',
      action: 'UPDATE',
      actor_type: 'user',
      actor_id: 'actor-1',
      target_type: 'invoice',
      target_id: 'inv-001',
      request_id: 'req-1',
      route: '/api/invoices/inv-001',
      method: 'PATCH',
      status_code: 200,
      ip_address: '127.0.0.1',
      user_agent: 'jest',
      metadata: JSON.stringify({
        tenantId: 'tenant-alpha',
        authorization: REDACTED,
        nested: { apiKey: REDACTED },
      }),
    });
  });

  it('uses the default database and nulls missing optional fields', async () => {
    const insert = jest.fn().mockResolvedValue();
    defaultKnex.mockReturnValue({ insert });

    await appendAuditEvent({
      eventType: 'system.audit',
      action: 'CREATE',
      actorType: 'system',
      actorId: 'system',
      statusCode: '200',
      metadata: null,
    });

    expect(defaultKnex).toHaveBeenCalledWith('audit_log_events');
    expect(insert).toHaveBeenCalledWith({
      event_type: 'system.audit',
      action: 'CREATE',
      actor_type: 'system',
      actor_id: 'system',
      target_type: null,
      target_id: null,
      request_id: null,
      route: null,
      method: null,
      status_code: null,
      ip_address: null,
      user_agent: null,
      metadata: JSON.stringify({}),
    });
  });
});

// ── rowToCsvLine ──────────────────────────────────────────────────────────────

describe('rowToCsvLine', () => {
  it('produces correct column order matching CSV_HEADERS', () => {
    const row = makeRow();
    const line = rowToCsvLine(row);
    const parts = line.split(',');
    expect(parts).toHaveLength(CSV_HEADERS.length);
    expect(parts[2]).toBe('admin-1'); // actor
    expect(parts[3]).toBe('UPDATE');  // action
    expect(parts[5]).toBe('inv-001'); // resourceId
  });

  it('escapes comma-containing actor names', () => {
    const row = makeRow({ actor_id: 'alice,bob' });
    expect(rowToCsvLine(row)).toContain('"alice,bob"');
  });

  it('escapes formula-injection actors', () => {
    const row = makeRow({ actor_id: '=MALICIOUS()' });
    expect(rowToCsvLine(row)).toContain("'=MALICIOUS()");
  });

  it('handles null optional fields gracefully', () => {
    const row = makeRow({ ip_address: null, user_agent: null, status_code: null });
    const line = rowToCsvLine(row);
    // Should not throw and trailing commas represent empty fields
    expect(typeof line).toBe('string');
    expect(line.endsWith(',,')).toBe(true);
  });
});

// ── createCsvTransform ────────────────────────────────────────────────────────

describe('createCsvTransform', () => {
  it('emits header-only when given zero rows (empty trail)', async () => {
    const src = rowsToStream([]);
    const transform = createCsvTransform();
    const output = await collectStream(src.pipe(transform));
    expect(output.trim()).toBe(CSV_HEADERS.join(','));
  });

  it('emits header + one data row for a single row', async () => {
    const row = makeRow();
    const src = rowsToStream([row]);
    const transform = createCsvTransform();
    const output = await collectStream(src.pipe(transform));
    const lines = output.split('\n').filter(Boolean);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe(CSV_HEADERS.join(','));
    expect(lines[1]).toContain('admin-1');
  });

  it('emits header + N data rows for N rows (large trail)', async () => {
    const N = 500;
    const rows = Array.from({ length: N }, (_, i) =>
      makeRow({ id: i + 1, target_id: `inv-${i}` })
    );
    const src = rowsToStream(rows);
    const transform = createCsvTransform();
    const output = await collectStream(src.pipe(transform));
    const lines = output.split('\n').filter(Boolean);
    expect(lines).toHaveLength(N + 1); // header + N rows
  });

  it('escapes formula-injection in streamed rows', async () => {
    const row = makeRow({ actor_id: '=CMD()' });
    const src = rowsToStream([row]);
    const transform = createCsvTransform();
    const output = await collectStream(src.pipe(transform));
    expect(output).toContain("'=CMD()");
    expect(output).not.toMatch(/(^|,)=CMD\(\)(,|\n)/m);
  });

  it('escapes commas in streamed field values', async () => {
    const row = makeRow({ actor_id: 'alice,bob' });
    const src = rowsToStream([row]);
    const transform = createCsvTransform();
    const output = await collectStream(src.pipe(transform));
    expect(output).toContain('"alice,bob"');
  });

  it('escapes double-quotes in streamed field values', async () => {
    const row = makeRow({ actor_id: 'admin"quoted"' });
    const src = rowsToStream([row]);
    const transform = createCsvTransform();
    const output = await collectStream(src.pipe(transform));
    expect(output).toContain('"admin""quoted"""');
  });

  it('propagates upstream errors through the stream pipeline', async () => {
    const src = new Readable({
      objectMode: true,
      read() {
        this.emit('error', new Error('db error'));
      },
    });
    const transform = createCsvTransform();
    const sink = new Writable({
      write(_chunk, _enc, callback) {
        callback();
      },
    });

    await expect(pipelineAsync(src, transform, sink)).rejects.toThrow('db error');
  });

  it('propagates row serialization errors through the stream pipeline', async () => {
    const badRow = makeRow();
    Object.defineProperty(badRow, 'id', {
      get() {
        throw new Error('bad row');
      },
    });
    const transform = createCsvTransform();
    const sink = new Writable({
      write(_chunk, _enc, callback) {
        callback();
      },
    });

    await expect(pipelineAsync(rowsToStream([badRow]), transform, sink)).rejects.toThrow('bad row');
  });

  it('writes only one header row across multiple rows', async () => {
    const rows = [makeRow({ id: 1 }), makeRow({ id: 2 }), makeRow({ id: 3 })];
    const src = rowsToStream(rows);
    const transform = createCsvTransform();
    const output = await collectStream(src.pipe(transform));
    const headerOccurrences = output.split(CSV_HEADERS.join(',')).length - 1;
    expect(headerOccurrences).toBe(1);
  });
});

// ── streamAuditEvents ─────────────────────────────────────────────────────────

describe('streamAuditEvents', () => {
  beforeEach(() => {
    defaultKnex.mockReset();
  });

  /**
   * Builds a tiny mock Knex that records how it was called and returns a
   * Readable stream of the supplied rows when `.stream()` is invoked.
   */
  function makeMockKnex(rows = []) {
    const filters = {};
    const mockQuery = {
      select: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      where: jest.fn((column, value) => {
        filters[column] = value;
        return mockQuery;
      }),
      whereRaw: jest.fn((_sql, params) => {
        filters.tenantId = params[0];
        return mockQuery;
      }),
      stream: jest.fn(() => rowsToStream(rows.filter((row) => rowMatchesFilters(row, filters)))),
    };
    const knex = jest.fn(() => mockQuery);
    knex._query = mockQuery;
    knex._filters = filters;
    return knex;
  }

  it('calls .stream() on the knex query builder', () => {
    const mockKnex = makeMockKnex([]);
    streamAuditEvents({}, { db: mockKnex });
    expect(mockKnex._query.stream).toHaveBeenCalledTimes(1);
  });

  it('uses the default database when no db option is provided', async () => {
    const mockKnex = makeMockKnex([makeRow({ id: 7, actor_id: 'default-db-user' })]);
    defaultKnex.mockImplementation(mockKnex);

    const output = await collectStream(streamAuditEvents().pipe(createCsvTransform()));

    expect(defaultKnex).toHaveBeenCalledWith('audit_log_events');
    expect(output).toContain('default-db-user');
  });

  it('applies targetId filter when provided', () => {
    const mockKnex = makeMockKnex([]);
    streamAuditEvents({ targetId: 'inv-123' }, { db: mockKnex });
    expect(mockKnex._query.where).toHaveBeenCalledWith('target_id', 'inv-123');
  });

  it('applies targetType filter when provided', () => {
    const mockKnex = makeMockKnex([]);
    streamAuditEvents({ targetType: 'invoice' }, { db: mockKnex });
    expect(mockKnex._query.where).toHaveBeenCalledWith('target_type', 'invoice');
  });

  it('applies tenantId filter via whereRaw on the JSONB column', () => {
    const mockKnex = makeMockKnex([]);
    streamAuditEvents({ tenantId: 'tenant-alpha' }, { db: mockKnex });
    expect(mockKnex._query.whereRaw).toHaveBeenCalledWith(
      "metadata->>'tenantId' = ?",
      ['tenant-alpha']
    );
  });

  it('does NOT call whereRaw when tenantId is omitted', () => {
    const mockKnex = makeMockKnex([]);
    streamAuditEvents({ targetId: 'inv-1' }, { db: mockKnex });
    expect(mockKnex._query.whereRaw).not.toHaveBeenCalled();
  });

  it('streams rows through to createCsvTransform correctly', async () => {
    const rows = [makeRow({ id: 1 }), makeRow({ id: 2 })];
    const mockKnex = makeMockKnex(rows);

    const dbStream = streamAuditEvents({ targetId: 'inv-001' }, { db: mockKnex });
    const transform = createCsvTransform();
    const output = await collectStream(dbStream.pipe(transform));

    const lines = output.split('\n').filter(Boolean);
    expect(lines[0]).toBe(CSV_HEADERS.join(','));
    expect(lines).toHaveLength(3); // header + 2 rows
  });

  it('does not emit cross-tenant rows when tenantId is provided', async () => {
    const rows = [
      makeRow({ id: 1, actor_id: 'tenant-a-user', metadata: { tenantId: 'tenant-a' } }),
      makeRow({ id: 2, actor_id: 'tenant-b-user', metadata: { tenantId: 'tenant-b' } }),
      makeRow({ id: 3, actor_id: 'tenant-a-admin', metadata: JSON.stringify({ tenantId: 'tenant-a' }) }),
    ];
    const mockKnex = makeMockKnex(rows);

    const dbStream = streamAuditEvents({ tenantId: 'tenant-a' }, { db: mockKnex });
    const output = await collectStream(dbStream.pipe(createCsvTransform()));

    expect(output).toContain('tenant-a-user');
    expect(output).toContain('tenant-a-admin');
    expect(output).not.toContain('tenant-b-user');
  });

  it('returns a readable stream (not a plain array)', () => {
    const mockKnex = makeMockKnex([]);
    const result = streamAuditEvents({}, { db: mockKnex });
    expect(typeof result.pipe).toBe('function');
    expect(typeof result.on).toBe('function');
  });
});

/**
 * Applies the mock query-builder filters used by makeMockKnex.
 *
 * @param {object} row Audit log row.
 * @param {object} filters Captured filters.
 * @returns {boolean} True when the row matches all filters.
 */
function rowMatchesFilters(row, filters) {
  if (filters.target_id && row.target_id !== filters.target_id) {
    return false;
  }

  if (filters.target_type && row.target_type !== filters.target_type) {
    return false;
  }

  if (filters.tenantId && readTenantId(row.metadata) !== filters.tenantId) {
    return false;
  }

  return true;
}

/**
 * Reads tenantId from object or JSON-string metadata in test rows.
 *
 * @param {*} metadata Raw row metadata.
 * @returns {string|undefined} Tenant identifier when present.
 */
function readTenantId(metadata) {
  if (!metadata) {
    return undefined;
  }

  if (typeof metadata === 'string') {
    try {
      return JSON.parse(metadata).tenantId;
    } catch (_error) {
      return undefined;
    }
  }

  return metadata.tenantId;
}
