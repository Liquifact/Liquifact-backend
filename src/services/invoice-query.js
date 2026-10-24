'use strict';

const { STATUSES } = require('../data/store');
const { parseDecimal, compareDecimals, decimalToString } = require('../utils/decimal');

const SORTS = ['createdAt', '-createdAt', 'dueDate', '-dueDate', 'yieldBps', '-yieldBps', 'amount', '-amount'];
const PARAMETERS = ['limit', 'cursor', 'status', 'currency', 'sme', 'minAmount', 'maxAmount', 'minYieldBps', 'maxYieldBps', 'dueBefore', 'dueAfter', 'onChain', 'sort'];

class InvoiceQueryError extends Error {
  constructor(code, details, options) {
    super(code === 'INVALID_CURSOR' ? 'Invalid pagination cursor' : 'Invalid invoice query', options);
    this.code = code;
    this.details = details;
  }
}

function isCalendarDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
}

function decodeCursor(text, sort) {
  const invalid = () => new InvoiceQueryError('INVALID_CURSOR', { cursor: 'Malformed cursor or cursor for a different sort' });
  if (text.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(text)) {
    throw invalid();
  }
  const bytes = Buffer.from(text, 'base64url');
  if (bytes.toString('base64url') !== text) {
    throw invalid();
  }
  let cursor;
  try {
    cursor = JSON.parse(bytes.toString('utf8'));
  } catch (cause) {
    throw new InvoiceQueryError('INVALID_CURSOR', { cursor: 'Malformed cursor' }, { cause });
  }
  if (!cursor || Array.isArray(cursor) || typeof cursor !== 'object' ||
      Object.keys(cursor).sort().join(',') !== 'id,sort,sortValue' ||
      cursor.sort !== sort || typeof cursor.id !== 'string' || !cursor.id || cursor.id.length > 128) {
    throw invalid();
  }
  const field = sort.replace(/^-/, '');
  const value = cursor.sortValue;
  if (field === 'amount') {
    if (typeof value !== 'string' || !/^\d+(\.\d+)?$/.test(value) || value.length > 128) {
      throw invalid();
    }
  } else if (field === 'yieldBps') {
    if (!Number.isInteger(value) || value < 0 || value > 10000) {
      throw invalid();
    }
  } else if (typeof value !== 'string' || (field === 'dueDate'
    ? !isCalendarDate(value)
    : !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value)) {
    throw invalid();
  }
  return cursor;
}

/** Validate once at the HTTP boundary; this object is independent of Express. */
function parseInvoiceQuery(raw) {
  const errors = Object.create(null);
  for (const [key, value] of Object.entries(raw)) {
    if (!PARAMETERS.includes(key)) {
      errors[key] = 'Unknown query parameter';
    } else if (typeof value !== 'string') {
      errors[key] = 'Must occur once and be a string';
    }
  }
  if (Object.keys(errors).length) {
    throw new InvoiceQueryError('VALIDATION_FAILED', errors);
  }
  const query = { ...raw, limit: 20, sort: raw.sort ?? '-createdAt' };
  if (raw.limit !== undefined) {
    if (!/^\d{1,3}$/.test(raw.limit) || Number(raw.limit) < 1 || Number(raw.limit) > 100) {
      errors.limit = 'Must be an integer from 1 to 100';
    } else {
      query.limit = Number(raw.limit);
    }
  }
  if (!SORTS.includes(query.sort)) {
    errors.sort = 'Unsupported sort';
  }
  if (raw.status !== undefined) {
    query.status = raw.status.split(',');
    if (query.status.some((status) => !STATUSES.includes(status))) {
      errors.status = 'Must be a comma-separated list of invoice statuses';
    }
  }
  if (raw.currency !== undefined && !/^[a-zA-Z0-9]{1,12}$/.test(raw.currency)) {
    errors.currency = 'Must be a 1-12 character alphanumeric asset code';
  }
  if (raw.sme !== undefined && (!raw.sme.trim() || raw.sme.length > 120)) {
    errors.sme = 'Must contain 1-120 characters';
  }
  for (const key of ['minAmount', 'maxAmount']) {
    if (raw[key] !== undefined && (raw[key].length > 128 || !/^\d+(\.\d+)?$/.test(raw[key]))) {
      errors[key] = 'Must be a non-negative decimal string of at most 128 characters';
    }
  }
  if (raw.minAmount !== undefined && raw.maxAmount !== undefined && !errors.minAmount && !errors.maxAmount && compareDecimals(raw.minAmount, raw.maxAmount) > 0) {
    errors.maxAmount = 'Must be greater than or equal to minAmount';
  }
  for (const key of ['minYieldBps', 'maxYieldBps']) {
    if (raw[key] !== undefined) {
      if (!/^\d{1,5}$/.test(raw[key]) || Number(raw[key]) > 10000) {
        errors[key] = 'Must be an integer from 0 to 10000';
      } else {
        query[key] = Number(raw[key]);
      }
    }
  }
  if (query.minYieldBps !== undefined && query.maxYieldBps !== undefined && query.minYieldBps > query.maxYieldBps) {
    errors.maxYieldBps = 'Must be greater than or equal to minYieldBps';
  }
  for (const key of ['dueBefore', 'dueAfter']) {
    if (raw[key] !== undefined && !isCalendarDate(raw[key])) {
      errors[key] = 'Must be a real calendar date in YYYY-MM-DD format';
    }
  }
  if (raw.dueBefore !== undefined && raw.dueAfter !== undefined && !errors.dueBefore && !errors.dueAfter && raw.dueAfter > raw.dueBefore) {
    errors.dueBefore = 'Must be on or after dueAfter';
  }
  if (raw.onChain !== undefined) {
    if (!['true', 'false'].includes(raw.onChain)) {
      errors.onChain = 'Must be true or false';
    } else {
      query.onChain = raw.onChain === 'true';
    }
  }
  if (Object.keys(errors).length) {
    throw new InvoiceQueryError('VALIDATION_FAILED', errors);
  }
  if (raw.cursor !== undefined) {
    query.cursor = decodeCursor(raw.cursor, query.sort);
  }
  return query;
}

function compare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function rowComparator(sort) {
  const field = sort.replace(/^-/, '');
  const direction = sort.startsWith('-') ? -1 : 1;
  return (left, right) => {
    const primary = field === 'amount'
      ? compareDecimals(left[field], right[field])
      : field === 'createdAt'
        ? compare(Date.parse(left[field]), Date.parse(right[field]))
        : compare(left[field], right[field]);
    return primary * direction || compare(left.id, right.id);
  };
}

/** Pure read of the snapshot: total precedes pagination; never sort the store. */
function queryInvoices(invoices, query) {
  const filtered = invoices.filter((row) =>
    (query.status === undefined || query.status.includes(row.status)) &&
    (query.currency === undefined || row.currency === query.currency) &&
    (query.sme === undefined || row.sme.toLowerCase().includes(query.sme.toLowerCase())) &&
    (query.minAmount === undefined || compareDecimals(row.amount, query.minAmount) >= 0) &&
    (query.maxAmount === undefined || compareDecimals(row.amount, query.maxAmount) <= 0) &&
    (query.minYieldBps === undefined || row.yieldBps >= query.minYieldBps) &&
    (query.maxYieldBps === undefined || row.yieldBps <= query.maxYieldBps) &&
    (query.dueBefore === undefined || row.dueDate <= query.dueBefore) &&
    (query.dueAfter === undefined || row.dueDate >= query.dueAfter) &&
    (query.onChain === undefined || row.onChain === query.onChain));
  const comparator = rowComparator(query.sort);
  filtered.sort(comparator);
  const field = query.sort.replace(/^-/, '');
  const remaining = query.cursor
    ? filtered.filter((row) => comparator(row, { id: query.cursor.id, [field]: query.cursor.sortValue }) > 0)
    : filtered;
  const data = remaining.slice(0, query.limit);
  let nextCursor = null;
  if (remaining.length > data.length) {
    const last = data[data.length - 1];
    let sortValue = last[field];
    if (field === 'amount') {
      const decimal = parseDecimal(sortValue);
      sortValue = decimalToString(decimal.units, decimal.scale);
    }
    nextCursor = Buffer.from(JSON.stringify({ sort: query.sort, sortValue, id: last.id })).toString('base64url');
  }
  return { data, count: data.length, total: filtered.length, nextCursor };
}

module.exports = { parseInvoiceQuery, queryInvoices, InvoiceQueryError, SORTS, PARAMETERS };
