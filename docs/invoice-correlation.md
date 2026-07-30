# Invoice Correlation Strategy

This document describes how LiquiFact correlates internal API `invoiceId` identifiers with on-chain Stellar and Soroban data.

## Overview

LiquiFact uses a unique `invoiceId` for every invoice uploaded to the platform. To ensure consistency between the off-chain database and the on-chain escrow state, a correlation strategy is required.

## Soroban (Smart Contracts)

For escrows managed by Soroban smart contracts (e.g., `LiquifactEscrow`), the `invoiceId` is treated as **contract-local state**.

- **Mechanism**: The `invoiceId` is passed as an argument (typically a `Symbol` or `String`) to contract functions such as `fund_escrow`, `get_legal_hold`, or `settle`.
- **Storage**: The contract uses the `invoiceId` as part of the storage key (e.g., `Instance` or `Persistent` storage) to track the state of a specific escrow.
- **Identifier Support**: LiquiFact supports `invoiceId` strings up to 128 characters (alphanumeric, underscores, and hyphens).

**Note**: For Soroban-only operations, there is no technical requirement to use the Stellar transaction memo field for correlation, as the contract call itself contains the identifier.

## Stellar Classic (Payments)

When using Stellar classic payments (e.g., simple `Payment` operations) alongside or instead of Soroban, the **Stellar Memo** field is used for correlation.

- **Mechanism**: The `invoiceId` is stored in the transaction's `memo` field.
- **Mapping**:
    - **MEMO_TEXT**: Limited to 28 bytes. If the `invoiceId` is 28 characters or fewer (ASCII), it can be stored directly.
    - **Internal Registry**: The `escrow_operations` table in the backend database acts as the primary mapping registry. It links the `invoice_id` (UUID) to the `stellar_transaction_hash`.
    - **MEMO_HASH**: For `invoiceId` values that cannot be stored in `MEMO_TEXT`, the backend can use a 32-byte `MEMO_HASH` derived from the `invoiceId`. The `escrow_operations` table is used to resolve this hash back to the original `invoiceId`.
- **Recommendation**: It is recommended to keep `invoiceId` short (e.g., UUIDs or short slugs) if they need to fit directly into a `MEMO_TEXT` field.

## Correlation Summary

| Feature | Soroban Strategy | Stellar Classic Strategy |
| --- | --- | --- |
| **Identifier** | Contract Argument | Transaction Memo |
| **Scope** | Contract-local | Ledger-wide (via transaction) |
| **Constraint** | 128 characters | 28 bytes (TEXT) or 32 bytes (HASH) |
| **Ambiguity** | Low (scoped to contract) | Medium (requires memo parsing) |

## Security Considerations

- **Validation**: All `invoiceId` values must be validated against the allowed pattern (`/^[a-zA-Z0-9_-]{1,128}$/`) before being passed to on-chain operations to prevent injection or malformed storage keys.
- **Privacy**: While `invoiceId` values are generally not sensitive, be aware that they are visible on-chain when used in Soroban arguments or Stellar memos. Use opaque identifiers if privacy is a concern.
## Memo Truncation Guard

Stellar classic payment memos are limited to **28 bytes**. The escrow
submission prefixes every memo with `lq:` (3 bytes), leaving 25 bytes
for the `invoiceId`.

### Policy
- `submitFundEscrow` calls `buildMemo(invoiceId)` before building the
  transaction.
- `buildMemo` measures the full memo byte-length with `Buffer.byteLength`.
- If the memo exceeds 28 bytes, it throws an `EscrowSubmitError` with a
  clear message — the transaction is never submitted with a truncated memo.
- No silent truncation is permitted; callers must ensure `invoiceId` is
  short enough to fit, or use an alternative correlation strategy.

### Why this matters
A truncated memo no longer maps back to the invoice during indexing,
breaking on-chain-to-DB correlation. Failing loudly prevents silent
data loss.
