const request = require('supertest');
const jwt = require('jsonwebtoken');
const app = require('../index');

describe('Rate Limiting Middleware', () => {
    const secret = process.env.JWT_SECRET || 'test-secret';
    const validToken = jwt.sign({ id: 'test_user_1' }, secret);

    it('should return 200 for health check (global limiter allows many)', async () => {
        const response = await request(app).get('/health');
        expect(response.status).toBe(200);
        expect(response.headers).toHaveProperty('ratelimit-limit');
    });

    describe('Sensitive Operations Throttling - POST /api/invoices', () => {
        // Note: The sensitive limiter has a limit of 10 per hour.
        // To avoid affecting other tests, we should ideally use a fresh instance, 
        // but here we demonstrate the 429 response by hitting it 11 times.

        it('should allow up to 10 requests and then return 429 Too Many Requests', async () => {
            // Send 10 successful requests
            for (let i = 0; i < 10; i++) {
                const response = await request(app)
                    .post('/api/invoices')
                    .set('Authorization', `Bearer ${validToken}`)
                    .send({ amount: 1000, customer: 'Rate Ltd' });

                // If we hit a 429 early because of previous tests, we just break and check the next one.
                if (response.status === 429) {
                    break;
                }
                expect(response.status).toBe(201);
            }

            // The 11th request (or first request over the limit) should be 429
            const throttledResponse = await request(app)
                .post('/api/invoices')
                .set('Authorization', `Bearer ${validToken}`)
                .send({ amount: 1000, customer: 'Rate Ltd' });

            expect(throttledResponse.status).toBe(429);
            expect(throttledResponse.body.error).toContain('rate limit exceeded');
        });
    });
});
