jest.mock('../../src/metrics', () => {
  const makeCounter = () => ({
    inc: jest.fn(),
    reset: jest.fn(),
    val: 0,
  });

  return {
    footprintCacheHitsTotal: makeCounter(),
    footprintCacheMissesTotal: makeCounter(),
    footprintCacheEvictionsTotal: makeCounter(),

    // KYC webhook metrics — needed so route handlers can call
    // normalizeKycWebhookStatusClass / normalizeKycWebhookCause
    // in their res.on('finish') callbacks without crashing.
    kycWebhookRequestDurationSeconds: { observe: jest.fn() },
    kycWebhookRequestsTotal: { inc: jest.fn() },
    kycWebhookErrorsTotal: { inc: jest.fn() },
    normalizeKycWebhookStatusClass: jest.fn().mockReturnValue('4xx'),
    normalizeKycWebhookCause: jest.fn().mockReturnValue('none'),
  };
});

const { CircuitBreaker: _CircuitBreaker } = require('../../src/utils/circuitBreaker');
const { MemoryCacheStore: _MemoryCacheStore } = require('../../src/services/cacheStore');
globalThis.CircuitBreaker = _CircuitBreaker;
globalThis.MemoryCacheStore = _MemoryCacheStore;

process.env.JWT_SECRET = 'test-secret-at-least-32-characters-long-string-for-jest';
process.env.ESCROW_ADDR_BY_INVOICE = JSON.stringify({
  mappings: [{ invoiceId: 'inv_001', escrowAddress: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', environment: 'test', isActive: true }],
  defaultEnvironment: 'test',
  allowlistEnabled: true,
  cacheEnabled: true,
  cacheTtlSeconds: 300,
});
require('../../src/config').validate();

let mockInMemoryDb = [];
let mockCurrentTable = null;

jest.mock('../../src/db/knex', () => {
  const auditLogEvents = [];
  const investorLocks = [];
  const invoiceFiles = [];
  let queryWheres = {};
  let mockCurrentTable;
  let _lastInserted = null;
  let _lastUpdateFields = null;
  let _lastInsertInput = null;
  let _limit = null;
  let _offset = 0;

  const filterInvestorLocks = () => investorLocks.filter((row) => {
    return Object.entries(queryWheres).every(([key, value]) => row[key] === value);
  });

  const filterInvoiceFiles = () => invoiceFiles.filter((row) => {
    return Object.entries(queryWheres).every(([key, value]) => row[key] === value);
  });

  const m = jest.fn((table) => {
    mockCurrentTable = table;
    queryWheres = {};
    _lastInserted = null;
    _lastUpdateFields = null;
    _lastInsertInput = null;
    _limit = null;
    _offset = 0;
    return m;
  });

  m.where = jest.fn((field, value) => {
    if (typeof field === "string") {
      queryWheres[field] = value;
    } else if (field && typeof field === "object") {
      queryWheres = { ...queryWheres, ...field };
    }
    return m;
  });
  m.whereNotIn = jest.fn().mockReturnThis();
  m.whereNull = jest.fn().mockReturnThis();
  m.whereIn = jest.fn().mockReturnThis();
  m.leftJoin = jest.fn().mockReturnThis();
  m.orderBy = jest.fn().mockReturnThis();
  m.limit = jest.fn().mockReturnThis();
  m.offset = jest.fn().mockReturnThis();
  m.select = jest.fn().mockReturnThis();
  m.insert = jest.fn((data) => {
    const rows = Array.isArray(data) ? data : [data];
    _lastInsertInput = rows;
    const inserted = rows.map((r) => ({
      id: Math.random().toString(),
      created_at: new Date().toISOString(),
      ...r,
    }));
    _lastInserted = inserted;
    auditLogEvents.push(...inserted);
    if (mockCurrentTable === "audit_log_events") {
      mockInMemoryDb.push(...inserted);
    }
    if (mockCurrentTable === "invoice_files") {
      invoiceFiles.push(...inserted);
    }
    return m;
  });
  m.onConflict = jest.fn().mockReturnThis();
  m.merge = jest.fn((fields) => {
    if (mockCurrentTable === "investor_locks") {
      for (const row of _lastInsertInput || []) {
        const existing = investorLocks.find((candidate) => (
          candidate.tenant_id === row.tenant_id &&
          candidate.invoice_id === row.invoice_id &&
          candidate.funder_address === row.funder_address
        ));
        if (existing) {
          Object.assign(existing, row, fields, { updated_at: new Date().toISOString() });
        } else {
          investorLocks.push({
            id: Math.random().toString(),
            created_at: new Date().toISOString(),
            ...row,
          });
        }
      }
      return Promise.resolve(1);
    }
    return Promise.resolve(1);
  });
  m.update = jest.fn((fields) => {
    _lastUpdateFields = fields;
    const updatedRows = [{ id: 'updated-id', ...fields, updated_at: new Date().toISOString() }];
    m._resolveValue = Promise.resolve(updatedRows);
    return m;
  });
  m.del = jest.fn(() => {
    auditLogEvents.length = 0;
    return Promise.resolve(1);
  });
  m.first = jest.fn(() => {
    if (mockCurrentTable === "investor_locks") {
      return Promise.resolve(filterInvestorLocks()[0]);
    }
    if (mockCurrentTable === "invoice_files") {
      return Promise.resolve(filterInvoiceFiles()[0]);
    }
    return Promise.resolve({ id: 'test', kyc_status: 'approved' });
  });
  m.returning = jest.fn(() => {
    return Promise.resolve(_lastInserted || []);
  });
  m.delete = jest.fn(() => {
    if (mockCurrentTable === "investor_locks") {
      const retained = investorLocks.filter((row) => !Object.entries(queryWheres).every(([key, value]) => row[key] === value));
      investorLocks.length = 0;
      investorLocks.push(...retained);
      return Promise.resolve(1);
    }
    auditLogEvents.length = 0;
    return Promise.resolve(1);
  });
  m.andWhere = jest.fn((field, value) => {
    if (typeof field === "string") {
      queryWheres[field] = value;
    } else if (field && typeof field === "object") {
      queryWheres = { ...queryWheres, ...field };
    }
    return m;
  });
  m.orWhere = jest.fn().mockReturnThis();
  m.count = jest.fn(() => {
    if (mockCurrentTable === "investor_locks") {
      return Promise.resolve([{ count: filterInvestorLocks().length }]);
    }
    return Promise.resolve([{ count: 25 }]);
  });
  m.raw = jest.fn();
  m.clone = jest.fn().mockReturnThis();
  m.clearSelect = jest.fn().mockReturnThis();
  m.clearOrder = jest.fn().mockReturnThis();
  m.fn = { now: jest.fn(() => new Date().toISOString()) };
  m.migrate = { latest: jest.fn().mockResolvedValue([0, []]) };
  m.destroy = jest.fn().mockResolvedValue(undefined);
  m.then = jest.fn((onFulfilled) => {
    if (m._resolveValue) {
      const rv = m._resolveValue;
      m._resolveValue = null;
      return rv.then(onFulfilled);
    }
    if (mockCurrentTable === "investor_locks") {
      let results = filterInvestorLocks().sort((a, b) => {
        const createdCompare = String(a.created_at).localeCompare(String(b.created_at));
        if (createdCompare !== 0) {
          return createdCompare;
        }
        return String(a.invoice_id).localeCompare(String(b.invoice_id));
      });
      if (_offset) {
        results = results.slice(_offset);
      }
      if (_limit !== null) {
        results = results.slice(0, _limit);
      }
      return Promise.resolve(results).then(onFulfilled);
    }
    if (mockCurrentTable === "audit_log_events") {
      return Promise.resolve(mockInMemoryDb).then(onFulfilled);
    }
    if (mockCurrentTable === "invoice_files") {
      return Promise.resolve(filterInvoiceFiles()).then(onFulfilled);
    }
    return Promise.resolve([]).then(onFulfilled);
  });

  m.offset = jest.fn((value = 0) => {
    if (mockCurrentTable === "investor_locks") {
      _offset = value;
      return m;
    }
    let results = [...auditLogEvents];

    if (queryWheres.target_id) {
      results = results.filter((r) => r.target_id === queryWheres.target_id);
    }

    if (queryWheres.target_type) {
      results = results.filter((r) => r.target_type === queryWheres.target_type);
    }

    if (queryWheres.actor_id) {
      results = results.filter((r) => r.actor_id === queryWheres.actor_id);
    }

    if (queryWheres.action) {
      results = results.filter((r) => r.action === queryWheres.action);
    }

    results.reverse();
    return Promise.resolve(results);
  });
  m.limit = jest.fn((value) => {
    _limit = value;
    return m;
  });
  return m;
}, { virtual: true });

jest.mock('@stellar/stellar-sdk', () => ({
  nativeToScVal: jest.fn(),
  Address: {
    fromString: jest.fn(() => ({
      toScVal: jest.fn(),
    })),
  },
  Keypair: {
    fromSecret: jest.fn(() => ({
      publicKey: jest.fn(() => 'mock-public-key'),
      sign: jest.fn(),
    })),
  },
  StrKey: {
    encodeEd25519PublicKey: jest.fn((payload) => {
      const byte = Buffer.isBuffer(payload) && payload.length > 0 ? payload[0] : 1;
      const alphabet = 'BCDEFGHIJKLMNOPQRSTUVWXYZ234567';
      return `G${'A'.repeat(54)}${alphabet[byte % alphabet.length]}`;
    }),
    encodeContract: jest.fn((payload) => {
      const byte = Buffer.isBuffer(payload) && payload.length > 0 ? payload[0] : 1;
      const alphabet = 'BCDEFGHIJKLMNOPQRSTUVWXYZ234567';
      return `C${'A'.repeat(54)}${alphabet[byte % alphabet.length]}`;
    }),
    isValidEd25519PublicKey: jest.fn((value) => {
      return typeof value === 'string' && /^G[A-Z2-7]{55}$/.test(value) && !/^G{56}$/.test(value);
    }),
    isValidContract: jest.fn((value) => {
      return typeof value === 'string' && /^C[A-Z2-7]{55}$/.test(value) && !/^C{56}$/.test(value);
    }),
    isValidContractId: jest.fn((contractId) => {
      if (typeof contractId !== 'string') return false;
      const CONTRACT_ID_RE = /^C[A-Z2-7]{55}$/;
      if (!CONTRACT_ID_RE.test(contractId)) return false;
      // In the unit tests, the invalid checksum contract ID ends with 'A'.
      // We reject any ID ending with 'A' to simulate invalid checksum validation.
      if (contractId.endsWith('A')) return false;
      return true;
    }),
  },
}), { virtual: true });

jest.mock('@stellar/stellar-sdk/rpc', () => ({
  Server: jest.fn().mockImplementation(() => ({
    getTransaction: jest.fn(),
    sendTransaction: jest.fn(),
    simulateTransaction: jest.fn(),
    // Required by the issue #436 contract-existence preflight in
    // src/services/escrowSubmit.js (`_preflightContractExists`).
    getLedgerEntry: jest.fn(),
    getContractData: jest.fn(),
    prepareTransaction: jest.fn(),
  })),
}), { virtual: true });

jest.mock('rate-limit-redis', () => ({
  RedisStore: jest.fn().mockImplementation(() => ({})),
}), { virtual: true });

jest.mock('../../src/middleware/rateLimit', () => {
  const noopMiddleware = (req, res, next) => next();
  return {
    globalLimiter: noopMiddleware,
    sensitiveLimiter: noopMiddleware,
    apiKeyLimiter: noopMiddleware,
    apiKeysLimiter: noopMiddleware,
    createApiKeysRateLimiter: jest.fn(() => noopMiddleware),
    apiKeysRateLimitHandler: jest.fn(),
    API_KEYS_RATE_LIMIT_WINDOW_MS: 900000,
    API_KEYS_RATE_LIMIT_MAX: 60,
    adminConfigLimiter: noopMiddleware,
    metricsLimiter: noopMiddleware,
    healthLimiter: noopMiddleware,
    metricsLimiter: noopMiddleware,
    createConfigRateLimiter: jest.fn(() => noopMiddleware),
    createMetricsRateLimiter: jest.fn(() => noopMiddleware),
    metricsRateLimitHandler: jest.fn(),
    invoiceStateLimiter: noopMiddleware,
    escrowReadLimiter: noopMiddleware,
    indexerLimiter: noopMiddleware,
    createPersistenceRateLimiter: jest.fn(() => noopMiddleware),
    createRateLimiter: jest.fn(() => noopMiddleware),
    adminConfigHandler: jest.fn(),
    metricsRateLimitHandler: jest.fn(),
    kycWebhookLimiter: noopMiddleware,
    createKycWebhookRateLimiter: jest.fn(() => noopMiddleware),
    kycWebhookRateLimitHandler: jest.fn(),
    adminConfigKeyGenerator: jest.fn((req) => req.ip || '127.0.0.1'),
    healthHandler: jest.fn(),
    metricsRateLimitHandler: jest.fn(),
    createMetricsRateLimiter: jest.fn(() => noopMiddleware),
    parseRateLimitEnv: jest.fn((_, def) => def),
    keyGenerator: jest.fn((req) => req.ip || '127.0.0.1'),
    apiKeyKeyGenerator: jest.fn((req) => req.ip || '127.0.0.1'),
    metricsLimiter: noopMiddleware,
    createMetricsRateLimiter: jest.fn(() => noopMiddleware),
    metricsRateLimitHandler: jest.fn(),
    METRICS_RATE_LIMIT_WINDOW_MS: 60000,
    METRICS_RATE_LIMIT_MAX: 30,
    CONFIG_RATE_LIMIT_WINDOW_MS: 60000,
    CONFIG_RATE_LIMIT_MAX: 20,
    METRICS_RATE_LIMIT_WINDOW_MS: 60000,
    METRICS_RATE_LIMIT_MAX: 30,
    HEALTH_RATE_LIMIT_WINDOW_MS: 15000,
    HEALTH_RATE_LIMIT_MAX: 60,
    metricsLimiter: noopMiddleware,
    createMetricsRateLimiter: jest.fn(() => noopMiddleware),
    metricsRateLimitHandler: jest.fn(),
    METRICS_RATE_LIMIT_WINDOW_MS: 60000,
    METRICS_RATE_LIMIT_MAX: 30,
  };
}, { virtual: true });