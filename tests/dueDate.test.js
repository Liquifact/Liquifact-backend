'use strict';

/**
 * @fileoverview Strict dueDate validation: real calendar dates inside the
 * contract's tenor window (MIN_TENOR_DAYS / MAX_TENOR_DAYS).
 */

const request = require('supertest');
const { authHeader } = require('./helpers/auth');
const app = require('../src/app');
const store = require('../src/data/store');

const DAY_MS = 86_400_000;

/** Formats an epoch-ms value as YYYY-MM-DD (UTC). */
function isoDay(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

const todayMs = Date.UTC(
  new Date().getUTCFullYear(),
  new Date().getUTCMonth(),
  new Date().getUTCDate(),
);

const payload = (dueDate) => ({ sme: 'Strict SME', debtor: 'Buyer', amount: 500, dueDate });

beforeEach(() => {
  store.reset();
});

describe('dueDate strictness', () => {
  test.each([
    ['2020-01-01', 'past date'],
    ['2027-02-30', 'impossible calendar date'],
    ['2027-13-01', 'invalid month'],
    ['2027-1-1', 'non-padded components'],
    ['January 1, 2028', 'natural language'],
    [isoDay(todayMs + 2000 * DAY_MS), 'beyond MAX_TENOR_DAYS'],
  ])('rejects %s (%s)', async (dueDate) => {
    const res = await request(app).post('/api/invoices').set(authHeader()).send(payload(dueDate));
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_FAILED');
    expect(res.body.errors.some((e) => e.path === 'dueDate')).toBe(true);
  });

  test('accepts tomorrow and computes maturity as UTC midnight', async () => {
    const dueDate = isoDay(todayMs + DAY_MS);
    const res = await request(app).post('/api/invoices').set(authHeader()).send(payload(dueDate));
    expect(res.status).toBe(201);
    expect(res.body.data.dueDate).toBe(dueDate);
    expect(res.body.data.maturity).toBe(Date.parse(`${dueDate}T00:00:00.000Z`) / 1000);
  });
});
