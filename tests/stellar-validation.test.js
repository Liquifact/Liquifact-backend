'use strict';

const request = require('supertest');
const { StrKey, Keypair } = require('@stellar/stellar-sdk');
const app = require('../src/app');
const store = require('../src/data/store');
const stellar = require('../src/lib/stellar-validate');

beforeEach(() => store.reset());

const kp = Keypair.random();
const G = kp.publicKey();
const SECRET = kp.secret();
const C = StrKey.encodeContract(Buffer.alloc(32, 7));
const M = StrKey.encodeMed25519PublicKey(Buffer.alloc(40, 3));
// Same length and charset as a real key but with a corrupted checksum.
const BAD_CHECKSUM = ['AA', 'BB', 'CC', 'DD']
  .map((tail) => `${G.slice(0, -2)}${tail}`)
  .find((s) => s !== G && !StrKey.isValidEd25519PublicKey(s));

const base = { sme: 'Test SME', debtor: 'Buyer', amount: 500, dueDate: '2027-01-01' };
const post = (extra) => request(app).post('/api/invoices').send({ ...base, ...extra });

describe('stellar-validate helpers', () => {
  test('classify keys', () => {
    expect(stellar.isAccountId(G)).toBe(true);
    expect(stellar.isContractId(C)).toBe(true);
    expect(stellar.isAccountId(C)).toBe(false);
    expect(stellar.looksLikeSecret(SECRET)).toBe(true);
    expect(stellar.isAccountId(BAD_CHECKSUM)).toBe(false);
    expect(stellar.isAccountId(42)).toBe(false);
    expect(stellar.isContractId(null)).toBe(false);
    expect(stellar.looksLikeSecret({})).toBe(false);
  });
});

describe('POST /api/invoices smeAddress', () => {
  test('accepts valid G and C addresses and omitted address', async () => {
    expect((await post({ smeAddress: G })).status).toBe(201);
    expect((await post({ smeAddress: C })).status).toBe(201);
    const none = await post({});
    expect(none.status).toBe(201);
    expect(none.body.data.smeAddress).toBeNull();
  });

  test('rejects invalid checksum', async () => {
    const res = await post({ smeAddress: BAD_CHECKSUM });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_STELLAR_ADDRESS');
  });

  test('invalid checksum was accepted by the old any-string rule, rejected now', async () => {
    // main copied any string: typeof b.smeAddress === 'string' ? b.smeAddress : null
    const legacy = (b) => (typeof b.smeAddress === 'string' ? b.smeAddress : null);
    expect(legacy({ smeAddress: BAD_CHECKSUM })).toBe(BAD_CHECKSUM);
    expect((await post({ smeAddress: BAD_CHECKSUM })).status).toBe(400);
  });

  test('rejects too long, markup and non-string', async () => {
    for (const smeAddress of ['G'.repeat(100000), '<script>', 12345, ['x'], {}, true]) {
      const res = await post({ smeAddress });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('INVALID_STELLAR_ADDRESS');
    }
  });

  test('rejects muxed address with a specific message', async () => {
    const res = await post({ smeAddress: M });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_STELLAR_ADDRESS');
    expect(res.body.error).toMatch(/muxed/i);
  });

  test('secret seed is refused and never echoed or logged', async () => {
    const spies = ['log', 'info', 'warn', 'error'].map((m) => jest.spyOn(console, m).mockImplementation(() => {}));
    const res = await post({ smeAddress: SECRET });
    const logged = JSON.stringify(spies.map((s) => s.mock.calls));
    spies.forEach((s) => s.mockRestore());
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('SECRET_KEY_SUBMITTED');
    expect(res.body.error).toMatch(/rotate/i);
    expect(res.text).not.toContain(SECRET);
    expect(logged).not.toContain(SECRET);
    expect(store.list().some((i) => JSON.stringify(i).includes(SECRET))).toBe(false);
  });
});

describe('seed data', () => {
  test('every seeded smeAddress is a valid StrKey', () => {
    const items = store.list();
    expect(items.length).toBeGreaterThan(0);
    for (const i of items) {
      expect(stellar.isAccountId(i.smeAddress) || stellar.isContractId(i.smeAddress)).toBe(true);
    }
  });
});

describe('POST /api/invoices currency', () => {
  test('defaults to USDC', async () => {
    expect((await post({})).body.data.currency).toBe('USDC');
  });

  test('normalises lowercase input', async () => {
    const res = await post({ currency: 'xlm' });
    expect(res.status).toBe(201);
    expect(res.body.data.currency).toBe('XLM');
  });

  test('rejects unsupported, emoji, whitespace and non-string', async () => {
    for (const currency of ['EUR', 'usd💸', '   ', '', 'DROP TABLE', 5]) {
      const res = await post({ currency });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('UNSUPPORTED_CURRENCY');
      expect(res.body.allowed).toEqual(expect.arrayContaining(['XLM', 'USDC']));
    }
  });
});

describe('GET /api/invoices?smeAddress=', () => {
  test('filters by a valid address', async () => {
    const addr = store.list()[0].smeAddress;
    const res = await request(app).get(`/api/invoices?smeAddress=${addr}`);
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(1);
    expect(res.body.data[0].smeAddress).toBe(addr);
  });

  test('rejects invalid and secret values', async () => {
    const bad = await request(app).get(`/api/invoices?smeAddress=${BAD_CHECKSUM}`);
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe('INVALID_STELLAR_ADDRESS');
    const secret = await request(app).get(`/api/invoices?smeAddress=${SECRET}`);
    expect(secret.status).toBe(400);
    expect(secret.body.code).toBe('SECRET_KEY_SUBMITTED');
    expect(secret.text).not.toContain(SECRET);
  });
});

describe('openapi', () => {
  test('documents the new parameters, codes and responses', async () => {
    const { body } = await request(app).get('/openapi.json');
    const route = body.paths['/api/invoices'];
    expect(route.get.parameters.map((p) => p.name)).toContain('smeAddress');
    expect(route.get.responses[400]).toBeDefined();
    const props = route.post.requestBody.content['application/json'].schema.properties;
    expect(props.smeAddress.maxLength).toBe(56);
    expect(props.currency.enum).toEqual(expect.arrayContaining(['XLM', 'USDC']));
    const err = route.post.responses[400].content['application/json'].schema.properties;
    expect(err.code.enum).toEqual(
      expect.arrayContaining(['INVALID_STELLAR_ADDRESS', 'SECRET_KEY_SUBMITTED', 'UNSUPPORTED_CURRENCY']),
    );
    expect(err.allowed).toBeDefined();
  });
});
