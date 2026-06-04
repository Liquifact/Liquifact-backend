'use strict';

process.env.NODE_ENV = 'test';

jest.mock('../src/db/knex', () => jest.fn());
jest.mock('../src/logger', () => ({ warn: jest.fn(), error: jest.fn(), info: jest.fn() }));
jest.mock('../src/services/auditLogStore', () => ({ appendAuditEvent: jest.fn() }));

const db = require('../src/db/knex');
const logger = require('../src/logger');
const { appendAuditEvent } = require('../src/services/auditLogStore');

const { emitWebhook } = require('../src/services/webhooks');

describe('webhooks retry behavior', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        delete process.env.WEBHOOK_MAX_RETRIES;
        delete process.env.WEBHOOK_BASE_DELAY;
        delete process.env.WEBHOOK_MAX_DELAY;
        delete process.env.WEBHOOK_TIMEOUT_MS;
    });

    it('succeeds on first try and records success audit', async () => {
        const mockFetch = jest.fn().mockResolvedValue({ ok: true, status: 200 });
        global.fetch = mockFetch;

        db.mockReturnValueOnce({ select: jest.fn().mockReturnThis(), where: jest.fn().mockReturnThis(), first: jest.fn().mockResolvedValue({ tenant_id: 't1' }) });
        db.mockReturnValueOnce({ select: jest.fn().mockReturnThis(), where: jest.fn().mockReturnThis(), first: jest.fn().mockResolvedValue({ settings: { webhook_url: 'https://x', webhook_secret: 's' } }) });

        await emitWebhook('escrow_funded', 'inv1', { amount: 1 });

        expect(mockFetch).toHaveBeenCalledTimes(1);
        expect(appendAuditEvent).toHaveBeenCalled();
        expect(logger.info).toHaveBeenCalled();
    });

    it('retries on transient error then succeeds', async () => {
        const mockFetch = jest.fn()
            .mockRejectedValueOnce(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }))
            .mockResolvedValueOnce({ ok: true, status: 200 });
        global.fetch = mockFetch;

        db.mockReturnValueOnce({ select: jest.fn().mockReturnThis(), where: jest.fn().mockReturnThis(), first: jest.fn().mockResolvedValue({ tenant_id: 't2' }) });
        db.mockReturnValueOnce({ select: jest.fn().mockReturnThis(), where: jest.fn().mockReturnThis(), first: jest.fn().mockResolvedValue({ settings: { webhook_url: 'https://x', webhook_secret: 's' } }) });

        await emitWebhook('escrow_settled', 'inv2');

        expect(mockFetch).toHaveBeenCalledTimes(2);
        // appendAuditEvent should be called at least once for the failed attempt
        expect(appendAuditEvent.mock.calls.length).toBeGreaterThanOrEqual(1);
    });

    it('does not retry on 4xx and records final failure', async () => {
        const mockFetch = jest.fn().mockResolvedValue({ ok: false, status: 400 });
        global.fetch = mockFetch;

        db.mockReturnValueOnce({ select: jest.fn().mockReturnThis(), where: jest.fn().mockReturnThis(), first: jest.fn().mockResolvedValue({ tenant_id: 't3' }) });
        db.mockReturnValueOnce({ select: jest.fn().mockReturnThis(), where: jest.fn().mockReturnThis(), first: jest.fn().mockResolvedValue({ settings: { webhook_url: 'https://x', webhook_secret: 's' } }) });

        await emitWebhook('escrow_funded', 'inv3');

        expect(mockFetch).toHaveBeenCalledTimes(1);
        // appendAuditEvent should be called for the failed attempt
        expect(appendAuditEvent).toHaveBeenCalled();
    });

    it('exhausts retries and writes to dead-letter', async () => {
        process.env.WEBHOOK_MAX_RETRIES = '2';
        const mockFetch = jest.fn().mockRejectedValue(new Error('netfail'));
        global.fetch = mockFetch;

        // db call chain: first invoices, then tenants, then insert into webhook_dead_letters
        const first = { select: jest.fn().mockReturnThis(), where: jest.fn().mockReturnThis(), first: jest.fn().mockResolvedValue({ tenant_id: 't4' }) };
        const second = { select: jest.fn().mockReturnThis(), where: jest.fn().mockReturnThis(), first: jest.fn().mockResolvedValue({ settings: { webhook_url: 'https://x', webhook_secret: 's' } }) };
        const insertStub = { insert: jest.fn().mockResolvedValue([1]) };
        db.mockReturnValueOnce(first);
        db.mockReturnValueOnce(second);
        db.mockReturnValueOnce(insertStub);

        await emitWebhook('escrow_funded', 'inv4');

        // After exhaustion, insert into webhook_dead_letters should be attempted
        expect(insertStub.insert).toHaveBeenCalled();
        // appendAuditEvent should have been called for attempts
        expect(appendAuditEvent.mock.calls.length).toBeGreaterThanOrEqual(1);
    });

    it('returns early when invoice missing, tenant missing, or webhook not configured', async () => {
        const mockFetch = jest.fn();
        global.fetch = mockFetch;

        // invoice missing
        db.mockReturnValue({ select: jest.fn().mockReturnThis(), where: jest.fn().mockReturnThis(), first: jest.fn().mockResolvedValue(null) });
        await emitWebhook('escrow_funded', 'missing_inv');
        expect(mockFetch).not.toHaveBeenCalled();

        // tenant missing
        db.mockReturnValueOnce({ select: jest.fn().mockReturnThis(), where: jest.fn().mockReturnThis(), first: jest.fn().mockResolvedValue({ tenant_id: 't' }) });
        db.mockReturnValueOnce({ select: jest.fn().mockReturnThis(), where: jest.fn().mockReturnThis(), first: jest.fn().mockResolvedValue(null) });
        await emitWebhook('escrow_funded', 'inv_no_tenant');
        expect(mockFetch).not.toHaveBeenCalled();

        // webhook not configured
        db.mockReturnValueOnce({ select: jest.fn().mockReturnThis(), where: jest.fn().mockReturnThis(), first: jest.fn().mockResolvedValue({ tenant_id: 't' }) });
        db.mockReturnValueOnce({ select: jest.fn().mockReturnThis(), where: jest.fn().mockReturnThis(), first: jest.fn().mockResolvedValue({ settings: {} }) });
        await emitWebhook('escrow_funded', 'inv_no_webhook');
        expect(mockFetch).not.toHaveBeenCalled();
    });

    it('signature helpers produce and verify signatures', () => {
        const { createSignature, createSignatureHeader, verifySignature } = require('../src/services/webhooks');
        const secret = 's3cr3t';
        const body = JSON.stringify({ a: 1 });
        const ts = Math.floor(Date.now() / 1000);
        const sig = createSignature(secret, body, ts);
        expect(typeof sig).toBe('string');

        const header = createSignatureHeader(secret, body);
        const res = verifySignature(secret, body, header, 60 * 1000);
        expect(res.valid).toBe(true);
    });

    it('handles audit failures, dead-letter persist errors, and metric inc failures gracefully', async () => {
        process.env.WEBHOOK_MAX_RETRIES = '1';
        const mockFetch = jest.fn().mockRejectedValue(new Error('netfail'));
        global.fetch = mockFetch;

        // invoice, tenant
        const first = { select: jest.fn().mockReturnThis(), where: jest.fn().mockReturnThis(), first: jest.fn().mockResolvedValue({ tenant_id: 't5' }) };
        const second = { select: jest.fn().mockReturnThis(), where: jest.fn().mockReturnThis(), first: jest.fn().mockResolvedValue({ settings: { webhook_url: 'https://x', webhook_secret: 's' } }) };
        // simulate insert throwing
        const insertStub = { insert: jest.fn().mockRejectedValue(new Error('dbfail')) };
        db.mockReturnValueOnce(first);
        db.mockReturnValueOnce(second);
        db.mockReturnValueOnce(insertStub);

        // make audit append fail
        appendAuditEvent.mockImplementation(() => Promise.reject(new Error('auditfail')));

        // make metric inc throw
        const mod = require('../src/services/webhooks');
        mod.emitWebhook._failureCounter = { inc: () => { throw new Error('metfail'); } };

        await emitWebhook('escrow_funded', 'inv5');

        // ensure we attempted insert and encountered errors logged
        expect(insertStub.insert).toHaveBeenCalled();
        expect(logger.warn).toHaveBeenCalled();
        expect(logger.error).toHaveBeenCalled();
    });
});
