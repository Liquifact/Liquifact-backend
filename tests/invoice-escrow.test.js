'use strict';

const request = require('supertest');
const { StrKey } = require('@stellar/stellar-sdk');
const app = require('../src/app');
const store = require('../src/data/store');
const escrowReader = require('../src/routes/escrow');
const { exactStroops } = require('../src/routes/invoices');

const CONTRACT_A = StrKey.encodeContract(Buffer.alloc(32, 5));
const CONTRACT_B = StrKey.encodeContract(Buffer.alloc(32, 6));
const CONTRACT_C = StrKey.encodeContract(Buffer.alloc(32, 7));
const token = 'integration-test-secret';
const auth = { Authorization: 'Bearer ' + token };
const base = '/api/invoices/INV_0002/escrow';
const terms = (overrides = {}) => ({
  invoice_id: 'INV_0002',
  amount: '250000000000',
  sme_address: 'GBNORTHWINDDEMOADDRESSXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
  yield_bps: 650,
  status: 0,
  ...overrides,
});

let read;
beforeEach(() => {
  store.reset();
  process.env.ADMIN_API_TOKEN = token;
  read = jest.spyOn(escrowReader, 'readEscrowOnChain').mockResolvedValue(terms());
});
afterEach(() => {
  read.mockRestore();
  delete process.env.ADMIN_API_TOKEN;
});

describe('verified invoice escrow linking (#1553)', () => {
  test('success verifies the requested contract, and GET reads that same contract', async () => {
    const linked = await request(app).post(base).set(auth).send({ contractId: CONTRACT_A });
    expect(linked.status).toBe(200);
    expect(linked.body.data).toMatchObject({ escrowContractId: CONTRACT_A, onChain: true });
    expect(read).toHaveBeenCalledWith(CONTRACT_A);
    const fetched = await request(app).get(base);
    expect(fetched.status).toBe(200);
    expect(fetched.body).toEqual({ contractId: CONTRACT_A, escrow: terms() });
    expect(read).toHaveBeenLastCalledWith(CONTRACT_A);
  });

  test.each([
    ['invoice_id', { invoice_id: 'INV_WRONG' }],
    ['amount', { amount: '250000000001' }],
    ['sme_address', { sme_address: 'GOTHER' }],
    ['yield_bps', { yield_bps: 700 }],
    ['status', { status: 4 }],
  ])('rejects %s mismatch', async (field, change) => {
    read.mockResolvedValue(terms(change));
    const res = await request(app).post(base).set(auth).send({ contractId: CONTRACT_A });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('ESCROW_TERMS_MISMATCH');
    expect(res.body.mismatches).toEqual(expect.arrayContaining([expect.objectContaining({ field })]));
    expect(store.get('INV_0002').onChain).toBe(false);
  });

  test('unreadable or non-escrow contracts are not linked', async () => {
    read.mockRejectedValueOnce(new Error('Contract does not exist')).mockResolvedValueOnce(null);
    for (const contractId of [CONTRACT_A, CONTRACT_B]) {
      const res = await request(app).post(base).set(auth).send({ contractId });
      expect(res.status).toBe(422);
      expect(res.body.code).toBe('ESCROW_NOT_FOUND');
    }
  });

  test('same contract is idempotent; different contract is ALREADY_LINKED', async () => {
    expect((await request(app).post(base).set(auth).send({ contractId: CONTRACT_A })).status).toBe(200);
    read.mockClear();
    const same = await request(app).post(base).set(auth).send({ contractId: CONTRACT_A });
    expect(same.status).toBe(200);
    expect(read).not.toHaveBeenCalled();
    const different = await request(app).post(base).set(auth).send({ contractId: CONTRACT_B });
    expect(different.status).toBe(409);
    expect(different.body.code).toBe('ALREADY_LINKED');
  });

  test('cannot reuse contract linked to another invoice', async () => {
    store.linkEscrow(store.get('INV_0003'), CONTRACT_A);
    const res = await request(app).post(base).set(auth).send({ contractId: CONTRACT_A });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('CONTRACT_IN_USE');
    expect(read).not.toHaveBeenCalled();
  });

  test('invalid contract ID and missing invoice', async () => {
    const invalid = await request(app).post(base).set(auth).send({ contractId: 'CINVALID' });
    expect(invalid.status).toBe(400);
    expect(invalid.body.code).toBe('INVALID_CONTRACT_ID');
    const missing = await request(app).post('/api/invoices/missing/escrow').set(auth).send({ contractId: CONTRACT_A });
    expect(missing.status).toBe(404);
    expect(missing.body.code).toBe('INVOICE_NOT_FOUND');
  });

  test('missing, wrong or unset admin token rejects without simulation', async () => {
    const missing = await request(app).post(base).send({ contractId: CONTRACT_A });
    expect(missing.status).toBe(401);
    const wrong = await request(app).post(base).set('Authorization', 'Bearer wrong').send({ contractId: CONTRACT_A });
    expect(wrong.status).toBe(401);
    delete process.env.ADMIN_API_TOKEN;
    const unset = await request(app).post(base).set(auth).send({ contractId: CONTRACT_A });
    expect(unset.status).toBe(503);
    expect(unset.body.code).toBe('ADMIN_TOKEN_NOT_CONFIGURED');
    expect(read).not.toHaveBeenCalled();
  });

  test('GET unlinked invoice returns NOT_LINKED', async () => {
    const res = await request(app).get(base);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('NOT_LINKED');
  });

  test('newly created invoice can become onChain after verification', async () => {
    const created = await request(app).post('/api/invoices').send({
      sme: 'Fresh SME', debtor: 'Buyer', amount: 100, dueDate: '2027-01-01', yieldBps: 800,
    });
    expect(created.status).toBe(201);
    expect(created.body.data).toMatchObject({ escrowContractId: null, onChain: false });
    read.mockResolvedValue({ invoice_id: created.body.data.id, amount: '1000000000', yield_bps: 800, status: 0 });
    const linked = await request(app).post('/api/invoices/' + created.body.data.id + '/escrow').set(auth).send({ contractId: CONTRACT_C });
    expect(linked.status).toBe(200);
    expect(linked.body.data).toMatchObject({ escrowContractId: CONTRACT_C, onChain: true });
  });

  test('amount conversion is exact at seven decimals', async () => {
    expect(exactStroops(100)).toBe('1000000000');
    expect(exactStroops(100.0000001)).toBe('1000000001');
    expect(exactStroops(0.00000001)).toBeNull();
    const invoice = store.create({ sme: 'A', debtor: 'B', amount: 100.0000001, yieldBps: 800, smeAddress: null });
    read.mockResolvedValue({ invoice_id: invoice.id, amount: '1000000000', yield_bps: 800, status: 0 });
    const res = await request(app).post('/api/invoices/' + invoice.id + '/escrow').set(auth).send({ contractId: CONTRACT_C });
    expect(res.status).toBe(422);
    expect(res.body.mismatches).toEqual(expect.arrayContaining([expect.objectContaining({ field: 'amount' })]));
  });

  test('OpenAPI includes routes, schemas, request body, and errors', async () => {
    const res = await request(app).get('/openapi.json');
    const paths = res.body.paths['/api/invoices/{id}/escrow'];
    expect(paths.post.requestBody.content['application/json'].schema.properties.contractId).toBeDefined();
    expect(paths.post.security).toEqual([{ AdminBearer: [] }]);
    for (const status of ['200', '400', '401', '404', '409', '422', '503']) {
      expect(paths.post.responses[status]).toBeDefined();
    }
    for (const status of ['200', '404', '422']) { expect(paths.get.responses[status]).toBeDefined(); }
    expect(res.body.components.schemas).toHaveProperty('Invoice');
    expect(res.body.components.schemas).toHaveProperty('Escrow');
    expect(res.body.components.schemas).toHaveProperty('LinkError');
    expect(res.body.components.schemas.Invoice.properties).toHaveProperty('escrowContractId');
  });
});
