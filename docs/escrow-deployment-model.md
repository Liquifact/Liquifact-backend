# Escrow Deployment Model

This document describes how the `POST /api/invest/fund-invoice` endpoint interacts with the on-chain `LiquifactEscrow` Soroban contract, and how to configure and operate each signing mode safely.

---

## Overview

When an investor funds an invoice, the backend must submit a `fund_escrow(investor, amount)` call to the correct Soroban contract on Stellar. The contract address is resolved per-invoice from an environment variable (`ESCROW_ADDR_BY_INVOICE`), and the transaction's signing strategy is governed by `ESCROW_SIGNING_MODE`.

```
Investor HTTP POST ──► invest.js route
                           │
                     validate input
                           │
                  requireKycForFunding
                           │
                   resolveEscrowAddress()
                    (escrowMap.js)
                           │
                   submitFundEscrow()
                    (escrowSubmit.js)
                           │
                  ┌────────┴────────┐
             delegated          custodial
            (return XDR)    (sign + broadcast)
                  └────────┬────────┘
                           │
                  persistCommitment()
                   (investorCommitment.js)
                           │
                     JSON response
```

---

## Signing Modes

Set `ESCROW_SIGNING_MODE` in your environment:

### `delegated` (recommended for production)

The backend builds and simulates the transaction but does **not** hold any signing key. It returns an unsigned transaction XDR (`unsignedXdr`) and a `status: "requires_signature"` response. The investor's client (e.g. Freighter browser extension, mobile wallet) signs and broadcasts the transaction independently.

**Security properties:**
- No secret key ever touches the backend server.
- The backend cannot unilaterally move funds.
- Loss of the backend does not expose user funds.

**Response shape:**
```json
{
  "commitmentId": "uuid",
  "invoiceId": "inv_001",
  "escrowAddress": "CABC...123",
  "status": "requires_signature",
  "unsignedXdr": "AAAA...base64..."
}
```

**Required env vars:**
```
ESCROW_SIGNING_MODE=delegated
SOROBAN_RPC_URL=https://soroban-testnet.stellar.org
STELLAR_NETWORK_PASSPHRASE=Test SDF Network ; September 2015
ESCROW_PLATFORM_ADDRESS=GABCDE...  # source account for fee/sequence
```

---

### `custodial`

The backend holds a platform keypair (`ESCROW_PLATFORM_SECRET`) and signs the transaction server-side before broadcasting. Status returned is `"submitted"`.

**Use cases:** automated treasury operations, B2B flows where the investor does not operate a wallet.

**Security requirements:**
- `ESCROW_PLATFORM_SECRET` **must never be committed to source control**.
- Load it from a secrets manager (AWS Secrets Manager, HashiCorp Vault, GCP Secret Manager) at runtime.
- Rotate the keypair regularly.
- The platform account should hold only the minimum XLM reserve required for fees.
- Enable multi-sig on the platform account in production (platform key + HSM key).

**Required env vars:**
```
ESCROW_SIGNING_MODE=custodial
SOROBAN_RPC_URL=https://soroban-testnet.stellar.org
STELLAR_NETWORK_PASSPHRASE=Test SDF Network ; September 2015
ESCROW_PLATFORM_ADDRESS=GABCDE...
ESCROW_PLATFORM_SECRET=S...   # NEVER commit; inject via secrets manager
```

---

### `stubbed` (default / test / staging)

No on-chain call is made. Returns `status: "stubbed"`. Used in CI, staging, and unit tests to avoid requiring a live Soroban RPC.

---

## Escrow Address Mapping

Each invoice maps to exactly one on-chain `LiquifactEscrow` contract address. The mapping is configured via:

```
ESCROW_ADDR_BY_INVOICE='{"mappings":[...],"defaultEnvironment":"production","allowlistEnabled":true}'
```

### Why environment variables instead of a database?

- Escrow contract addresses are immutable once deployed — they don't change at runtime.
- Env-based config avoids a round-trip to the DB on every request.
- Rotation is handled by updating the env var and restarting (zero-downtime with blue/green).

### Security

- `allowlistEnabled: true` (default) means requests for un-mapped invoices fail fast with a 422, preventing misrouted funds.
- Address format is validated at config-parse time: only valid Stellar G.../C... addresses are accepted.

---

## Idempotency

Every fund-invoice request is assigned an idempotency key derived from:

```
sha256(investorAddress + ":" + invoiceId + ":" + amountStroops)
```

If the same investor, invoice, and amount are submitted twice (e.g. due to a network retry), the second request returns the existing `commitment` row rather than creating a duplicate on-chain transaction. This prevents double-funding.

---

## Database Schema

```sql
CREATE TABLE investor_commitments (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id      VARCHAR(64)  NOT NULL,
  investor_address VARCHAR(60) NOT NULL,
  escrow_address  VARCHAR(60)  NOT NULL,
  amount_stroops  VARCHAR(30)  NOT NULL,
  status          VARCHAR(32)  NOT NULL,  -- requires_signature | submitted | stubbed
  unsigned_xdr    TEXT,                   -- delegated mode only
  tx_hash         VARCHAR(64),            -- custodial / submitted mode only
  ledger          VARCHAR(20),
  idempotency_key VARCHAR(64)  UNIQUE,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
```

---

## Error Responses

| Condition | HTTP | `error.code` |
|---|---|---|
| Invalid request body | 400 | `VALIDATION_ERROR` |
| Not authenticated | 401 | `AUTHENTICATION_REQUIRED` |
| KYC not approved | 403 | `FORBIDDEN` |
| No escrow mapping for invoice | 422 | `ESCROW_NOT_FOUND` |
| Soroban RPC / submission error | 502 | `ESCROW_SUBMIT_FAILED` |
| Unexpected server error | 500 | `INTERNAL_SERVER_ERROR` |

---

## Network / RPC Configuration

The Stellar network and RPC endpoint are validated at boot time in `src/config/stellar.js`. The backend will refuse to start if `STELLAR_NETWORK` and `SOROBAN_RPC_URL` are mismatched. This prevents signing transactions with a wrong network passphrase, which would cause funds to be lost.

| `STELLAR_NETWORK` | Expected `SOROBAN_RPC_URL` |
|---|---|
| `TESTNET` | `https://soroban-testnet.stellar.org` |
| `MAINNET` | `https://soroban.stellar.org` |
| `FUTURENET` | `https://rpc-futurenet.stellar.org` |

---

## Deployment Checklist

- [ ] `ESCROW_SIGNING_MODE` is explicitly set (`delegated` recommended for production)
- [ ] `ESCROW_ADDR_BY_INVOICE` is populated with correct, validated contract addresses
- [ ] `ESCROW_PLATFORM_ADDRESS` points to a funded Stellar account with sufficient XLM for fees
- [ ] If `custodial`: `ESCROW_PLATFORM_SECRET` is loaded from a secrets manager, **not** from `.env` in production
- [ ] `allowlistEnabled: true` in the escrow map config
- [ ] DB migration `20260601000001_create_investor_commitments` has been applied
- [ ] Sentry DSN is configured to catch escrow submission errors in production
- [ ] Rate limiting is applied to `/api/invest/fund-invoice` (via `src/middleware/rateLimit.js`)