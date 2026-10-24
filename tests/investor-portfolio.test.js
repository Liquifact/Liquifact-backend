'use strict';

const request = require('supertest');
const app = require('../src/app');
const store = require('../src/data/store');
const contributions = require('../src/data/contributions');

beforeEach(() => store.reset());

const INVESTOR_A = 'GA7TXEBMEPQCLHIYCWDN7RKAO5IMRD2UV7O7TZXMEW6VZUMEXNR4XBB5';
const INVESTOR_B = 'GBTUJNOF2WAAUPKCJHBB76ID5HGN6KMTUG43F3Z344T7QRTP7B7TVPVC';
const INVESTOR_EMPTY = 'GBD3OBQM2K3GSBVKRPZOUW3DTZLWMOKIGW2XW6ZQ3PFFNIAT7NFBN6IV';

describe('Investor Contributions and Portfolio', () => {
  test('funds INV_0002 from two investors and asserts contributions, totals, and each portfolio', async () => {
    // Fund from investor A
    const resA = await request(app)
      .post('/api/invoices/INV_0002/fund')
      .send({ amount: 2000, investor: INVESTOR_A });
    expect(resA.status).toBe(200);
    expect(resA.body.data.fundedAmount).toBe(20000); // 18000 seed + 2000

    // Fund from investor B
    const resB = await request(app)
      .post('/api/invoices/INV_0002/fund')
      .send({ amount: 3000, investor: INVESTOR_B });
    expect(resB.status).toBe(200);
    expect(resB.body.data.fundedAmount).toBe(23000); // 20000 + 3000

    // Query contributions for INV_0002
    const contribRes = await request(app).get('/api/invoices/INV_0002/contributions');
    expect(contribRes.status).toBe(200);
    expect(contribRes.body.totals.funded).toBe(23000);
    expect(contribRes.body.totals.investors).toBe(3); // seed demo investor + A + B
    expect(contribRes.body.data.length).toBe(3);

    // Assert each contribution item shape
    expect(contribRes.body.data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          investor: INVESTOR_A,
          amount: 2000,
          createdAt: expect.any(String),
        }),
        expect.objectContaining({
          investor: INVESTOR_B,
          amount: 3000,
          createdAt: expect.any(String),
        }),
      ]),
    );

    // Query portfolio for investor A (yieldBps is 650 on INV_0002)
    // 2000 * 650 / 10000 = 130
    const portA = await request(app).get(`/api/investors/${INVESTOR_A}/portfolio`);
    expect(portA.status).toBe(200);
    expect(portA.body.investor).toBe(INVESTOR_A);
    expect(portA.body.positions).toHaveLength(1);
    expect(portA.body.positions[0]).toEqual({
      invoiceId: 'INV_0002',
      status: 'open',
      currency: 'USDC',
      principal: 2000,
      yieldBps: 650,
      dueDate: '2026-12-30',
      expectedCoupon: 130,
      expectedPayout: 2130,
    });
    expect(portA.body.totalsByCurrency).toEqual({
      USDC: {
        principal: 2000,
        expectedCoupon: 130,
        expectedPayout: 2130,
      },
    });

    // Query portfolio for investor B
    // 3000 * 650 / 10000 = 195
    const portB = await request(app).get(`/api/investors/${INVESTOR_B}/portfolio`);
    expect(portB.status).toBe(200);
    expect(portB.body.investor).toBe(INVESTOR_B);
    expect(portB.body.positions).toHaveLength(1);
    expect(portB.body.positions[0]).toEqual({
      invoiceId: 'INV_0002',
      status: 'open',
      currency: 'USDC',
      principal: 3000,
      yieldBps: 650,
      dueDate: '2026-12-30',
      expectedCoupon: 195,
      expectedPayout: 3195,
    });
    expect(portB.body.totalsByCurrency).toEqual({
      USDC: {
        principal: 3000,
        expectedCoupon: 195,
        expectedPayout: 3195,
      },
    });
  });

  test('invariant: fundedAmount === sum of contributions for every invoice after N random fund calls', async () => {
    // Create new open invoice to have plenty of headroom
    const created = await request(app)
      .post('/api/invoices')
      .send({
        sme: 'Invariant SME',
        debtor: 'Buyer Inc',
        amount: 100000,
        currency: 'USDC',
        yieldBps: 500,
        dueDate: '2027-01-01',
      });
    const testInvoiceId = created.body.data.id;

    const investors = [INVESTOR_A, INVESTOR_B];
    const N = 25;

    for (let i = 0; i < N; i++) {
      const inv = investors[i % investors.length];
      const amount = Math.floor(Math.random() * 50) + 1; // 1 to 50
      const res = await request(app)
        .post(`/api/invoices/${testInvoiceId}/fund`)
        .send({ amount, investor: inv });
      expect(res.status).toBe(200);
    }

    // Assert invariant for every invoice in store
    const allInvoices = store.list();
    for (const inv of allInvoices) {
      const sum = contributions.sumForInvoice(inv.id);
      expect(inv.fundedAmount).toBe(sum);
    }
  });

  test('failure tests: missing investor, invalid address, self-funding, unknown invoice, empty portfolio', async () => {
    // 1. Missing investor
    const missingRes = await request(app)
      .post('/api/invoices/INV_0002/fund')
      .send({ amount: 100 });
    expect(missingRes.status).toBe(400);
    expect(missingRes.body.error).toBe('INVESTOR_REQUIRED');

    // 2. Invalid investor address on fund
    const invalidFundRes = await request(app)
      .post('/api/invoices/INV_0002/fund')
      .send({ amount: 100, investor: 'not-a-valid-stellar-key' });
    expect(invalidFundRes.status).toBe(400);
    expect(invalidFundRes.body.error).toBe('INVALID_INVESTOR_ADDRESS');

    // 3. Self-funding rejected with 422
    // INV_0001 has smeAddress = INVESTOR_A
    const selfRes = await request(app)
      .post('/api/invoices/INV_0001/fund')
      .send({ amount: 10, investor: INVESTOR_A });
    expect(selfRes.status).toBe(422);
    expect(selfRes.body.error).toBe('SELF_FUNDING_NOT_ALLOWED');

    // 4. Unknown invoice on fund
    const unknownFundRes = await request(app)
      .post('/api/invoices/INV_9999/fund')
      .send({ amount: 10, investor: INVESTOR_B });
    expect(unknownFundRes.status).toBe(404);
    expect(unknownFundRes.body.error).toBe('Invoice not found');

    // 5. Unknown invoice on contributions query
    const unknownContribRes = await request(app).get('/api/invoices/INV_9999/contributions');
    expect(unknownContribRes.status).toBe(404);
    expect(unknownContribRes.body.error).toBe('Invoice not found');

    // 6. Invalid address on portfolio query
    const invalidPortRes = await request(app).get('/api/investors/INVALID_ADDR/portfolio');
    expect(invalidPortRes.status).toBe(400);
    expect(invalidPortRes.body.error).toBe('INVALID_INVESTOR_ADDRESS');

    // 7. Portfolio for address with no positions returns 200 with empty positions and totals
    const emptyPortRes = await request(app).get(`/api/investors/${INVESTOR_EMPTY}/portfolio`);
    expect(emptyPortRes.status).toBe(200);
    expect(emptyPortRes.body).toEqual({
      investor: INVESTOR_EMPTY,
      positions: [],
      totalsByCurrency: {},
    });
  });

  test('store.fund enforces required investor parameter', () => {
    const inv = store.get('INV_0001');
    expect(() => store.fund(inv, 10)).toThrow('investor address is required to fund an invoice');
  });

  test('coupon math truncates using integer minor unit arithmetic where floor rounding matters', async () => {
    // Create an invoice with yieldBps: 650 (6.5%)
    const created = await request(app)
      .post('/api/invoices')
      .send({
        sme: 'Fractional SME',
        debtor: 'Buyer B',
        amount: 1000,
        currency: 'USDC',
        yieldBps: 650,
        dueDate: '2027-06-30',
      });
    const invoiceId = created.body.data.id;

    // Principal with 7 decimal places: 123.4567891
    // In minor units (stroops): 1,234,567,891n
    // coupon = 1,234,567,891n * 650n / 10000n = 802,469,129,150n / 10000n = 80,246,912n (remainder 9150 floored!)
    // 80,246,912n / 1e7 = 8.0246912
    // Payout = 123.4567891 + 8.0246912 = 131.4814803
    // Note: Float math without minor unit floor produces 8.0246912915, so floor rounding strictly matters here!
    const principal = 123.4567891;
    await request(app)
      .post(`/api/invoices/${invoiceId}/fund`)
      .send({ amount: principal, investor: INVESTOR_B });

    const port = await request(app).get(`/api/investors/${INVESTOR_B}/portfolio`);
    expect(port.status).toBe(200);
    const pos = port.body.positions.find((p) => p.invoiceId === invoiceId);
    expect(pos).toBeDefined();
    expect(pos.principal).toBe(principal);
    expect(pos.expectedCoupon).toBe(8.0246912);
    expect(pos.expectedPayout).toBe(131.4814803);
  });

  test('aggregates multiple contributions by the same investor to one invoice', async () => {
    // Fund INV_0002 twice by INVESTOR_B
    await request(app)
      .post('/api/invoices/INV_0002/fund')
      .send({ amount: 1000, investor: INVESTOR_B });
    await request(app)
      .post('/api/invoices/INV_0002/fund')
      .send({ amount: 1500, investor: INVESTOR_B });

    const port = await request(app).get(`/api/investors/${INVESTOR_B}/portfolio`);
    expect(port.status).toBe(200);
    // Should have only 1 aggregated position for INV_0002
    const inv2Positions = port.body.positions.filter((p) => p.invoiceId === 'INV_0002');
    expect(inv2Positions).toHaveLength(1);
    expect(inv2Positions[0].principal).toBe(2500); // 1000 + 1500
    expect(inv2Positions[0].expectedCoupon).toBe(162.5); // 2500 * 650 / 10000
    expect(inv2Positions[0].expectedPayout).toBe(2662.5);
  });

  test('cancelled invoice shows expectedCoupon: "0" and returns principal as expectedPayout', async () => {
    // Fund an invoice
    await request(app)
      .post('/api/invoices/INV_0002/fund')
      .send({ amount: 1000, investor: INVESTOR_B });

    // Manually mark invoice as cancelled
    const invoice = store.get('INV_0002');
    invoice.status = 'cancelled';

    const port = await request(app).get(`/api/investors/${INVESTOR_B}/portfolio`);
    expect(port.status).toBe(200);
    const pos = port.body.positions.find((p) => p.invoiceId === 'INV_0002');
    expect(pos.status).toBe('cancelled');
    expect(pos.expectedCoupon).toBe('0');
    expect(pos.expectedPayout).toBe(1000);
  });

  test('contributions endpoint pagination with limit and cursor', async () => {
    // INV_0002 initially has 1 seed contribution. Add 3 more contributions.
    await request(app)
      .post('/api/invoices/INV_0002/fund')
      .send({ amount: 100, investor: INVESTOR_A });
    await request(app)
      .post('/api/invoices/INV_0002/fund')
      .send({ amount: 200, investor: INVESTOR_B });
    await request(app)
      .post('/api/invoices/INV_0002/fund')
      .send({ amount: 300, investor: INVESTOR_A });

    // Test invalid limit
    const badLimit = await request(app).get('/api/invoices/INV_0002/contributions?limit=0');
    expect(badLimit.status).toBe(400);

    const badLimitOver = await request(app).get('/api/invoices/INV_0002/contributions?limit=101');
    expect(badLimitOver.status).toBe(400);

    // Page 1 with limit=2
    const page1 = await request(app).get('/api/invoices/INV_0002/contributions?limit=2');
    expect(page1.status).toBe(200);
    expect(page1.body.data).toHaveLength(2);
    expect(page1.body.nextCursor).toBeDefined();

    // Page 2 using nextCursor
    const page2 = await request(app).get(
      `/api/invoices/INV_0002/contributions?limit=2&cursor=${page1.body.nextCursor}`,
    );
    expect(page2.status).toBe(200);
    expect(page2.body.data).toHaveLength(2);

    // Invalid cursor
    const badCursor = await request(app).get('/api/invoices/INV_0002/contributions?cursor=nonexistent');
    expect(badCursor.status).toBe(400);
  });

  test('OpenAPI documents new and updated paths and schemas in GET /openapi.json', async () => {
    const spec = (await request(app).get('/openapi.json')).body;
    expect(spec.paths['/api/invoices/{id}/contributions']).toBeDefined();
    expect(spec.paths['/api/invoices/{id}/contributions'].get).toBeDefined();
    expect(spec.paths['/api/investors/{address}/portfolio']).toBeDefined();
    expect(spec.paths['/api/investors/{address}/portfolio'].get).toBeDefined();

    const fundOp = spec.paths['/api/invoices/{id}/fund'].post;
    expect(fundOp.requestBody.content['application/json'].schema.required).toContain('investor');
  });
});
