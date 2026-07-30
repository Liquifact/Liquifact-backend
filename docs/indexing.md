# Investor Commitment Indexing

## Overview

The investor commitment surface exposes per-funder lock data (`claimNotBefore`, `investorEffectiveYieldBps`) from durable tenant-scoped database rows. Fresh database reads return `stale: false`; rows without a refresh timestamp are surfaced as stale.

## Architecture

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│  LiquifactEscrow │────▶│  Event Listener │────▶│  DB Mirror      │
│  Soroban        │     │  (off-chain)    │     │  (investor_lock)│
└─────────────────┘     └──────────────────┘     └─────────────────┘
                                                        │
                                                        ▼
                                              ┌─────────────────┐
                                              │  Investor API   │
                                              │  /locks        │
                                              └─────────────────┘
```

## Data Model

| Field | Type | Description |
|-------|------|-------------|
| `funderAddress` | string | Stellar address (G... or C...) |
| `invoiceId` | string | Associated invoice |
| `claimNotBefore` | string | ISO timestamp when claims become valid |
| `investorEffectiveYieldBps` | number | Effective yield in basis points |
| `stale` | boolean | Whether the row lacks a refresh timestamp |

## Current Limits

- **Indexing**: Lock ingestion remains external to this route; the API reads the durable `investor_locks` mirror
- **Stale flag**: Derived from each row's refresh timestamp
- **Batched reads**: Not supported; returns partial data for large result sets

## API Endpoints

### GET /api/investor/locks

Query by funder or invoice. Non-admin callers are scoped to the funder address bound to their authenticated principal. Admin and owner callers may list all tenant locks.

```bash
# List your bound funder locks as a non-admin, or all tenant locks as an admin
curl -H "Authorization: Bearer $TOKEN" \
  http://localhost:3001/api/investor/locks

# Filter by funder. Non-admin callers must request their own bound funder.
curl -H "Authorization: Bearer $TOKEN" \
  "http://localhost:3001/api/investor/locks?funderAddress=GDRXE2..."

# Filter by invoice
curl -H "Authorization: Bearer $TOKEN" \
  "http://localhost:3001/api/investor/locks?invoiceId=inv_7788"
```

Response:
```json
{
  "data": [...],
  "meta": { "count": 2, "stale": false }
}
```

### GET /api/investor/locks/:invoiceId

Get lock for specific invoice and funder.

```bash
curl -H "Authorization: Bearer $TOKEN" \
  "http://localhost:3001/api/investor/locks/inv_7788?funderAddress=GDRXE2..."
```

## Security Notes

- Non-admin callers cannot use an omitted `funderAddress` to list other funders' locks.
- Non-admin callers receive `403` when the requested funder does not match their bound funder address.
- Investor-lock cache keys include tenant and principal scope, so a cached admin response cannot be replayed to a scoped investor.

- Endpoint requires JWT authentication (`authenticateToken` middleware)
- Address validation: G/C prefix + 56 alphanumeric chars
- No secrets exposed in responses
- Rate limited via global limiter

## Future Work

1. **On-chain indexing**: Subscribe to `commit_funds` events from LiquifactEscrow
2. **Cursor-based pagination**: For large result sets
3. **Event freshness metadata**: Attach source ledger/event cursors when live event ingestion is available
