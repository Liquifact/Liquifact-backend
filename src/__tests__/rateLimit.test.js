const request = require('supertest');
const jwt = require('jsonwebtoken');
const app = require('../index');

describe('Rate Limiting Middleware', () => {
    const secret = process.env.JWT_SECRET || 'test-secret';
    const validToken = jwt.sign({ id: 'test_user_1' }, secret);
    const validBody = { amount: 100, customer: 'Rate Test Corp' };

    it('should return 200 for health check (global limiter allows many)', async () => {
        const response = await request(app).get('/health');
        expect(response.status).toBe(200);
        expect(response.headers).toHaveProperty('ratelimit-limit');
    });

    describe('Sensitive Operations Throttling - POST /api/invoices', () => {
        it('should allow up to 10 requests and then return 429 Too Many Requests', async () => {
            for (let i = 0; i < 10; i++) {
                const response = await request(app)
                    .post('/api/invoices')
                    .set('Authorization', `Bearer ${validToken}`)
                    .send(validBody);
                if (response.status === 429) {
                    break;
                }
                expect(response.status).toBe(201);
            }
            const throttledResponse = await request(app)
                .post('/api/invoices')
                .set('Authorization', `Bearer ${validToken}`)
                .send(validBody);
            expect(throttledResponse.status).toBe(429);
            expect(throttledResponse.body.error).toContain('rate limit exceeded');
        });
    });
});
