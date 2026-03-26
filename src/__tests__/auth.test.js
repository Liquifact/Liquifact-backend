const request = require('supertest');
const jwt = require('jsonwebtoken');
const { app } = require('../index');

describe('Authentication Middleware', () => {
    const secret = process.env.JWT_SECRET || 'test-secret';
    const validPayload = { id: 1, role: 'user' };
    let validToken;
    let expiredToken;

    beforeAll(() => {
        validToken = jwt.sign(validPayload, secret, { expiresIn: '1h' });
        expiredToken = jwt.sign(validPayload, secret, { expiresIn: '-1h' });
    });

    describe('Route Protection - POST /api/invoices', () => {
        it('should return 401 when no token is provided', async () => {
            const response = await request(app).post('/api/invoices').send({});
            expect(response.status).toBe(401);
            expect(response.body.error).toBe('Authentication token is required');
        });

        it('should return 401 when token format is invalid (missing Bearer)', async () => {
            const response = await request(app)
                .post('/api/invoices')
                .set('Authorization', `FakeBearer ${validToken}`)
                .send({});
            expect(response.status).toBe(401);
            expect(response.body.error).toBe('Invalid Authorization header format. Expected "Bearer <token>"');
        });

        it('should return 401 when authorization header is malformed (no space)', async () => {
            const response = await request(app)
                .post('/api/invoices')
                .set('Authorization', `Bearer${validToken}`)
                .send({});
            expect(response.status).toBe(401);
            expect(response.body.error).toBe('Invalid Authorization header format. Expected "Bearer <token>"');
        });

        it('should return 401 when token is invalid', async () => {
            const response = await request(app)
                .post('/api/invoices')
                .set('Authorization', 'Bearer some.invalid.token')
                .send({});
            expect(response.status).toBe(401);
            expect(response.body.error).toBe('Invalid token');
        });

        it('should return 401 when token is expired', async () => {
            const response = await request(app)
                .post('/api/invoices')
                .set('Authorization', `Bearer ${expiredToken}`)
                .send({});
            expect(response.status).toBe(401);
            expect(response.body.error).toBe('Token has expired');
        });

        it('should return 201 when a valid token is provided with valid body', async () => {
            const response = await request(app)
                .post('/api/invoices')
                .set('Authorization', `Bearer ${validToken}`)
                .send({ amount: 500, customer: 'Auth Test Client' });
            expect(response.status).toBe(201);
            expect(response.body.data.status).toBe('pending_verification');
        });
    });

    describe('Route Protection - POST /api/escrow', () => {
        it('should allow escrow operations with valid token', async () => {
            const response = await request(app)
                .post('/api/escrow')
                .set('Authorization', `Bearer ${validToken}`)
                .send({});
            expect(response.status).toBe(200);
            expect(response.body.data.status).toBe('funded');
        });

        it('should reject escrow operations without token', async () => {
            const response = await request(app)
                .post('/api/escrow')
                .send({});
            expect(response.status).toBe(401);
        });
    });
});
