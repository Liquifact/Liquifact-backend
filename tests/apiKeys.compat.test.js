'use strict';

const {
  API_KEY_PREFIX,
  MIN_KEY_LENGTH,
  MAX_KEY_LENGTH,
  MAX_CLIENT_ID_LENGTH,
  MAX_SCOPES_COUNT,
  KNOWN_ENTRY_FIELDS,
  VALID_SCOPES,
  parseApiKeys,
  buildKeyRegistry,
  loadApiKeyRegistry,
  validateEntry,
  rejectUnknownFields,
} = require('../src/config/apiKeys');

const validEntry = (overrides = {}) => ({
  key: 'lf_abc123456',
  clientId: 'service-a',
  scopes: ['invoices:read'],
  ...overrides,
});

const toEnv = (...entries) => entries.map((e) => JSON.stringify(e)).join(';');

function thrownMessage(fn) {
  try {
    fn();
  } catch (err) {
    return err.message;
  }
  throw new Error('expected function to throw');
}

describe('apiKeys compatibility contract', () => {
  describe('public exports', () => {
    it('keeps constants stable', () => {
      expect(API_KEY_PREFIX).toBe('lf_');
      expect(MIN_KEY_LENGTH).toBe(10);
      expect(MAX_KEY_LENGTH).toBe(256);
      expect(MAX_CLIENT_ID_LENGTH).toBe(128);
      expect(MAX_SCOPES_COUNT).toBe(20);
      expect(VALID_SCOPES).toEqual([
        'invoices:read',
        'invoices:write',
        'escrow:read',
        'admin',
      ]);
      expect([...KNOWN_ENTRY_FIELDS].sort()).toEqual(
        ['clientId', 'key', 'revoked', 'scopes']
      );
    });

    it('keeps the function exports', () => {
      [
        parseApiKeys,
        buildKeyRegistry,
        loadApiKeyRegistry,
        validateEntry,
        rejectUnknownFields,
      ].forEach((fn) => expect(typeof fn).toBe('function'));
    });
  });

  describe('parseApiKeys: empty and blank input', () => {
    it.each([undefined, '', '   ', ';', ' ; ; '])(
      'returns an empty list for %j',
      (raw) => {
        expect(parseApiKeys(raw)).toEqual([]);
      }
    );
  });

  describe('parseApiKeys: valid input', () => {
    it('parses a single entry and defaults revoked to false', () => {
      expect(parseApiKeys(toEnv(validEntry()))).toEqual([
        {
          key: 'lf_abc123456',
          clientId: 'service-a',
          scopes: ['invoices:read'],
          revoked: false,
        },
      ]);
    });

    it('preserves revoked: true', () => {
      const [entry] = parseApiKeys(toEnv(validEntry({ revoked: true })));
      expect(entry.revoked).toBe(true);
    });

    it('preserves order across multiple entries', () => {
      const parsed = parseApiKeys(
        toEnv(
          validEntry({ key: 'lf_first00001', clientId: 'a' }),
          validEntry({ key: 'lf_second0002', clientId: 'b' })
        )
      );
      expect(parsed.map((e) => e.clientId)).toEqual(['a', 'b']);
    });

    it('trims key and clientId before storage', () => {
      const [entry] = parseApiKeys(
        toEnv(validEntry({ key: 'lf_abc123456 ', clientId: '  service-a  ' }))
      );
      expect(entry.key).toBe('lf_abc123456');
      expect(entry.clientId).toBe('service-a');
    });

    it('skips empty chunks and counts only non-empty chunks in error indexes', () => {
      const raw = `${toEnv(validEntry())};;${toEnv(validEntry({ scopes: ['nope'] }))}`;
      expect(() => parseApiKeys(raw)).toThrow(/API_KEYS\[1\]: unknown scope "nope"/);
    });
  });

  describe('parseApiKeys: malformed input', () => {
    it('rejects malformed JSON with the entry index', () => {
      expect(() => parseApiKeys('not-json')).toThrow(
        /API_KEYS\[0\]: failed to parse JSON/
      );
    });

    it('fails closed when a semicolon appears inside a JSON string', () => {
      const raw = '{"key":"lf_abc123456","clientId":"a;b","scopes":["admin"]}';
      expect(() => parseApiKeys(raw)).toThrow(/failed to parse JSON/);
    });

    it('does not echo key material from the JSON parser', () => {
      const secret = 'lf_SECRETVALUE1234567';
      const raw = `{"key":"${secret}",,"clientId":"a","scopes":["admin"]}`;
      const message = thrownMessage(() => parseApiKeys(raw));
      expect(message).toMatch(/failed to parse JSON/);
      expect(message).not.toContain(secret);
      expect(message).not.toContain('SECRETVALUE');
    });

    it('reports the first failing entry and registers nothing', () => {
      const raw = `${toEnv(validEntry())};{"key":1}`;
      expect(() => parseApiKeys(raw)).toThrow(/API_KEYS\[1\]/);
    });
  });

  describe('validateEntry: shape', () => {
    it.each([null, [], 'x', 5, undefined])('rejects non-object %j', (value) => {
      expect(() => validateEntry(value, 0)).toThrow(
        /API_KEYS\[0\]: entry must be a JSON object/
      );
    });

    it('rejects unknown fields', () => {
      expect(() => validateEntry(validEntry({ extra: 1 }), 2)).toThrow(
        /API_KEYS\[2\]: unknown field\(s\) "extra"/
      );
    });

    it('rejects unknown fields before field-level validation', () => {
      expect(() => validateEntry({ key: 'bad', extra: 1 }, 0)).toThrow(
        /unknown field\(s\) "extra"/
      );
    });

    it('uses the supplied index in messages', () => {
      expect(() => validateEntry({}, 7)).toThrow(/^API_KEYS\[7\]/);
    });
  });

  describe('validateEntry: key', () => {
    it.each([undefined, '', '   ', 123, null])('rejects key %j', (key) => {
      expect(() => validateEntry(validEntry({ key }), 0)).toThrow(
        /"key" must be a non-empty string/
      );
    });

    it('requires the lf_ prefix', () => {
      expect(() => validateEntry(validEntry({ key: 'xx_abc123456' }), 0)).toThrow(
        /"key" must start with "lf_"/
      );
    });

    it('rejects leading whitespace (prefix is checked on the raw value)', () => {
      expect(() => validateEntry(validEntry({ key: ' lf_abc123456' }), 0)).toThrow(
        /"key" must start with "lf_"/
      );
    });

    it('accepts exactly the minimum length and rejects one below', () => {
      const atMin = 'lf_' + 'a'.repeat(MIN_KEY_LENGTH - 3);
      const belowMin = 'lf_' + 'a'.repeat(MIN_KEY_LENGTH - 4);
      expect(validateEntry(validEntry({ key: atMin }), 0).key).toBe(atMin);
      expect(() => validateEntry(validEntry({ key: belowMin }), 0)).toThrow(
        /at least 10 characters/
      );
    });

    it('rejects a short key padded with whitespace to reach the minimum length', () => {
      const padded = 'lf_a' + ' '.repeat(6);
      expect(padded.length).toBe(MIN_KEY_LENGTH);
      expect(() => validateEntry(validEntry({ key: padded }), 0)).toThrow(
        /at least 10 characters/
      );
    });

    it('accepts exactly the maximum length and rejects one above', () => {
      const atMax = 'lf_' + 'a'.repeat(MAX_KEY_LENGTH - 3);
      const aboveMax = atMax + 'a';
      expect(validateEntry(validEntry({ key: atMax }), 0).key).toBe(atMax);
      expect(() => validateEntry(validEntry({ key: aboveMax }), 0)).toThrow(
        /must not exceed 256 characters/
      );
    });
  });

  describe('validateEntry: clientId', () => {
    it.each([undefined, '', '   ', 5, null])('rejects clientId %j', (clientId) => {
      expect(() => validateEntry(validEntry({ clientId }), 0)).toThrow(
        /"clientId" must be a non-empty string/
      );
    });

    it('accepts exactly the maximum length and rejects one above', () => {
      const atMax = 'c'.repeat(MAX_CLIENT_ID_LENGTH);
      expect(validateEntry(validEntry({ clientId: atMax }), 0).clientId).toBe(atMax);
      expect(() => validateEntry(validEntry({ clientId: atMax + 'c' }), 0)).toThrow(
        /"clientId" must not exceed 128 characters/
      );
    });

    it('measures clientId length after trimming', () => {
      const padded = `  ${'c'.repeat(MAX_CLIENT_ID_LENGTH)}  `;
      expect(validateEntry(validEntry({ clientId: padded }), 0).clientId).toBe(
        'c'.repeat(MAX_CLIENT_ID_LENGTH)
      );
    });
  });

  describe('validateEntry: scopes', () => {
    it.each([undefined, 'admin', {}, []])('rejects scopes %j', (scopes) => {
      expect(() => validateEntry(validEntry({ scopes }), 0)).toThrow(
        /"scopes" must be a non-empty array/
      );
    });

    it('accepts exactly the maximum count and rejects one above', () => {
      const atMax = Array(MAX_SCOPES_COUNT).fill('admin');
      expect(validateEntry(validEntry({ scopes: atMax }), 0).scopes).toHaveLength(
        MAX_SCOPES_COUNT
      );
      expect(() =>
        validateEntry(validEntry({ scopes: [...atMax, 'admin'] }), 0)
      ).toThrow(/"scopes" must not exceed 20 entries/);
    });

    it('rejects unknown scopes and lists the valid ones', () => {
      expect(() => validateEntry(validEntry({ scopes: ['nope'] }), 0)).toThrow(
        /unknown scope "nope"\. Valid scopes: invoices:read, invoices:write, escrow:read, admin/
      );
    });

    it('accepts every valid scope', () => {
      expect(
        validateEntry(validEntry({ scopes: [...VALID_SCOPES] }), 0).scopes
      ).toEqual(VALID_SCOPES);
    });

    it('preserves duplicate scopes as given', () => {
      expect(
        validateEntry(validEntry({ scopes: ['admin', 'admin'] }), 0).scopes
      ).toEqual(['admin', 'admin']);
    });

    it('returns a copy so later mutation of the input does not change the entry', () => {
      const input = validEntry();
      const result = validateEntry(input, 0);
      expect(result.scopes).not.toBe(input.scopes);
      input.scopes.push('admin');
      expect(result.scopes).toEqual(['invoices:read']);
    });
  });

  describe('validateEntry: revoked', () => {
    it.each(['true', 1, null, {}])('rejects non-boolean revoked %j', (revoked) => {
      expect(() => validateEntry(validEntry({ revoked }), 0)).toThrow(
        /"revoked" must be a boolean when present/
      );
    });

    it('accepts true and false', () => {
      expect(validateEntry(validEntry({ revoked: true }), 0).revoked).toBe(true);
      expect(validateEntry(validEntry({ revoked: false }), 0).revoked).toBe(false);
    });
  });

  describe('secrecy of validation errors', () => {
    it('never includes the key value in a validation error', () => {
      const secret = 'lf_SECRETVALUE1234567';
      const message = thrownMessage(() =>
        validateEntry({ key: secret, clientId: 'c', scopes: ['nope'] }, 0)
      );
      expect(message).not.toContain(secret);
    });
  });

  describe('buildKeyRegistry', () => {
    it('returns an empty Map for no entries', () => {
      const registry = buildKeyRegistry([]);
      expect(registry).toBeInstanceOf(Map);
      expect(registry.size).toBe(0);
    });

    it('indexes entries by key and keeps revoked entries', () => {
      const registry = buildKeyRegistry([
        validateEntry(validEntry(), 0),
        validateEntry(validEntry({ key: 'lf_revoked001', clientId: 'b', revoked: true }), 1),
      ]);
      expect(registry.get('lf_abc123456').clientId).toBe('service-a');
      expect(registry.get('lf_revoked001').revoked).toBe(true);
    });

    it('rejects duplicate keys and names the clientId, not the key', () => {
      const entries = [
        validateEntry(validEntry(), 0),
        validateEntry(validEntry({ clientId: 'service-b' }), 1),
      ];
      const message = thrownMessage(() => buildKeyRegistry(entries));
      expect(message).toMatch(/duplicate key detected for clientId "service-b"/);
      expect(message).not.toContain('lf_abc123456');
    });
  });

  describe('loadApiKeyRegistry', () => {
    const saved = process.env.API_KEYS;

    afterEach(() => {
      if (saved === undefined) {
        delete process.env.API_KEYS;
      } else {
        process.env.API_KEYS = saved;
      }
    });

    it('returns an empty Map when API_KEYS is absent', () => {
      expect(loadApiKeyRegistry({}).size).toBe(0);
    });

    it('reads from the supplied env object', () => {
      const registry = loadApiKeyRegistry({ API_KEYS: toEnv(validEntry()) });
      expect(registry.has('lf_abc123456')).toBe(true);
    });

    it('defaults to process.env', () => {
      process.env.API_KEYS = toEnv(validEntry());
      expect(loadApiKeyRegistry().has('lf_abc123456')).toBe(true);
    });

    it('rebuilds on every call with no caching between calls', () => {
      const first = loadApiKeyRegistry({ API_KEYS: toEnv(validEntry()) });
      const second = loadApiKeyRegistry({
        API_KEYS: toEnv(validEntry({ key: 'lf_other00001' })),
      });
      expect(first.has('lf_abc123456')).toBe(true);
      expect(second.has('lf_abc123456')).toBe(false);
      expect(second.has('lf_other00001')).toBe(true);
    });

    it('is deterministic on retry and returns independent Maps', () => {
      const env = { API_KEYS: toEnv(validEntry()) };
      const a = loadApiKeyRegistry(env);
      const b = loadApiKeyRegistry(env);
      expect([...a.entries()]).toEqual([...b.entries()]);
      a.clear();
      expect(b.size).toBe(1);
    });

    it('throws on a duplicate key across entries', () => {
      const env = { API_KEYS: toEnv(validEntry(), validEntry({ clientId: 'service-b' })) };
      expect(() => loadApiKeyRegistry(env)).toThrow(/duplicate key detected/);
    });

    it('fails without a partial result and recovers on the next valid call', () => {
      const bad = { API_KEYS: `${toEnv(validEntry())};{"key":1}` };
      expect(() => loadApiKeyRegistry(bad)).toThrow(/API_KEYS\[1\]/);
      expect(loadApiKeyRegistry({ API_KEYS: toEnv(validEntry()) }).size).toBe(1);
    });
  });
});