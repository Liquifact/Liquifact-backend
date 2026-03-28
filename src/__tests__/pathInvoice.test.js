
'use strict';

const request = require('supertest');
const { app, resetStore } = require('../index');

/**
 * Creates an invoice and returns the full response body data object.
 *
 * @param {object} [overrides] - Fields to override on the default body.
 * @returns {Promise<object>} Created invoice data.
 */
async function createInvoice(overrides = {}) {
  const body = { amount: 1000, customer: 'Acme Corp', ...overrides };
  const res = await request(app).post('/api/invoices').send(body);
  return res.body.data;
}

/**
 * Sends a PATCH request and returns the full supertest response.
 *
 * @param {string} id
 * @param {object} body
 * @returns {Promise<import('supertest').Response>}
 */
async function patchInvoice(id, body) {
  return request(app).patch(`/api/invoices/${id}`).send(body);
}

describe('PATCH /api/invoices/:id — Controlled Field Updates', () => {
  beforeEach(() => {
    resetStore();
  });

  describe('1. Allowed field updates (pending_verification)', () => {
    it('updates amount on a pending invoice', async () => {
      const inv = await createInvoice({ amount: 500 });
      const res = await patchInvoice(inv.id, { amount: 750 });

      expect(res.status).toBe(200);
      expect(res.body.data.amount).toBe(750);
      expect(res.body.data.customer).toBe('Acme Corp');
      expect(res.body.message).toBe('Invoice updated successfully.');
    });

    it('updates customer on a pending invoice', async () => {
      const inv = await createInvoice();
      const res = await patchInvoice(inv.id, { customer: 'Globex Inc.' });

      expect(res.status).toBe(200);
      expect(res.body.data.customer).toBe('Globex Inc.');
    });

    it('updates notes on a pending invoice', async () => {
      const inv = await createInvoice();
      const res = await patchInvoice(inv.id, { notes: 'Net 30 terms' });

      expect(res.status).toBe(200);
      expect(res.body.data.notes).toBe('Net 30 terms');
    });

    it('updates multiple allowed fields at once', async () => {
      const inv = await createInvoice();
      const res = await patchInvoice(inv.id, {
        amount: 9999,
        customer: 'Wayne Enterprises',
        notes: 'Rush order',
      });

      expect(res.status).toBe(200);
      expect(res.body.data.amount).toBe(9999);
      expect(res.body.data.customer).toBe('Wayne Enterprises');
      expect(res.body.data.notes).toBe('Rush order');
    });

    it('sets updatedAt on a successful patch', async () => {
      const inv = await createInvoice();
      expect(inv.updatedAt).toBeNull();

      const res = await patchInvoice(inv.id, { notes: 'first edit' });
      expect(res.status).toBe(200);
      expect(res.body.data.updatedAt).not.toBeNull();
      expect(new Date(res.body.data.updatedAt).getTime()).toBeGreaterThan(0);
    });

    it('preserves unpatched fields unchanged', async () => {
      const inv = await createInvoice({ amount: 100, customer: 'Stark Industries' });
      await patchInvoice(inv.id, { notes: 'expedited' });

      // Verify via GET that amount and customer are intact
      const listRes = await request(app).get('/api/invoices');
      const updated = listRes.body.data.find((i) => i.id === inv.id);
      expect(updated.amount).toBe(100);
      expect(updated.customer).toBe('Stark Industries');
      expect(updated.notes).toBe('expedited');
    });

    it('advances updatedAt on successive patches', async () => {
      const inv = await createInvoice();
      const res1 = await patchInvoice(inv.id, { notes: 'first' });
      // Small delay to ensure different timestamps
      await new Promise((r) => setTimeout(r, 5));
      const res2 = await patchInvoice(inv.id, { notes: 'second' });

      const t1 = new Date(res1.body.data.updatedAt).getTime();
      const t2 = new Date(res2.body.data.updatedAt).getTime();
      expect(t2).toBeGreaterThanOrEqual(t1);
    });
  });

  describe('2. Unknown / disallowed field rejection', () => {
    it('returns 400 when only unknown fields are provided', async () => {
      const inv = await createInvoice();
      const res = await patchInvoice(inv.id, { status: 'funded' });

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/No valid fields provided/i);
    });

    it('strips unknown fields and applies allowed ones when mixed', async () => {
      const inv = await createInvoice();
      const res = await patchInvoice(inv.id, {
        notes: 'legit note',
        status: 'funded',        // disallowed
        deletedAt: '2099-01-01', // disallowed
        __proto__: { evil: true }, // prototype pollution attempt
      });

      expect(res.status).toBe(200);
      expect(res.body.data.notes).toBe('legit note');
      expect(res.body.data.status).toBe('pending_verification'); // unchanged
      expect(res.body.data.deletedAt).toBeNull();
    });

    it('does not allow setting id via patch', async () => {
      const inv = await createInvoice();
      const res = await patchInvoice(inv.id, { id: 'spoofed_id', notes: 'test' });

      expect(res.status).toBe(200);
      expect(res.body.data.id).toBe(inv.id); // original id intact
    });

    it('does not allow setting createdAt via patch', async () => {
      const inv = await createInvoice();
      const originalCreatedAt = inv.createdAt;
      const res = await patchInvoice(inv.id, {
        createdAt: '1970-01-01T00:00:00.000Z',
        notes: 'valid',
      });

      expect(res.status).toBe(200);
      expect(res.body.data.createdAt).toBe(originalCreatedAt);
    });
  });

  describe('3. Status-aware locking — amount and customer locked post-pending', () => {
    const LOCKED_STATUSES = ['verified', 'funded', 'settled', 'cancelled'];

    for (const status of LOCKED_STATUSES) {
      describe(`status: "${status}"`, () => {
        it(`rejects amount change when status is ${status}`, async () => {
          const inv = await createInvoice();
          const { forceInvoiceStatus } = require('../index');
          forceInvoiceStatus(inv.id, status);

          const res = await patchInvoice(inv.id, { amount: 99999 });
          expect(res.status).toBe(422);
          expect(res.body.error).toMatch(/amount/i);
          expect(res.body.error).toMatch(new RegExp(status, 'i'));
        });

        it(`rejects customer change when status is ${status}`, async () => {
          const inv = await createInvoice();
          const { forceInvoiceStatus } = require('../index');
          forceInvoiceStatus(inv.id, status);

          const res = await patchInvoice(inv.id, { customer: 'Hacker Corp' });
          expect(res.status).toBe(422);
          expect(res.body.error).toMatch(/customer/i);
        });

        it(`allows notes change when status is ${status}`, async () => {
          const inv = await createInvoice();
          const { forceInvoiceStatus } = require('../index');
          forceInvoiceStatus(inv.id, status);

          const res = await patchInvoice(inv.id, { notes: 'addendum' });
          expect(res.status).toBe(200);
          expect(res.body.data.notes).toBe('addendum');
        });
      });
    }
  });

  describe('4. Soft-deleted invoice guard', () => {
    it('returns 409 when trying to PATCH a soft-deleted invoice', async () => {
      const inv = await createInvoice();
      await request(app).delete(`/api/invoices/${inv.id}`);

      const res = await patchInvoice(inv.id, { notes: 'sneaky update' });
      expect(res.status).toBe(409);
      expect(res.body.error).toMatch(/soft-deleted/i);
    });

    it('allows PATCH after restoring a previously deleted invoice', async () => {
      const inv = await createInvoice();
      await request(app).delete(`/api/invoices/${inv.id}`);
      await request(app).patch(`/api/invoices/${inv.id}/restore`);

      const res = await patchInvoice(inv.id, { notes: 'after restore' });
      expect(res.status).toBe(200);
      expect(res.body.data.notes).toBe('after restore');
    });
  });

  describe('5. Not-found guard', () => {
    it('returns 404 for a non-existent invoice id', async () => {
      const res = await patchInvoice('inv_nonexistent_000', { notes: 'ghost' });
      expect(res.status).toBe(404);
      expect(res.body.error).toMatch(/not found/i);
    });
  });

  describe('6. Malformed or empty body', () => {
    it('returns 400 for an empty object body', async () => {
      const inv = await createInvoice();
      const res = await patchInvoice(inv.id, {});
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/No valid fields/i);
    });

    it('returns 400 for a body with only unknown keys', async () => {
      const inv = await createInvoice();
      const res = await patchInvoice(inv.id, { foo: 'bar', baz: 42 });
      expect(res.status).toBe(400);
    });

    it('returns 400 when body is an array', async () => {
      const inv = await createInvoice();
      const res = await request(app)
        .patch(`/api/invoices/${inv.id}`)
        .send([{ notes: 'array attempt' }]);
      expect(res.status).toBe(400);
    });
  });

  describe('7. Security — prototype pollution', () => {
    it('does not pollute Object prototype via malicious body', async () => {
      const inv = await createInvoice();
      await request(app)
        .patch(`/api/invoices/${inv.id}`)
        .set('Content-Type', 'application/json')
        .send('{"__proto__":{"polluted":true},"notes":"ok"}');

      expect(({}).polluted).toBeUndefined();
    });
  });

  describe('8. Response shape', () => {
    it('returns expected fields in the response body', async () => {
      const inv = await createInvoice();
      const res = await patchInvoice(inv.id, { notes: 'shape check' });

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('data');
      expect(res.body).toHaveProperty('message');
      const data = res.body.data;
      expect(data).toHaveProperty('id');
      expect(data).toHaveProperty('amount');
      expect(data).toHaveProperty('customer');
      expect(data).toHaveProperty('notes');
      expect(data).toHaveProperty('status');
      expect(data).toHaveProperty('createdAt');
      expect(data).toHaveProperty('updatedAt');
      expect(data).toHaveProperty('deletedAt');
    });
  });
});

describe('patchInvoice middleware — unit tests', () => {
  const {
    extractAllowedFields,
    detectLockedFieldChange,
    MUTABLE_FIELDS,
    PENDING_ONLY_FIELDS,
    LOCKED_STATUSES,
  } = require('../middleware/patchInvoice');

  describe('extractAllowedFields()', () => {
    it('returns only mutable fields from a mixed body', () => {
      const result = extractAllowedFields({
        amount: 100,
        customer: 'X',
        notes: 'y',
        status: 'funded',
        id: 'hax',
      });
      expect(Object.keys(result).sort()).toEqual(['amount', 'customer', 'notes']);
    });

    it('returns empty object when no allowed keys are present', () => {
      expect(extractAllowedFields({ status: 'funded', foo: 'bar' })).toEqual({});
    });

    it('returns empty object for an empty input', () => {
      expect(extractAllowedFields({})).toEqual({});
    });
  });

  describe('detectLockedFieldChange()', () => {
    it('returns locked=false for pending_verification status', () => {
      expect(detectLockedFieldChange({ amount: 99 }, 'pending_verification')).toEqual({ locked: false });
    });

    it('returns locked=false when no pending-only fields are in payload', () => {
      expect(detectLockedFieldChange({ notes: 'ok' }, 'verified')).toEqual({ locked: false });
    });

    it('detects locked amount change for verified status', () => {
      const result = detectLockedFieldChange({ amount: 99 }, 'verified');
      expect(result.locked).toBe(true);
      expect(result.field).toBe('amount');
    });

    it('detects locked customer change for funded status', () => {
      const result = detectLockedFieldChange({ customer: 'evil' }, 'funded');
      expect(result.locked).toBe(true);
      expect(result.field).toBe('customer');
    });

    it('returns locked=false for notes-only payload on any locked status', () => {
      for (const status of LOCKED_STATUSES) {
        expect(detectLockedFieldChange({ notes: 'ok' }, status)).toEqual({ locked: false });
      }
    });
  });

  describe('exported constants', () => {
    it('MUTABLE_FIELDS contains amount, customer, notes', () => {
      expect(MUTABLE_FIELDS.has('amount')).toBe(true);
      expect(MUTABLE_FIELDS.has('customer')).toBe(true);
      expect(MUTABLE_FIELDS.has('notes')).toBe(true);
    });

    it('PENDING_ONLY_FIELDS contains amount and customer', () => {
      expect(PENDING_ONLY_FIELDS.has('amount')).toBe(true);
      expect(PENDING_ONLY_FIELDS.has('customer')).toBe(true);
      expect(PENDING_ONLY_FIELDS.has('notes')).toBe(false);
    });

    it('LOCKED_STATUSES contains verified, funded, settled, cancelled', () => {
      expect(LOCKED_STATUSES.has('verified')).toBe(true);
      expect(LOCKED_STATUSES.has('funded')).toBe(true);
      expect(LOCKED_STATUSES.has('settled')).toBe(true);
      expect(LOCKED_STATUSES.has('cancelled')).toBe(true);
      expect(LOCKED_STATUSES.has('pending_verification')).toBe(false);
    });
  });
});