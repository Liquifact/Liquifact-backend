# LiquiFact Ops Signing Design

This document defines the server-orchestrated signing interface for Soroban
escrow funding and document custody. The current backend implementation is a
design stub: it validates funding requests and returns a funding intent, but it
does not build, sign, or submit a live Stellar/Soroban transaction.

> **See also:** [Escrow Integration Overview](./escrow-integration-overview.md) — funding flow, signing modes, and how `escrowSubmit` fits with indexing and reconciliation.

## Goals

- Keep private signing material out of the repository, logs, request bodies, and
  API responses.
- Support delegated signing first, where the funder signs with their own
  Stellar wallet and the server only orchestrates validation and submission.
- Support a future custodial path only through explicit environment gates and a
  managed KMS/HSM signer.
- Separate escrow fund-signing keys from document custody or attestation keys.
- Preserve idempotency and auditability for funding operations.

## Runtime Modes

`ESCROW_SIGNING_MODE=delegated` is the recommended default.

| Mode | Current behavior | Future live behavior |
| --- | --- | --- |
| `delegated` | Validates the request and reports that a client signature is required unless `signedTransactionXdr` is supplied. It still does not submit. | Server builds a Soroban transaction for the LiquifactEscrow `fund_escrow` operation, returns unsigned XDR, receives signed XDR from the client, simulates and submits through Soroban RPC. |
| `custodial` | Validates the request and reports missing configuration unless every custodial env gate is present. It still does not sign or submit. | Server asks KMS/HSM to sign the transaction with an approved custodial fund key, then simulates and submits through Soroban RPC. |

## Environment Variables

These variables are intentionally configuration references, not secrets. Raw
Stellar secret keys or mnemonic material must never be stored in `.env`.

| Variable | Required for live delegated | Required for live custodial | Notes |
| --- | --- | --- | --- |
| `ESCROW_SIGNING_MODE` | Yes | Yes | `delegated` or `custodial`. Defaults to `delegated` in the stub. |
| `SOROBAN_RPC_URL` | Yes | Yes | Soroban RPC endpoint for simulation and submission. |
| `STELLAR_NETWORK_PASSPHRASE` | Yes | Yes | Network passphrase, for example testnet or public network. |
| `LIQUIFACT_ESCROW_CONTRACT_ID` | Yes | Yes | Soroban `C...` contract ID for LiquifactEscrow. |
| `ESCROW_CUSTODIAL_SIGNING_ENABLED` | No | Yes | Must be exactly `true` before custodial signing can be considered. |
| `ESCROW_CUSTODIAL_KMS_PROVIDER` | No | Yes | Provider identifier such as `aws-kms`, `gcp-kms`, `azure-key-vault`, or `hsm`. |
| `ESCROW_CUSTODIAL_KEY_ID` | No | Yes | KMS/HSM key alias or ARN for escrow funding. Do not store raw secret keys. |
| `ESCROW_DOCUMENT_CUSTODIAL_KEY_ID` | No | Optional | Separate KMS/HSM key alias or ARN for document custody and attestation. |

## Key Management Interface

Fund and document keys must be separate trust domains.

| Key class | Purpose | Allowed operations | Rotation name example |
| --- | --- | --- | --- |
| Escrow fund key | Sign Soroban funding transactions for server-custodial flows. | `signTransactionHash`, never export private key material. | `liquifact/escrow/fund/v1` |
| Document custody key | Sign document hashes, receipt attestations, or encrypted document metadata. | `signDigest`, `encrypt`, `decrypt` as approved by the document pipeline. | `liquifact/docs/custody/v1` |

Operational requirements:

- Use KMS/HSM key handles only. No Stellar secret seeds in source, `.env`, CI
  logs, test fixtures, or API payloads.
- Require dual control for custodial fund key creation, policy edits, and
  deletion scheduling.
- Allow the application role to sign only with the escrow fund key, not with the
  document custody key.
- Emit an audit event for every signing request containing request ID,
  authenticated user/client, invoice ID, public key, asset, amount,
  idempotency key, key alias, and Soroban transaction hash when available.
- Rotate keys by adding a new alias version, deploying the new key ID, waiting
  for pending requests to drain, and disabling the old key. Never overwrite
  historical audit records.
- Keep break-glass access outside the application role and require incident
  review after use.

## Funding API

Authenticated route:

```http
POST /api/escrow
Authorization: Bearer <jwt>
Idempotency-Key: fund-inv-123-0001
Content-Type: application/json
```

Delegated signing request:

```bash
curl -X POST http://localhost:3001/api/escrow \
  -H "Authorization: Bearer $JWT" \
  -H "Idempotency-Key: fund-inv-123-0001" \
  -H "Content-Type: application/json" \
  -d '{
    "invoiceId": "inv_123",
    "funderPublicKey": "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    "amount": "100.0000000",
    "asset": { "code": "XLM" },
    "signingMode": "delegated",
    "memo": "inv_123"
  }'
```

Stub response:

```json
{
  "data": {
    "status": "requires_signature",
    "submitted": false,
    "signingMode": "delegated",
    "transaction": {
      "unsignedXdr": null,
      "signedXdrAccepted": false,
      "hash": null
    },
    "controls": {
      "liveSubmissionEnabled": false
    }
  },
  "message": "Escrow funding transaction prepared; no live transaction was signed or submitted."
}
```

Custodial request shape:

```bash
curl -X POST http://localhost:3001/api/escrow \
  -H "Authorization: Bearer $JWT" \
  -H "Idempotency-Key: fund-inv-123-0002" \
  -H "Content-Type: application/json" \
  -d '{
    "invoiceId": "inv_123",
    "funderPublicKey": "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    "amount": "100.0000000",
    "asset": {
      "code": "USDC",
      "issuer": "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
    },
    "signingMode": "custodial"
  }'
```

The stub returns `requires_configuration` unless all custodial env gates are
present, and it still never signs or submits a transaction.

## Validation And Security Notes

- `invoiceId` is limited to URL-safe invoice identifiers.
- `funderPublicKey` and asset issuers must be Stellar `G...` public keys.
- `amount` must be positive and use at most seven decimal places, matching
  Stellar amount precision.
- Native XLM must not include an issuer. Issued assets require an issuer.
- `signedTransactionXdr` is accepted only as bounded base64 text and is not
  submitted by the stub.
- `Idempotency-Key` is accepted from the header or body and should be required
  by the live implementation before transaction submission.
- The authenticated caller is taken from the existing JWT middleware on
  `src/index.js`.
- Sensitive operations remain behind the existing sensitive rate limiter.

## Future Live Submission Checklist

Before replacing the stub with live submission:

1. Add Stellar SDK/Soroban transaction building with deterministic operation
   parameters for LiquifactEscrow.
2. Simulate every transaction before signing or submission.
3. Bind idempotency keys to invoice ID, amount, asset, funder, and transaction
   hash.
4. Add replay protection for already-funded invoice states.
5. Add audit logging around build, signature request, simulation, submission,
   and final ledger status.
6. Add KMS/HSM signer integration tests with a fake signer and contract tests
   for delegated signed-XDR submission.
7. Keep `liveSubmissionEnabled` false until the production signer and network
   controls are reviewed.
