'use strict';

const {
  toApiKeyResponseDto,
  fromCreateApiKeyRequestDto,
  toCreateApiKeyResponseDto,
  toDuplicateApiKeyResponseDto,
  toListApiKeysResponseDto,
  toGetApiKeyResponseDto,
  validateCreateApiKeyRequest,
} = require('../../src/routes/apiKeys.dto');

const VALID_SCOPES = require('../../src/config/apiKeys').VALID_SCOPES;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a minimal valid ApiKeyEntry-like object for testing.
 * @param {object} overrides
 * @returns {import('../../src/config/apiKeys').ApiKeyEntry}
 */
function makeEntry(overrides = {}) {
  return {
    key: 'lf_testkey0001',
    clientId: 'svc-test',
    scopes: ['invoices:read'],
    revoked: false,
    ...overrides,
  };
}

/**
 * Build a minimal valid request body.
 * @param {object} overrides
 * @returns {import('../../src/routes/apiKeys.dto').CreateApiKeyRequestDto}
 */
function makeRequest(overrides = {}) {
  return {
    key: 'lf_requestkey01',
    clientId: 'svc-request',
    scopes: ['invoices:read'],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// toApiKeyResponseDto
// ---------------------------------------------------------------------------

describe('toApiKeyResponseDto', () => {
  it('maps all fields from a full ApiKeyEntry', () => {
    const entry = makeEntry({ revoked: true });
    const dto = toApiKeyResponseDto(entry);

    expect(dto).toEqual({
      key: 'lf_testkey0001',
      clientId: 'svc-test',
      scopes: ['invoices:read'],
      revoked: true,
    });
  });

  it('defaults revoked to false when absent', () => {
    const entry = makeEntry();
    delete entry.revoked;
    const dto = toApiKeyResponseDto(entry);

    expect(dto.revoked).toBe(false);
  });

  it('handles revoked: false', () => {
    const entry = makeEntry({ revoked: false });
    const dto = toApiKeyResponseDto(entry);
    expect(dto.revoked).toBe(false);
  });

  it('handles revoked: true', () => {
    const entry = makeEntry({ revoked: true });
    const dto = toApiKeyResponseDto(entry);
    expect(dto.revoked).toBe(true);
  });

  it('creates a defensive copy of scopes', () => {
    const scopes = ['invoices:read'];
    const entry = makeEntry({ scopes });
    const dto = toApiKeyResponseDto(entry);

    scopes.push('invoices:write');
    expect(dto.scopes).toEqual(['invoices:read']);
  });

  it('drops extra fields from the input', () => {
    const entry = makeEntry({
      secret: 'should-not-leak',
      internal: true,
    });
    const dto = toApiKeyResponseDto(entry);

    expect(dto).toEqual({
      key: 'lf_testkey0001',
      clientId: 'svc-test',
      scopes: ['invoices:read'],
      revoked: false,
    });
    expect(dto).not.toHaveProperty('secret');
    expect(dto).not.toHaveProperty('internal');
  });
});

// ---------------------------------------------------------------------------
// fromCreateApiKeyRequestDto
// ---------------------------------------------------------------------------

describe('fromCreateApiKeyRequestDto', () => {
  it('maps all fields from a valid request DTO', () => {
    const dto = makeRequest();
    const entry = fromCreateApiKeyRequestDto(dto);

    expect(entry).toEqual({
      key: 'lf_requestkey01',
      clientId: 'svc-request',
      scopes: ['invoices:read'],
      revoked: false,
    });
  });

  it('trims whitespace from key and clientId', () => {
    const dto = makeRequest({ key: '  lf_trimmedkey1  ', clientId: '  svc-trim  ' });
    const entry = fromCreateApiKeyRequestDto(dto);

    expect(entry.key).toBe('lf_trimmedkey1');
    expect(entry.clientId).toBe('svc-trim');
  });

  it('creates a defensive copy of scopes', () => {
    const scopes = ['invoices:read'];
    const dto = makeRequest({ scopes });
    const entry = fromCreateApiKeyRequestDto(dto);

    scopes.push('invoices:write');
    expect(entry.scopes).toEqual(['invoices:read']);
  });

  it('always sets revoked to false', () => {
    const dto = makeRequest({ revoked: true });
    const entry = fromCreateApiKeyRequestDto(dto);
    expect(entry.revoked).toBe(false);
  });

  it('drops extra fields from the input', () => {
    const dto = makeRequest({ extraField: 'should-not-be-in-entry' });
    const entry = fromCreateApiKeyRequestDto(dto);

    expect(entry).toEqual({
      key: 'lf_requestkey01',
      clientId: 'svc-request',
      scopes: ['invoices:read'],
      revoked: false,
    });
    expect(entry).not.toHaveProperty('extraField');
  });
});

// ---------------------------------------------------------------------------
// toCreateApiKeyResponseDto
// ---------------------------------------------------------------------------

describe('toCreateApiKeyResponseDto', () => {
  it('wraps the entry with the provided message', () => {
    const entry = makeEntry();
    const result = toCreateApiKeyResponseDto(entry, 'API key created successfully.');

    expect(result.message).toBe('API key created successfully.');
    expect(result.data).toEqual(toApiKeyResponseDto(entry));
  });

  it('preserves the full entry data', () => {
    const entry = makeEntry({ key: 'lf_customkey001', clientId: 'svc-custom', scopes: ['escrow:read'], revoked: true });
    const result = toCreateApiKeyResponseDto(entry, 'msg');

    expect(result.data.key).toBe('lf_customkey001');
    expect(result.data.clientId).toBe('svc-custom');
    expect(result.data.scopes).toEqual(['escrow:read']);
    expect(result.data.revoked).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// toDuplicateApiKeyResponseDto
// ---------------------------------------------------------------------------

describe('toDuplicateApiKeyResponseDto', () => {
  it('sets idempotent: true and wraps the entry', () => {
    const entry = makeEntry();
    const result = toDuplicateApiKeyResponseDto(entry, 'API key already exists.');

    expect(result.idempotent).toBe(true);
    expect(result.message).toBe('API key already exists.');
    expect(result.data).toEqual(toApiKeyResponseDto(entry));
  });
});

// ---------------------------------------------------------------------------
// toListApiKeysResponseDto
// ---------------------------------------------------------------------------

describe('toListApiKeysResponseDto', () => {
  it('maps an array of entries to the list shape', () => {
    const entries = [
      makeEntry({ key: 'lf_firstkey0001', clientId: 'svc-a' }),
      makeEntry({ key: 'lf_secondkey001', clientId: 'svc-b' }),
    ];
    const result = toListApiKeysResponseDto(entries);

    expect(result.data).toHaveLength(2);
    expect(result.count).toBe(2);
    expect(result.data[0].key).toBe('lf_firstkey0001');
    expect(result.data[1].clientId).toBe('svc-b');
  });

  it('returns empty data and count 0 for an empty array', () => {
    const result = toListApiKeysResponseDto([]);

    expect(result.data).toEqual([]);
    expect(result.count).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// toGetApiKeyResponseDto
// ---------------------------------------------------------------------------

describe('toGetApiKeyResponseDto', () => {
  it('wraps a single entry in a data property', () => {
    const entry = makeEntry();
    const result = toGetApiKeyResponseDto(entry);

    expect(result.data).toEqual(toApiKeyResponseDto(entry));
  });
});

// ---------------------------------------------------------------------------
// Round-trip: domain → DTO → domain
// ---------------------------------------------------------------------------

describe('Round-trip mapping', () => {
  it('domain entry → response DTO preserves all data', () => {
    const entry = makeEntry({
      key: 'lf_roundtripkey1',
      clientId: 'svc-roundtrip',
      scopes: ['invoices:read', 'escrow:read'],
      revoked: true,
    });

    const dto = toApiKeyResponseDto(entry);

    expect(dto.key).toBe(entry.key);
    expect(dto.clientId).toBe(entry.clientId);
    expect(dto.scopes).toEqual(entry.scopes);
    expect(dto.revoked).toBe(entry.revoked);
  });

  it('request DTO → domain entry preserves all data', () => {
    const request = makeRequest({
      key: 'lf_requestround1',
      clientId: 'svc-round',
      scopes: ['invoices:write'],
    });

    const entry = fromCreateApiKeyRequestDto(request);

    expect(entry.key).toBe(request.key);
    expect(entry.clientId).toBe(request.clientId);
    expect(entry.scopes).toEqual(request.scopes);
    expect(entry.revoked).toBe(false);
  });

  it('domain → DTO → toCreateApiKeyResponseDto preserves data', () => {
    const entry = makeEntry();
    const msg = 'API key created successfully.';
    const response = toCreateApiKeyResponseDto(entry, msg);

    expect(response.message).toBe(msg);
    expect(response.data.key).toBe(entry.key);
    expect(response.data.clientId).toBe(entry.clientId);
    expect(response.data.scopes).toEqual(entry.scopes);
    expect(response.data.revoked).toBe(entry.revoked === undefined ? false : Boolean(entry.revoked));
  });
});

// ---------------------------------------------------------------------------
// Missing optional fields
// ---------------------------------------------------------------------------

describe('Missing optional fields', () => {
  it('undefined revoked stays as false (not coerced to null)', () => {
    const entry = makeEntry();
    delete entry.revoked;
    const dto = toApiKeyResponseDto(entry);
    expect(dto.revoked).toBe(false);
    expect(dto.revoked).not.toBeNull();
  });

  it('explicit false revoked remains false', () => {
    const entry = makeEntry({ revoked: false });
    const dto = toApiKeyResponseDto(entry);
    expect(dto.revoked).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Extra / unexpected fields leak test
// ---------------------------------------------------------------------------

describe('Extra fields not leaked', () => {
  it('response DTO does not contain extra input fields', () => {
    const entry = makeEntry({
      internalNotes: 'sensitive',
      adminOnly: true,
      _private: 'hidden',
    });
    const dto = toApiKeyResponseDto(entry);
    const keys = Object.keys(dto);
    expect(keys).toEqual(['key', 'clientId', 'scopes', 'revoked']);
  });

  it('list response DTO entries do not contain extra fields', () => {
    const entries = [makeEntry({ secret: 'please-hide' })];
    const result = toListApiKeysResponseDto(entries);
    const keys = Object.keys(result.data[0]);
    expect(keys).toEqual(['key', 'clientId', 'scopes', 'revoked']);
  });
});

// ---------------------------------------------------------------------------
// validateCreateApiKeyRequest
// ---------------------------------------------------------------------------

describe('validateCreateApiKeyRequest', () => {
  it('returns no errors for a valid request', () => {
    const body = makeRequest();
    const errors = validateCreateApiKeyRequest(body);
    expect(errors).toEqual([]);
  });

  it('handles every valid scope individually', () => {
    for (const scope of VALID_SCOPES) {
      const body = makeRequest({ scopes: [scope] });
      const errors = validateCreateApiKeyRequest(body);
      expect(errors).toEqual([]);
    }
  });

  it('handles all valid scopes together', () => {
    const body = makeRequest({ scopes: [...VALID_SCOPES] });
    const errors = validateCreateApiKeyRequest(body);
    expect(errors).toEqual([]);
  });

  it('returns error for non-object body', () => {
    expect(validateCreateApiKeyRequest(null)).toEqual([
      { field: 'body', message: 'Request body must be a JSON object' },
    ]);
    expect(validateCreateApiKeyRequest(undefined)).toEqual([
      { field: 'body', message: 'Request body must be a JSON object' },
    ]);
    expect(validateCreateApiKeyRequest('string')).toEqual([
      { field: 'body', message: 'Request body must be a JSON object' },
    ]);
    expect(validateCreateApiKeyRequest(42)).toEqual([
      { field: 'body', message: 'Request body must be a JSON object' },
    ]);
    expect(validateCreateApiKeyRequest([])).toEqual([
      { field: 'body', message: 'Request body must be a JSON object' },
    ]);
  });

  it('returns error when key is missing', () => {
    const body = { clientId: 'svc', scopes: ['invoices:read'] };
    const errors = validateCreateApiKeyRequest(body);
    expect(errors).toHaveLength(1);
    expect(errors[0].field).toBe('body');
    expect(errors[0].message).toContain('key');
  });

  it('returns error when key does not start with lf_', () => {
    const body = makeRequest({ key: 'bad-key' });
    const errors = validateCreateApiKeyRequest(body);
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain('lf_');
  });

  it('returns error when key is too short', () => {
    const body = makeRequest({ key: 'lf_short' });
    const errors = validateCreateApiKeyRequest(body);
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain('at least');
  });

  it('returns error when clientId is missing', () => {
    const body = { key: 'lf_validkey0001', scopes: ['invoices:read'] };
    const errors = validateCreateApiKeyRequest(body);
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain('clientId');
  });

  it('returns error when clientId is empty', () => {
    const body = makeRequest({ clientId: '' });
    const errors = validateCreateApiKeyRequest(body);
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain('clientId');
  });

  it('returns error when scopes is missing', () => {
    const body = { key: 'lf_validkey0001', clientId: 'svc' };
    const errors = validateCreateApiKeyRequest(body);
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain('scopes');
  });

  it('returns error when scopes is empty', () => {
    const body = makeRequest({ scopes: [] });
    const errors = validateCreateApiKeyRequest(body);
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain('scopes');
  });

  it('returns error for invalid scope', () => {
    const body = makeRequest({ scopes: ['invalid:scope'] });
    const errors = validateCreateApiKeyRequest(body);
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain('not a valid scope');
  });

  it('returns multiple errors for multiple invalid fields', () => {
    const body = { key: '', clientId: '', scopes: [] };
    const errors = validateCreateApiKeyRequest(body);
    // key empty, clientId empty, scopes empty
    expect(errors.length).toBeGreaterThanOrEqual(3);
    const fields = errors.map((e) => e.field);
    expect(fields.every((f) => f === 'body')).toBe(true);
  });
});
