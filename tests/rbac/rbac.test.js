const request = require('supertest');
const app = require('../../src/index');
const roleGuard = require('../../src/middleware/roleGuard');

describe('RBAC API Tests', () => {
  describe('Invoice POST', () => {
    it('admin -> 201', async () => {
      const res = await request(app).post('/api/invoices').set('x-role', 'admin');
      expect(res.statusCode).toBe(201);
    });
    it('operator -> 201', async () => {
      const res = await request(app).post('/api/invoices').set('x-role', 'operator');
      expect(res.statusCode).toBe(201);
    });
    it('user -> 403', async () => {
      const res = await request(app).post('/api/invoices').set('x-role', 'user');
      expect(res.statusCode).toBe(403);
    });
  });

  describe('Invoice GET', () => {
    it('admin -> 200', async () => {
      const res = await request(app).get('/api/invoices').set('x-role', 'admin');
      expect(res.statusCode).toBe(200);
    });
    it('operator -> 200', async () => {
      const res = await request(app).get('/api/invoices').set('x-role', 'operator');
      expect(res.statusCode).toBe(200);
    });
    it('user -> 200', async () => {
      const res = await request(app).get('/api/invoices').set('x-role', 'user');
      expect(res.statusCode).toBe(200);
    });
  });

  describe('Escrow GET', () => {
    it('admin -> 200', async () => {
      const res = await request(app).get('/api/escrow/123').set('x-role', 'admin');
      expect(res.statusCode).toBe(200);
    });
    it('operator -> 200', async () => {
      const res = await request(app).get('/api/escrow/123').set('x-role', 'operator');
      expect(res.statusCode).toBe(200);
    });
    it('user -> 403', async () => {
      const res = await request(app).get('/api/escrow/123').set('x-role', 'user');
      expect(res.statusCode).toBe(403);
    });
  });

  describe('Invoice Approval POST', () => {
    it('admin -> 200', async () => {
      const res = await request(app).post('/api/invoices/123/approve').set('x-role', 'admin');
      expect(res.statusCode).toBe(200);
    });
    it('operator -> 200', async () => {
      const res = await request(app).post('/api/invoices/123/approve').set('x-role', 'operator');
      expect(res.statusCode).toBe(200);
    });
    it('user -> 403', async () => {
      const res = await request(app).post('/api/invoices/123/approve').set('x-role', 'user');
      expect(res.statusCode).toBe(403);
    });
  });

  describe('Escrow Settlement POST', () => {
    it('admin -> 200', async () => {
      const res = await request(app).post('/api/escrow/123/settle').set('x-role', 'admin');
      expect(res.statusCode).toBe(200);
    });
    it('operator -> 403', async () => {
      const res = await request(app).post('/api/escrow/123/settle').set('x-role', 'operator');
      expect(res.statusCode).toBe(403);
    });
    it('user -> 403', async () => {
      const res = await request(app).post('/api/escrow/123/settle').set('x-role', 'user');
      expect(res.statusCode).toBe(403);
    });
  });

  describe('Invoice Status State Machine', () => {
    describe('Valid Transitions', () => {
      const validTransitions = [
        { current: 'draft', next: 'pending_verification' },
        { current: 'pending_verification', next: 'approved' },
        { current: 'pending_verification', next: 'draft' },
        { current: 'approved', next: 'funded' },
        { current: 'funded', next: 'settled' },
        { current: 'settled', next: 'closed' }
      ];

      validTransitions.forEach(({ current, next }) => {
        it(`${current} -> ${next} -> 200`, async () => {
          const res = await request(app)
            .patch('/api/invoices/123/status')
            .set('x-role', 'admin')
            .send({ currentStatus: current, nextStatus: next });
          expect(res.statusCode).toBe(200);
        });
      });
    });

    describe('Invalid Transitions', () => {
      const invalidTransitions = [
        { current: 'draft', next: 'approved' },
        { current: 'approved', next: 'draft' },
        { current: 'settled', next: 'approved' },
        { current: 'closed', next: 'draft' }
      ];

      invalidTransitions.forEach(({ current, next }) => {
        it(`${current} -> ${next} -> 400`, async () => {
          const res = await request(app)
            .patch('/api/invoices/123/status')
            .set('x-role', 'admin')
            .send({ currentStatus: current, nextStatus: next });
          expect(res.statusCode).toBe(400);
        });
      });
    });

    describe('RBAC Tests', () => {
      it('admin -> allowed', async () => {
        const res = await request(app)
          .patch('/api/invoices/123/status')
          .set('x-role', 'admin')
          .send({ currentStatus: 'draft', nextStatus: 'pending_verification' });
        expect(res.statusCode).toBe(200);
      });
      it('operator -> allowed', async () => {
        const res = await request(app)
          .patch('/api/invoices/123/status')
          .set('x-role', 'operator')
          .send({ currentStatus: 'draft', nextStatus: 'pending_verification' });
        expect(res.statusCode).toBe(200);
      });
      it('user -> 403', async () => {
        const res = await request(app)
          .patch('/api/invoices/123/status')
          .set('x-role', 'user')
          .send({ currentStatus: 'draft', nextStatus: 'pending_verification' });
        expect(res.statusCode).toBe(403);
      });
    });

    describe('State Machine Edge Cases', () => {
      it('missing currentStatus -> 400', async () => {
        const res = await request(app)
          .patch('/api/invoices/123/status')
          .set('x-role', 'admin')
          .send({ nextStatus: 'pending_verification' });
        expect(res.statusCode).toBe(400);
      });
      it('missing nextStatus -> 400', async () => {
        const res = await request(app)
          .patch('/api/invoices/123/status')
          .set('x-role', 'admin')
          .send({ currentStatus: 'draft' });
        expect(res.statusCode).toBe(400);
      });
      it('invalid status string -> 400', async () => {
        const res = await request(app)
          .patch('/api/invoices/123/status')
          .set('x-role', 'admin')
          .send({ currentStatus: 'invalid_status', nextStatus: 'another_invalid' });
        expect(res.statusCode).toBe(400);
      });
    });
  });

  describe('Edge Cases', () => {
    it('No header -> defaults to "user"', async () => {
      // POST requires admin/operator, defaults to user -> 403
      const resPost = await request(app).post('/api/invoices');
      expect(resPost.statusCode).toBe(403);

      // GET invoices allows user -> 200
      const resGet = await request(app).get('/api/invoices');
      expect(resGet.statusCode).toBe(200);

      // Approve invoice requires admin/operator -> 403
      const resApprove = await request(app).post('/api/invoices/123/approve');
      expect(resApprove.statusCode).toBe(403);

      // Settle escrow requires admin -> 403
      const resSettle = await request(app).post('/api/escrow/123/settle');
      expect(resSettle.statusCode).toBe(403);
    });

    it('Invalid role -> 403', async () => {
      const res = await request(app).get('/api/invoices').set('x-role', 'hacker');
      expect(res.statusCode).toBe(403);
    });

    it('Missing req.user -> 401', () => {
      const guard = roleGuard(['admin']);
      const req = {};
      const res = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn()
      };
      const next = jest.fn();

      guard(req, res, next);
      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith({ error: 'Unauthenticated' });
      expect(next).not.toHaveBeenCalled();
    });

    it('req.user present but no role -> 401', () => {
      const guard = roleGuard(['admin']);
      const req = { user: {} };
      const res = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn()
      };
      const next = jest.fn();

      guard(req, res, next);
      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith({ error: 'Unauthenticated' });
      expect(next).not.toHaveBeenCalled();
    });
  });
});
