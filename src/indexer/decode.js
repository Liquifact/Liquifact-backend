'use strict';

/**
 * @fileoverview Soroban contract event decoder for the LiquifactEscrow contract.
 *
 * Maps event name topic symbols to typed records. Topic layout per the contract
 * event schema: [struct_name_symbol, name_symbol, ...#[topic] fields, "v1"].
 * Data is a map keyed by field name (ScVal map).
 *
 * @module indexer/decode
 */

/**
 * Known event name → canonical type string.
 * Symbol names come from the contract's event schema (docs/EVENT_SCHEMA.md).
 *
 * @type {Record<string, string>}
 */
const EVENT_TYPE_MAP = {
  funded: 'funded',
  escrow_sd: 'settled',
  inv_claim: 'investor_payout_claimed',
  refunded: 'refunded',
  fund_can: 'funding_cancelled',
  legalhld: 'legal_hold',
  sme_wd: 'sme_withdrawal',
  maturity: 'maturity',
  fund_tgt: 'funding_target_reached',
};

/**
 * Extract a string value from an ScVal-like object.
 * Handles both raw JS strings and stellar-sdk ScVal wrappers.
 *
 * @param {unknown} scVal - Value to extract from.
 * @returns {string | undefined}
 */
function scValToString(scVal) {
  if (scVal === null || scVal === undefined) {
    return undefined;
  }
  if (typeof scVal === 'string') {
    return scVal;
  }
  // stellar-sdk ScVal: { switch: { name: 'scvSymbol' }, value: Buffer|string }
  if (typeof scVal === 'object') {
    if (typeof scVal.value === 'string') {
      return scVal.value;
    }
    if (Buffer.isBuffer(scVal.value)) {
      return scVal.value.toString('utf8');
    }
    // xdr ScVal stringified
    if (typeof scVal._arm === 'string' && scVal._value !== undefined) {
      const v = scVal._value;
      if (typeof v === 'string') {return v;}
      if (Buffer.isBuffer(v)) {return v.toString('utf8');}
    }
  }
  return String(scVal);
}

/**
 * Extract a BigInt-safe numeric value from an ScVal (i128, u64, etc.).
 * Returns a string to preserve precision.
 *
 * @param {unknown} scVal - Value to extract.
 * @returns {string}
 */
function scValToAmountString(scVal) {
  if (scVal === null || scVal === undefined) {
    return '0';
  }
  if (typeof scVal === 'bigint') {
    return scVal.toString();
  }
  if (typeof scVal === 'number') {
    return String(scVal);
  }
  if (typeof scVal === 'string') {
    return scVal;
  }
  // stellar-sdk i128 ScVal: { hi: BigInt, lo: BigInt }
  if (typeof scVal === 'object') {
    if (scVal.hi !== undefined && scVal.lo !== undefined) {
      // Reconstruct i128: hi * 2^64 + lo (both are signed 64-bit)
      const hi = BigInt(scVal.hi);
      const lo = BigInt(scVal.lo);
      const val = (hi << 64n) | (lo & 0xffffffffffffffffn);
      return val.toString();
    }
    if (typeof scVal.value === 'bigint') {
      return scVal.value.toString();
    }
    if (typeof scVal.value === 'number') {
      return String(scVal.value);
    }
    if (typeof scVal.value === 'string') {
      return scVal.value;
    }
  }
  return String(scVal);
}

/**
 * Extract all fields from an ScVal map into a plain JS object.
 * All numeric/bigint values are converted to strings for JSON safety.
 *
 * @param {unknown} scvMap - ScVal map (array of {key, val} or Map).
 * @returns {Record<string, unknown>}
 */
function scvMapToObject(scvMap) {
  if (!scvMap) {return {};}

  // stellar-sdk returns maps as arrays of { key: ScVal, val: ScVal }
  if (Array.isArray(scvMap)) {
    const result = {};
    for (const entry of scvMap) {
      const k = scValToString(entry.key ?? entry.k);
      if (k === undefined) {continue;}
      const v = entry.val ?? entry.v;
      result[k] = coerceVal(v);
    }
    return result;
  }

  // Native JS Map
  if (scvMap instanceof Map) {
    const result = {};
    for (const [k, v] of scvMap.entries()) {
      result[String(k)] = coerceVal(v);
    }
    return result;
  }

  // Plain object (already decoded)
  if (typeof scvMap === 'object') {
    const result = {};
    for (const [k, v] of Object.entries(scvMap)) {
      result[k] = coerceVal(v);
    }
    return result;
  }

  return {};
}

/**
 * Coerce an ScVal to a JS-safe primitive.
 *
 * @param {unknown} v - Value to coerce.
 * @returns {unknown}
 */
function coerceVal(v) {
  if (v === null || v === undefined) {return null;}
  if (typeof v === 'bigint') {return v.toString();}
  if (typeof v === 'boolean') {return v;}
  if (typeof v === 'number') {return v;}
  if (typeof v === 'string') {return v;}
  if (typeof v === 'object') {
    // i128 hi/lo pair
    if (v.hi !== undefined && v.lo !== undefined) {
      return scValToAmountString(v);
    }
    // Nested map
    if (Array.isArray(v)) {
      return scvMapToObject(v);
    }
    // ScVal with .value
    if (v.value !== undefined) {
      return coerceVal(v.value);
    }
  }
  return String(v);
}

/**
 * Decode a raw Soroban RPC event into a typed record.
 *
 * Raw event shape from rpc.Server#getEvents:
 * ```
 * {
 *   id: string,           // "<ledger>-<index>"
 *   type: "contract",
 *   ledger: number,
 *   ledgerClosedAt: string,  // ISO date-time
 *   contractId: string,
 *   txHash: string,
 *   topic: ScVal[],        // [struct_name, name, ...topic_fields, "v1"]
 *   value: ScVal,          // map of data fields
 * }
 * ```
 *
 * @param {object} rawEvent - Raw event from Soroban RPC getEvents.
 * @returns {{
 *   id: string,
 *   type: string,
 *   ledger: number,
 *   ledgerClosedAt: string,
 *   txHash: string,
 *   contractId: string,
 *   invoiceId: string | null,
 *   data: Record<string, unknown>,
 *   schemaWarning?: true,
 * }}
 */
function decodeEvent(rawEvent) {
  const topics = Array.isArray(rawEvent.topic)
    ? rawEvent.topic
    : Array.isArray(rawEvent.topics)
      ? rawEvent.topics
      : [];

  // Topics: [struct_name, event_name, ...#[topic] fields, version]
  const nameTopic = topics[1];
  const versionTopic = topics[topics.length - 1];

  const nameStr = scValToString(nameTopic);
  const versionStr = scValToString(versionTopic);

  const schemaWarning = versionStr !== 'v1' ? true : undefined;

  // Decode data map
  const dataMap = rawEvent.value;
  const data = scvMapToObject(dataMap);

  // Derive invoiceId from data fields or topics
  let invoiceId =
    (typeof data.invoice_id === 'string' && data.invoice_id) ||
    (typeof data.invoiceId === 'string' && data.invoiceId) ||
    null;

  if (!invoiceId) {
    // Check topic fields (index 2 onward, excluding last version topic)
    for (let i = 2; i < topics.length - 1; i++) {
      const ts = scValToString(topics[i]);
      if (ts && /^[a-zA-Z0-9_-]{1,128}$/.test(ts) && !/^[CV][A-Z2-7]{55}$/.test(ts)) {
        invoiceId = ts;
        break;
      }
    }
  }

  // Resolve event type
  const canonicalType = nameStr ? (EVENT_TYPE_MAP[nameStr] ?? null) : null;
  const type = canonicalType !== null ? canonicalType : 'unknown';

  const decoded = {
    id: String(rawEvent.id ?? ''),
    type,
    ledger: Number(rawEvent.ledger ?? 0),
    ledgerClosedAt: String(rawEvent.ledgerClosedAt ?? ''),
    txHash: String(rawEvent.txHash ?? ''),
    contractId: String(rawEvent.contractId ?? ''),
    invoiceId,
    data,
  };

  // Preserve raw topics for unknown events
  if (type === 'unknown') {
    decoded.rawTopics = topics.map(scValToString);
  }

  if (schemaWarning) {
    decoded.schemaWarning = true;
  }

  return decoded;
}

module.exports = {
  decodeEvent,
  EVENT_TYPE_MAP,
  scValToString,
  scValToAmountString,
  scvMapToObject,
};
