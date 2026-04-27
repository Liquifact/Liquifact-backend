# Investor Commitment Indexing

## Overview

The investor commitment surface exposes per-funder lock data (`claimNotBefore`, `investorEffectiveYieldBps`) from the DB mirror. Data is currently marked as `stale: true` until on-chain indexing is implemented.

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
| `stale` | boolean | Whether data is from DB mirror |

## Current Limits

- **Indexing**: Not implemented; data is seeded in-memory for MVP
- **Stale flag**: Always `true` for DB mirror data
- **Batched reads**: Not supported; returns partial data for large result sets

## API Endpoints

### GET /api/investor/locks

Query by funder or invoice, or list all locks.

```bash
# List all
curl -H "Authorization: Bearer $TOKEN" \
  http://localhost:3001/api/investor/locks

# Filter by funder
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
  "meta": { "count": 2, "stale": true }
}
```

### GET /api/investor/locks/:invoiceId

Get lock for specific invoice and funder.

```bash
curl -H "Authorization: Bearer $TOKEN" \
  "http://localhost:3001/api/investor/locks/inv_7788?funderAddress=GDRXE2..."
```

## Security Notes

- Endpoint requires JWT authentication (`authenticateToken` middleware)
- Address validation: G/C prefix + 56 alphanumeric chars
- No secrets exposed in responses
- Rate limited via global limiter

## Future Work

1. **On-chain indexing**: Subscribe to `commit_funds` events from LiquifactEscrow
2. **Cursor-based pagination**: For large result sets
3. **Stale=false**: When data is synced from live events