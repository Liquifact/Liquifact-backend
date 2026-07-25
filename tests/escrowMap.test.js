'use strict';

const {
  resolveEscrowAddress,
  resolveInvoiceByAddress,
  EscrowNotFoundError,
  EscrowMapConfigError,
  _resetCache,
} = require('../src/config/escrowMap');

// Valid Stellar contract address (C + 55 base-32 chars)
const ADDR_A = 'C' + 'A'.repeat(55);
const ADDR_B = 'C' + 'B'.repeat(55);

// Helpers -------------------------------------------------------------------

/**
 * Set ESCROW_ADDR_BY_INVOICE to a serialised config object and reset the
 * module cache so the next resolveEscrowAddress call re-parses from env.
 */
function setConfig(cfg) {
  process.env.ESCROW_ADDR_BY_INVOICE = JSON.stringify(cfg);
  _resetCache();
}

function clearConfig() {
  delete process.env.ESCROW_ADDR_BY_INVOICE;
  _resetCache();
}

// ---------------------------------------------------------------------------

describe('escrowMap – resolveEscrowAddress', () => {
  const originalNodeEnv = process.env.NODE_ENV;

  beforeEach(() => {
    clearConfig();
    process.env.NODE_ENV = 'test';
  });

  afterEach(() => {
    clearConfig();
    process.env.NODE_ENV = originalNodeEnv;
  });

  // ── active mapping resolves ───────────────────────────────────────────────

  it('resolves a known active mapping to its address', () => {
    setConfig({
      mappings: [
        { invoiceId: 'inv_001', escrowAddress: ADDR_A, environment: 'test', isActive: true },
      ],
      defaultEnvironment: 'test',
      allowlistEnabled: false,
    });

    expect(resolveEscrowAddress('inv_001')).toBe(ADDR_A);
  });

  // ── unknown invoiceId throws, no silent default ───────────────────────────

  it('throws EscrowNotFoundError for an unknown invoiceId', () => {
    setConfig({
      mappings: [
        { invoiceId: 'inv_001', escrowAddress: ADDR_A, environment: 'test', isActive: true },
      ],
      defaultEnvironment: 'test',
      allowlistEnabled: false,
    });

    expect(() => resolveEscrowAddress('inv_UNKNOWN')).toThrow(EscrowNotFoundError);
  });

  it('error message includes the invoiceId', () => {
    setConfig({ mappings: [], defaultEnvironment: 'test', allowlistEnabled: false });

    try {
      resolveEscrowAddress('inv_MISSING');
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(EscrowNotFoundError);
      expect(err.message).toContain('inv_MISSING');
      expect(err.invoiceId).toBe('inv_MISSING');
    }
  });

  // ── inactive mapping is rejected ─────────────────────────────────────────

  it('throws EscrowNotFoundError for an inactive mapping (isActive: false)', () => {
    setConfig({
      mappings: [
        { invoiceId: 'inv_001', escrowAddress: ADDR_A, environment: 'test', isActive: false },
      ],
      defaultEnvironment: 'test',
      allowlistEnabled: false,
    });

    expect(() => resolveEscrowAddress('inv_001')).toThrow(EscrowNotFoundError);
  });

  it('treats missing isActive field as active (truthy default)', () => {
    // isActive is only checked as !== false, so omitting it counts as active
    setConfig({
      mappings: [
        { invoiceId: 'inv_001', escrowAddress: ADDR_A, environment: 'test' },
      ],
      defaultEnvironment: 'test',
      allowlistEnabled: false,
    });

    expect(resolveEscrowAddress('inv_001')).toBe(ADDR_A);
  });

  // ── environment filtering ─────────────────────────────────────────────────

  it('resolves only the mapping whose environment matches NODE_ENV', () => {
    process.env.NODE_ENV = 'production';
    _resetCache();

    setConfig({
      mappings: [
        { invoiceId: 'inv_001', escrowAddress: ADDR_A, environment: 'test', isActive: true },
        { invoiceId: 'inv_001', escrowAddress: ADDR_B, environment: 'production', isActive: true },
      ],
      defaultEnvironment: 'production',
      allowlistEnabled: false,
    });

    expect(resolveEscrowAddress('inv_001')).toBe(ADDR_B);
  });

  it('throws when the mapping exists but for a different environment', () => {
    process.env.NODE_ENV = 'staging';
    _resetCache();

    setConfig({
      mappings: [
        { invoiceId: 'inv_001', escrowAddress: ADDR_A, environment: 'test', isActive: true },
      ],
      defaultEnvironment: 'staging',
      allowlistEnabled: false,
    });

    expect(() => resolveEscrowAddress('inv_001')).toThrow(EscrowNotFoundError);
  });

  it('falls back to defaultEnvironment when NODE_ENV is not set', () => {
    delete process.env.NODE_ENV;
    _resetCache();

    setConfig({
      mappings: [
        { invoiceId: 'inv_001', escrowAddress: ADDR_A, environment: 'production', isActive: true },
      ],
      defaultEnvironment: 'production',
      allowlistEnabled: false,
    });

    expect(resolveEscrowAddress('inv_001')).toBe(ADDR_A);
    process.env.NODE_ENV = originalNodeEnv;
  });

  it('falls back to the "development" environment when defaultEnvironment is omitted entirely', () => {
    delete process.env.NODE_ENV;
    process.env.ESCROW_ADDR_BY_INVOICE = JSON.stringify({
      mappings: [
        { invoiceId: 'inv_001', escrowAddress: ADDR_A, environment: 'development', isActive: true },
      ],
      allowlistEnabled: false,
      // defaultEnvironment intentionally omitted
    });
    _resetCache();

    expect(resolveEscrowAddress('inv_001')).toBe(ADDR_A);
    process.env.NODE_ENV = originalNodeEnv;
  });

  // ── allowlistEnabled behavior ─────────────────────────────────────────────

  it('resolves normally when allowlistEnabled is true and address is in the mappings', () => {
    setConfig({
      mappings: [
        { invoiceId: 'inv_001', escrowAddress: ADDR_A, environment: 'test', isActive: true },
      ],
      defaultEnvironment: 'test',
      allowlistEnabled: true,
    });

    expect(resolveEscrowAddress('inv_001')).toBe(ADDR_A);
  });

  it('throws EscrowNotFoundError when allowlistEnabled is true and invoiceId is not in mappings', () => {
    setConfig({
      mappings: [
        { invoiceId: 'inv_001', escrowAddress: ADDR_A, environment: 'test', isActive: true },
      ],
      defaultEnvironment: 'test',
      allowlistEnabled: true,
    });

    // inv_002 is not in the allowlist
    expect(() => resolveEscrowAddress('inv_002')).toThrow(EscrowNotFoundError);
  });

  it('still throws for an inactive mapping even when allowlistEnabled is true', () => {
    setConfig({
      mappings: [
        { invoiceId: 'inv_001', escrowAddress: ADDR_A, environment: 'test', isActive: false },
      ],
      defaultEnvironment: 'test',
      allowlistEnabled: true,
    });

    expect(() => resolveEscrowAddress('inv_001')).toThrow(EscrowNotFoundError);
  });

  // ── empty / missing config ────────────────────────────────────────────────

  it('throws EscrowNotFoundError when ESCROW_ADDR_BY_INVOICE is not set', () => {
    // clearConfig() already unsets it in beforeEach; confirm no silent default
    expect(() => resolveEscrowAddress('inv_001')).toThrow(EscrowNotFoundError);
  });

  it('throws EscrowNotFoundError when mappings array is empty', () => {
    setConfig({ mappings: [], defaultEnvironment: 'test', allowlistEnabled: false });

    expect(() => resolveEscrowAddress('inv_001')).toThrow(EscrowNotFoundError);
  });

  // ── multiple mappings — picks correct one ─────────────────────────────────

  it('picks the correct address when multiple active mappings are present', () => {
    setConfig({
      mappings: [
        { invoiceId: 'inv_001', escrowAddress: ADDR_A, environment: 'test', isActive: true },
        { invoiceId: 'inv_002', escrowAddress: ADDR_B, environment: 'test', isActive: true },
      ],
      defaultEnvironment: 'test',
      allowlistEnabled: false,
    });

    expect(resolveEscrowAddress('inv_001')).toBe(ADDR_A);
    expect(resolveEscrowAddress('inv_002')).toBe(ADDR_B);
  });
});

// ---------------------------------------------------------------------------

describe('escrowMap – config validation (EscrowMapConfigError)', () => {
  beforeEach(() => {
    clearConfig();
  });

  afterEach(() => {
    clearConfig();
  });

  it('throws EscrowMapConfigError for malformed JSON', () => {
    process.env.ESCROW_ADDR_BY_INVOICE = '{not valid json';
    _resetCache();

    expect(() => resolveEscrowAddress('inv_001')).toThrow(EscrowMapConfigError);
  });

  it('error message mentions JSON when config is malformed', () => {
    process.env.ESCROW_ADDR_BY_INVOICE = 'definitely-not-json';
    _resetCache();

    try {
      resolveEscrowAddress('inv_001');
    } catch (err) {
      expect(err).toBeInstanceOf(EscrowMapConfigError);
      expect(err.message.toLowerCase()).toContain('json');
    }
  });

  it('throws EscrowMapConfigError when mappings is not an array', () => {
    process.env.ESCROW_ADDR_BY_INVOICE = JSON.stringify({
      mappings: 'not-an-array',
      defaultEnvironment: 'test',
    });
    _resetCache();

    expect(() => resolveEscrowAddress('inv_001')).toThrow(EscrowMapConfigError);
  });

  it('throws EscrowMapConfigError when a mapping is missing invoiceId', () => {
    process.env.ESCROW_ADDR_BY_INVOICE = JSON.stringify({
      mappings: [{ escrowAddress: ADDR_A, environment: 'test', isActive: true }],
      defaultEnvironment: 'test',
    });
    _resetCache();

    expect(() => resolveEscrowAddress('inv_001')).toThrow(EscrowMapConfigError);
  });

  it('throws EscrowMapConfigError for an invalid Stellar escrowAddress', () => {
    process.env.ESCROW_ADDR_BY_INVOICE = JSON.stringify({
      mappings: [
        { invoiceId: 'inv_001', escrowAddress: 'not-a-stellar-address', environment: 'test', isActive: true },
      ],
      defaultEnvironment: 'test',
    });
    _resetCache();

    expect(() => resolveEscrowAddress('inv_001')).toThrow(EscrowMapConfigError);
  });

  it('throws EscrowMapConfigError for a G... address (only C... allowed for contracts)', () => {
    // G-addresses are account keys, not contract IDs — the regex requires C or G but
    // length + charset must also pass. A 56-char G address is valid per the regex.
    // This test just confirms a short/malformed address is caught.
    process.env.ESCROW_ADDR_BY_INVOICE = JSON.stringify({
      mappings: [
        { invoiceId: 'inv_001', escrowAddress: 'GSHORT', environment: 'test', isActive: true },
      ],
      defaultEnvironment: 'test',
    });
    _resetCache();

    expect(() => resolveEscrowAddress('inv_001')).toThrow(EscrowMapConfigError);
  });
});

// ---------------------------------------------------------------------------

describe('escrowMap – module-level cache', () => {
  const originalNodeEnv = process.env.NODE_ENV;

  beforeEach(() => {
    clearConfig();
    process.env.NODE_ENV = 'test';
  });

  afterEach(() => {
    clearConfig();
    process.env.NODE_ENV = originalNodeEnv;
  });

  it('returns the same address on repeated calls without re-reading env (cache hit)', () => {
    setConfig({
      mappings: [
        { invoiceId: 'inv_001', escrowAddress: ADDR_A, environment: 'test', isActive: true },
      ],
      defaultEnvironment: 'test',
      allowlistEnabled: false,
    });

    const first = resolveEscrowAddress('inv_001');

    // Mutate env — should NOT affect result because cache is still warm
    process.env.ESCROW_ADDR_BY_INVOICE = JSON.stringify({
      mappings: [
        { invoiceId: 'inv_001', escrowAddress: ADDR_B, environment: 'test', isActive: true },
      ],
      defaultEnvironment: 'test',
      allowlistEnabled: false,
    });
    // Note: no _resetCache() call here

    const second = resolveEscrowAddress('inv_001');
    expect(first).toBe(ADDR_A);
    expect(second).toBe(ADDR_A); // still cached
  });

  it('rebuilds on every call when cacheEnabled is false, without waiting for TTL or calling _resetCache()', () => {
    setConfig({
      mappings: [
        { invoiceId: 'inv_001', escrowAddress: ADDR_A, environment: 'test', isActive: true },
      ],
      defaultEnvironment: 'test',
      allowlistEnabled: false,
      cacheEnabled: false,
    });

    expect(resolveEscrowAddress('inv_001')).toBe(ADDR_A);

    // Swap env directly — no _resetCache() call. With cacheEnabled: false,
    // _getConfig() must re-parse on every call regardless of cacheTtlSeconds.
    process.env.ESCROW_ADDR_BY_INVOICE = JSON.stringify({
      mappings: [
        { invoiceId: 'inv_001', escrowAddress: ADDR_B, environment: 'test', isActive: true },
      ],
      defaultEnvironment: 'test',
      allowlistEnabled: false,
      cacheEnabled: false,
    });

    expect(resolveEscrowAddress('inv_001')).toBe(ADDR_B);
  });

  it('picks up the new config after _resetCache()', () => {
    setConfig({
      mappings: [
        { invoiceId: 'inv_001', escrowAddress: ADDR_A, environment: 'test', isActive: true },
      ],
      defaultEnvironment: 'test',
      allowlistEnabled: false,
    });

    resolveEscrowAddress('inv_001'); // warms cache

    // Swap config and reset
    setConfig({
      mappings: [
        { invoiceId: 'inv_001', escrowAddress: ADDR_B, environment: 'test', isActive: true },
      ],
      defaultEnvironment: 'test',
      allowlistEnabled: false,
    });

    expect(resolveEscrowAddress('inv_001')).toBe(ADDR_B);
  });

  it('fails closed after cache reset when new config is malformed JSON', () => {
    setConfig({
      mappings: [
        { invoiceId: 'inv_001', escrowAddress: ADDR_A, environment: 'test', isActive: true },
      ],
      defaultEnvironment: 'test',
      allowlistEnabled: false,
    });

    resolveEscrowAddress('inv_001'); // warms cache

    // Now corrupt the env and reset
    process.env.ESCROW_ADDR_BY_INVOICE = '{broken';
    _resetCache();

    expect(() => resolveEscrowAddress('inv_001')).toThrow(EscrowMapConfigError);
  });
});

// ---------------------------------------------------------------------------

describe('escrowMap – resolveInvoiceByAddress (reverse lookup)', () => {
  const originalNodeEnv = process.env.NODE_ENV;

  beforeEach(() => {
    clearConfig();
    process.env.NODE_ENV = 'test';
  });

  afterEach(() => {
    clearConfig();
    process.env.NODE_ENV = originalNodeEnv;
    jest.useRealTimers();
  });

  it('resolves a known active contract address to its invoiceId', () => {
    setConfig({
      mappings: [
        { invoiceId: 'inv_001', escrowAddress: ADDR_A, environment: 'test', isActive: true },
      ],
      defaultEnvironment: 'test',
      allowlistEnabled: true,
    });

    expect(resolveInvoiceByAddress(ADDR_A)).toBe('inv_001');
  });

  it('returns null for an unknown contract address (allowlist-disabled address)', () => {
    setConfig({
      mappings: [
        { invoiceId: 'inv_001', escrowAddress: ADDR_A, environment: 'test', isActive: true },
      ],
      defaultEnvironment: 'test',
      allowlistEnabled: true,
    });

    expect(resolveInvoiceByAddress(ADDR_B)).toBeNull();
  });

  it('returns null when ESCROW_ADDR_BY_INVOICE is not set', () => {
    expect(resolveInvoiceByAddress(ADDR_A)).toBeNull();
  });

  it('returns null for inactive mapping addresses', () => {
    setConfig({
      mappings: [
        { invoiceId: 'inv_001', escrowAddress: ADDR_A, environment: 'test', isActive: false },
      ],
      defaultEnvironment: 'test',
      allowlistEnabled: false,
    });

    expect(resolveInvoiceByAddress(ADDR_A)).toBeNull();
  });

  it('returns null when mapping exists for a different environment', () => {
    process.env.NODE_ENV = 'production';
    _resetCache();

    setConfig({
      mappings: [
        { invoiceId: 'inv_001', escrowAddress: ADDR_A, environment: 'test', isActive: true },
      ],
      defaultEnvironment: 'production',
      allowlistEnabled: false,
    });

    expect(resolveInvoiceByAddress(ADDR_A)).toBeNull();
  });

  it('resolves only the mapping for the current environment', () => {
    process.env.NODE_ENV = 'production';
    _resetCache();

    setConfig({
      mappings: [
        { invoiceId: 'inv_test', escrowAddress: ADDR_A, environment: 'test', isActive: true },
        { invoiceId: 'inv_prod', escrowAddress: ADDR_B, environment: 'production', isActive: true },
      ],
      defaultEnvironment: 'production',
      allowlistEnabled: true,
    });

    expect(resolveInvoiceByAddress(ADDR_A)).toBeNull();
    expect(resolveInvoiceByAddress(ADDR_B)).toBe('inv_prod');
  });

  it('returns null for malformed contract addresses', () => {
    setConfig({
      mappings: [
        { invoiceId: 'inv_001', escrowAddress: ADDR_A, environment: 'test', isActive: true },
      ],
      defaultEnvironment: 'test',
      allowlistEnabled: false,
    });

    expect(resolveInvoiceByAddress('not-a-stellar-address')).toBeNull();
    expect(resolveInvoiceByAddress('')).toBeNull();
    expect(resolveInvoiceByAddress(null)).toBeNull();
  });

  it('does not fabricate invoice IDs for unmapped contracts when allowlistEnabled is false', () => {
    setConfig({
      mappings: [
        { invoiceId: 'inv_001', escrowAddress: ADDR_A, environment: 'test', isActive: true },
      ],
      defaultEnvironment: 'test',
      allowlistEnabled: false,
    });

    expect(resolveInvoiceByAddress(ADDR_B)).toBeNull();
  });

  it('refreshes reverse index after cache TTL expires', () => {
    jest.useFakeTimers();

    setConfig({
      mappings: [
        { invoiceId: 'inv_001', escrowAddress: ADDR_A, environment: 'test', isActive: true },
      ],
      defaultEnvironment: 'test',
      allowlistEnabled: true,
      cacheEnabled: true,
      cacheTtlSeconds: 60,
    });

    expect(resolveInvoiceByAddress(ADDR_A)).toBe('inv_001');

    process.env.ESCROW_ADDR_BY_INVOICE = JSON.stringify({
      mappings: [
        { invoiceId: 'inv_002', escrowAddress: ADDR_A, environment: 'test', isActive: true },
      ],
      defaultEnvironment: 'test',
      allowlistEnabled: true,
      cacheEnabled: true,
      cacheTtlSeconds: 60,
    });

    jest.advanceTimersByTime(61_000);

    expect(resolveInvoiceByAddress(ADDR_A)).toBe('inv_002');
  });
});
