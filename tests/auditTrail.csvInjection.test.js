'use strict';

/**
 * @fileoverview Comprehensive tests for CSV formula-injection escaping
 * in the invoice audit-trail export stream (issue #379).
 *
 * Covers all OWASP CSV injection dangerous characters:
 *   =  +  -  @  |  \t (0x09)  \r (0x0D)
 * plus combinations, newline embedding, and whitespace variants.
 */

jest.mock('../src/db/knex');
jest.mock('../src/middleware/apiKeyAuth', () => ({
  authenticateApiKey: () => (req, res, next) => next()
}));

const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');

const { createAuditLog, clearAuditLogs } = require('../src/services/auditLog');
const auditTrailRouter = require('../src/routes/auditTrail');

const JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
const TENANT = 'tenant-test';

function makeToken() {
  return jwt.sign({ sub: 'admin-1', tenantId: TENANT }, JWT_SECRET, { expiresIn: '1h' });
}

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/admin/audit', auditTrailRouter);
  app.use((err, req, res, _next) => {
    res.status(err.status || 500).json({ error: err.detail || err.message || 'error' });
  });
  return app;
}

/**
 * Seed an audit log entry and return the CSV export response body.
 */
async function exportCsvForActor(app, actor, invoiceId = 'inv-formula-test') {
  await createAuditLog({
    actor,
    action: 'UPDATE',
    resourceType: 'invoice',
    resourceId: invoiceId,
    metadata: { tenantId: TENANT },
  });

  const res = await request(app)
    .get(`/api/admin/audit/invoices/${invoiceId}/export?format=csv`)
    .set('Authorization', `Bearer ${makeToken()}`)
    .set('x-tenant-id', TENANT);

  return res;
}

describe('CSV formula-injection escaping — audit trail export (issue #379)', () => {
  let app;

  beforeEach(async () => {
    await clearAuditLogs();
    app = buildApp();
  });

  // ── = prefix (Excel formula injection) ────────────────────────────────────

  it('escapes actor starting with "=" (formula injection)', async () => {
    const res = await exportCsvForActor(app, '=CMD("whoami")');
    expect(res.status).toBe(200);
    // The field must not appear as a raw formula at the start of a CSV cell
    expect(res.text).not.toMatch(/(?:^|,)=CMD/m);
    // The single-quote prefix must be present
    expect(res.text).toContain("'=CMD");
  });

  it('escapes actor starting with "=SUM" (spreadsheet formula)', async () => {
    const res = await exportCsvForActor(app, '=SUM(A1:A10)');
    expect(res.status).toBe(200);
    expect(res.text).not.toMatch(/(?:^|,)=SUM/m);
    expect(res.text).toContain("'=SUM(A1:A10)");
  });

  // ── + prefix ──────────────────────────────────────────────────────────────

  it('escapes actor starting with "+" (formula injection)', async () => {
    const res = await exportCsvForActor(app, '+HYPERLINK("http://evil.com","Click")');
    expect(res.status).toBe(200);
    expect(res.text).not.toMatch(/(?:^|,)\+HYPERLINK/m);
    expect(res.text).toContain("'+HYPERLINK");
  });

  // ── - prefix ──────────────────────────────────────────────────────────────

  it('escapes actor starting with "-" (formula injection)', async () => {
    const res = await exportCsvForActor(app, '-2+3+CMD|" /C calc"!A0');
    expect(res.status).toBe(200);
    expect(res.text).not.toMatch(/(?:^|,)-2\+3/m);
    expect(res.text).toContain("'-2+3+CMD");
  });

  // ── @ prefix ──────────────────────────────────────────────────────────────

  it('escapes actor starting with "@" (formula injection)', async () => {
    const res = await exportCsvForActor(app, '@SUM(1+1)*cmd|" /C calc"!A0');
    expect(res.status).toBe(200);
    expect(res.text).not.toMatch(/(?:^|,)@SUM/m);
    expect(res.text).toContain("'@SUM(1+1)");
  });

  // ── | prefix ──────────────────────────────────────────────────────────────

  it('escapes actor starting with "|" (DDE/pipe injection)', async () => {
    const res = await exportCsvForActor(app, '|calc.exe');
    expect(res.status).toBe(200);
    expect(res.text).not.toMatch(/(?:^|,)\|calc/m);
    expect(res.text).toContain("'|calc.exe");
  });

  // ── tab prefix ────────────────────────────────────────────────────────────

  it('escapes actor starting with tab character (0x09)', async () => {
    const tabActor = '\t=MALICIOUS()';
    const res = await exportCsvForActor(app, tabActor, 'inv-tab-test');
    expect(res.status).toBe(200);
    // Should be prefixed with single-quote before the tab
    expect(res.text).toContain("'\t=MALICIOUS()");
  });

  // ── carriage-return prefix ─────────────────────────────────────────────────

  it('escapes actor starting with carriage return (0x0D)', async () => {
    const crActor = '\r=MALICIOUS()';
    const res = await exportCsvForActor(app, crActor, 'inv-cr-test');
    expect(res.status).toBe(200);
    expect(res.text).toContain("'\r=MALICIOUS()");
  });

  // ── safe values must not be modified ──────────────────────────────────────

  it('does not prefix safe actor names', async () => {
    const res = await exportCsvForActor(app, 'admin-user', 'inv-safe-test');
    expect(res.status).toBe(200);
    expect(res.text).toContain('admin-user');
    expect(res.text).not.toContain("'admin-user");
  });

  it('does not prefix actor names that merely contain "=" (not at start)', async () => {
    const res = await exportCsvForActor(app, 'admin=user', 'inv-mid-eq-test');
    expect(res.status).toBe(200);
    // No prefix needed — danger is only at position 0
    expect(res.text).toContain('admin=user');
    expect(res.text).not.toContain("'admin=user");
  });

  // ── combined CSV quoting + formula injection ───────────────────────────────

  it('prefixes AND quotes an actor that starts with "=" AND contains a comma', async () => {
    const res = await exportCsvForActor(app, '=CMD,whoami', 'inv-combined-test');
    expect(res.status).toBe(200);
    // After formula-injection prefix: "'=CMD,whoami" → contains comma → quoted
    expect(res.text).toContain('"\'=CMD,whoami"');
  });

  it('prefixes AND quotes an actor that starts with "=" AND contains a double-quote', async () => {
    const res = await exportCsvForActor(app, '=CMD("calc")', 'inv-quote-formula-test');
    expect(res.status).toBe(200);
    // After prefix and CSV quoting of embedded quotes
    expect(res.text).toContain('"\'=CMD(""calc"")"');
  });

  // ── userAgent and ipAddress fields also sanitized ─────────────────────────

  it('escapes formula injection in userAgent field', async () => {
    await createAuditLog({
      actor: 'admin-1',
      action: 'UPDATE',
      resourceType: 'invoice',
      resourceId: 'inv-ua-test',
      userAgent: '=HYPERLINK("http://evil.com")',
      metadata: { tenantId: TENANT },
    });

    const res = await request(app)
      .get('/api/admin/audit/invoices/inv-ua-test/export?format=csv')
      .set('Authorization', `Bearer ${makeToken()}`)
      .set('x-tenant-id', TENANT);

    expect(res.status).toBe(200);
    // The sanitized value has single-quote prefix; raw formula must not appear at cell start
    expect(res.text).not.toMatch(/(?:^|,)=HYPERLINK/m);
    expect(res.text).toContain("'=HYPERLINK");
  });

  it('escapes formula injection in ipAddress field', async () => {
    await createAuditLog({
      actor: 'admin-1',
      action: 'UPDATE',
      resourceType: 'invoice',
      resourceId: 'inv-ip-test',
      ipAddress: '=CMD|"/C calc"!A0',
      metadata: { tenantId: TENANT },
    });

    const res = await request(app)
      .get('/api/admin/audit/invoices/inv-ip-test/export?format=csv')
      .set('Authorization', `Bearer ${makeToken()}`)
      .set('x-tenant-id', TENANT);

    expect(res.status).toBe(200);
    // Must not appear as a raw formula at cell start
    expect(res.text).not.toMatch(/(?:^|,)=CMD\|/m);
    expect(res.text).toContain("'=CMD|");
  });

  // ── empty and null values ─────────────────────────────────────────────────

  it('handles null/empty fields without error', async () => {
    await createAuditLog({
      actor: 'admin-1',
      action: 'UPDATE',
      resourceType: 'invoice',
      resourceId: 'inv-null-test',
      ipAddress: null,
      userAgent: null,
      metadata: { tenantId: TENANT },
    });

    const res = await request(app)
      .get('/api/admin/audit/invoices/inv-null-test/export?format=csv')
      .set('Authorization', `Bearer ${makeToken()}`)
      .set('x-tenant-id', TENANT);

    expect(res.status).toBe(200);
    const lines = res.text.split('\n');
    expect(lines[0]).toBe('id,timestamp,actor,action,resourceType,resourceId,statusCode,ipAddress,userAgent');
    expect(lines.length).toBeGreaterThan(1);
  });

  // ── multiple dangerous records ────────────────────────────────────────────

  it('sanitizes multiple rows with different dangerous prefixes', async () => {
    const dangerousActors = ['=A1', '+B2', '-C3', '@D4'];
    for (const actor of dangerousActors) {
      await createAuditLog({
        actor,
        action: 'UPDATE',
        resourceType: 'invoice',
        resourceId: 'inv-multi-test',
        metadata: { tenantId: TENANT },
      });
    }

    const res = await request(app)
      .get('/api/admin/audit/invoices/inv-multi-test/export?format=csv')
      .set('Authorization', `Bearer ${makeToken()}`)
      .set('x-tenant-id', TENANT);

    expect(res.status).toBe(200);
    // No raw dangerous prefixes in the CSV data rows
    const dataRows = res.text.split('\n').slice(1); // skip header
    for (const row of dataRows) {
      expect(row).not.toMatch(/(?:^|,)=A1(?:,|$)/);
      expect(row).not.toMatch(/(?:^|,)\+B2(?:,|$)/);
      expect(row).not.toMatch(/(?:^|,)-C3(?:,|$)/);
      expect(row).not.toMatch(/(?:^|,)@D4(?:,|$)/);
    }
    // All four sanitized values should be present
    dangerousActors.forEach((actor) => {
      expect(res.text).toContain(`'${actor}`);
    });
  });
});
