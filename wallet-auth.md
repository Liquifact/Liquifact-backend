# Wallet-to-Account Binding & SME Authorization

This document describes the design for binding a Stellar wallet address to a LiquiFact user account and how this binding is used to authorize SME-specific API operations.

## Overview

LiquiFact uses a dual-authentication model for SMEs:
1.  **Standard Auth**: JWT-based session for general API access (Login/Password or SSO).
2.  **Wallet Binding**: A verified link between the user account and a Stellar public key. This is required for operations that interact with on-chain escrows or sensitive SME invoice data.

## Binding Process (SIWS)

The binding is established using **Sign-In with Stellar (SIWS)**:

1.  **Challenge**: The backend provides a randomly generated challenge (nonce) to the frontend.
2.  **Signature**: The user signs the challenge using their Stellar wallet (e.g., Freighter, Albedo).
3.  **Verification**: The backend verifies the signature against the provided public key.
4.  **Association**: Once verified, the Stellar public key is stored in the user's profile in the database.

## Authorization Middleware (`smeAuth.js`)

The `authorizeSmeWallet` middleware ensures that:
- The user is authenticated via JWT.
- The user has a bound Stellar address in a valid StrKey format.
- The wallet is resolved exclusively from the authenticated principal (`req.user.walletAddress`); values supplied via headers, bodies, or other request data are ignored and cannot override the bound address.

Accepted address formats for SME authorization are:
- `G...` Stellar account public keys
- `C...` Soroban contract addresses

The validator rejects malformed, lowercase, wrong-length, and whitespace-padded
values.

The `verifyInvoiceOwner` middleware ensures that:
- The requested invoice belongs to the authenticated user (via `ownerId`) or their bound wallet (via `smeWallet`).

## API Examples

### GET /api/sme/invoice/:id

Retrieves a specific invoice for an SME, ensuring they own it via their wallet binding.

**Request:**

```bash
curl -X GET http://localhost:3001/api/sme/invoice/inv_123 \
  -H "Authorization: Bearer <JWT_TOKEN>"
```

**Successful Response (200 OK):**

```json
{
  "data": {
    "id": "inv_123",
    "amount": 5000,
    "customer": "Acme Corp",
    "status": "pending_verification",
    "smeWallet": "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
  },
  "message": "Invoice retrieved successfully via wallet verification."
}
```

**Error: Wallet Not Bound (403 Forbidden):**

```json
{
  "error": {
    "code": "WALLET_UNBOUND",
    "message": "No Stellar wallet address is bound to this account.",
    "correlation_id": "req_..."
  }
}
```

## Security Notes

- **Input Validation**: All wallet addresses are validated as full Stellar StrKeys, accepting only valid `G...` account keys and `C...` contract addresses.
- **Principal Binding**: SME authorization trusts only the authenticated principal's bound wallet address; header or body spoofing is ignored.
- **Replay Protection**: Live SIWS implementation must use one-time nonces to prevent signature replay attacks.
- **Privacy**: Only public keys are stored; private keys never leave the user's wallet.
