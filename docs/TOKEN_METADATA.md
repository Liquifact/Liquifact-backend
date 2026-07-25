# Token Metadata Service

## Overview

The token metadata service (`src/services/tokenMeta.js`) fetches and caches Stellar token details (symbol, name, decimals) from Horizon or Soroban RPC. It implements TTL-based caching with invalidation strategies to balance freshness with performance.

## IMPORTANT: Cached Decimals Warning

**NEVER use cached decimals for on-chain principal computations.** Always fetch fresh decimals from the chain for financial calculations. Cached metadata is for display/UI purposes only.

The cached `decimals` field should only be used for:
- Displaying token amounts in the UI
- Formatting numbers for human readability
- Showing token information in lists/cards

For any financial calculations (e.g., computing principal, interest, fees), always:
1. Fetch fresh token metadata from the chain
2. Use the on-chain decimals value
3. Do not rely on cached values

## Stampede Protection

The token metadata service implements **single-flight** cache stampede protection. If multiple concurrent requests arrive for the exact same token before it has been cached (e.g., during a large batch render of marketplace items), they will all share a single in-flight RPC promise. This avoids flooding Horizon or Soroban RPC with duplicate calls.

The batched resolver, `resolveMany`, extends that protection by deduplicating identical inputs by cache key and using a bounded worker pool (default concurrency: 5) so large batches do not fan out unbounded RPC traffic.

## TTL Strategy

### Default TTL

The default TTL for token metadata is **30 minutes** (`DEFAULT_CACHE_TTL_MS = 30 * 60 * 1000`).

This balances:
- **Freshness**: Token metadata (name, symbol, decimals) rarely changes
- **Performance**: Avoids repeated RPC/Horizon calls for the same token
- **Cost**: Reduces API call volume to external services

### Custom TTL

You can override the default TTL per request:

```javascript
const metadata = await getTokenMetadata(asset, { ttlMs: 60000 }); // 1 minute
```

### TTL Configuration

Environment variables (future enhancement):
```bash
TOKEN_META_CACHE_TTL_MS=1800000  # 30 minutes default
```

## Invalidation Strategy

### Automatic Invalidation

The cache uses **lazy expiration**:
- Entries are checked for expiration on each `get` operation
- Expired entries are evicted when accessed
- No background cleanup process

### Manual Invalidation

Use `invalidateTokenMetadata()` when you know metadata has changed:

```javascript
const { invalidateTokenMetadata } = require('./services/tokenMeta');

// Invalidate specific token
invalidateTokenMetadata({ code: 'USDC', issuer: 'GABC...' });
```

Use cases for manual invalidation:
- Admin updates token metadata via management interface
- Contract upgrade changes token decimals
- Token name/symbol change (rare but possible)
- Testing cache behavior

### Cache Clearing

Use `clearTokenCache()` to clear all cached metadata:

```javascript
const { clearTokenCache } = require('./services/tokenMeta');

clearTokenCache(); // Clears all entries
```

**Warning**: This forces all subsequent requests to fetch fresh metadata from RPC/Horizon. Use with caution in production.

### Cache Statistics

Monitor cache usage with `getCacheStats()`:

```javascript
const stats = getCacheStats();
console.log(stats);
// { size: 42, maxSize: 10000, defaultTtlMs: 1800000 }
```

## Cache Key Generation

Cache keys are generated based on asset type:

| Asset Type | Cache Key Format | Example |
|------------|------------------|---------|
| Native XLM | `native` | `native` |
| Issued Asset | `code:issuer` | `USDC:GABC123...` |
| Soroban Token | `contract:contractId` | `contract:CDEF456...` |

This ensures:
- Unique keys for different tokens
- Same token always maps to same key
- No collisions between asset types

## API Reference

### `getTokenMetadata(asset, options)`

Fetches token metadata with caching.

#### Parameters

```javascript
{
  code: string,           // Asset code (or 'native' for XLM)
  issuer: string | null, // Asset issuer (null for native/Soroban)
  contractId: string      // Soroban contract ID (for SEP-41 tokens)
}
```

#### Options

```javascript
{
  ttlMs: number,      // Cache TTL in milliseconds (default: 30min)
  skipCache: boolean  // Skip cache and force fresh fetch (default: false)
}
```

#### Returns

```javascript
{
  symbol: string,     // Token symbol (e.g., 'USDC', 'XLM')
  name: string,       // Token name (e.g., 'USD Coin', 'Lumen')
  decimals: number,   // Number of decimal places (for display only!)
  source: string,     // Source of metadata ('native', 'horizon', 'soroban')
  cachedAt: number    // Timestamp when metadata was cached
}
```

#### Example

```javascript
const metadata = await getTokenMetadata({
  code: 'USDC',
  issuer: 'GABC123...'
});

console.log(metadata);
// {
//   symbol: 'USDC',
//   name: 'USD Coin',
//   decimals: 7,
//   source: 'horizon',
//   cachedAt: 1714123456789
// }
```

### `getFreshTokenMetadata(asset)`

Bypasses cache and fetches fresh metadata.

#### Example

```javascript
const freshMetadata = await getFreshTokenMetadata({
  code: 'USDC',
  issuer: 'GABC123...'
});
// Always fetches from RPC/Horizon, updates cache
```

### `batchGetTokenMetadata(assets, options)`

Fetches metadata for multiple assets concurrently without single-flight protection for the entire batch. (Consider using `resolveMany` instead).

#### Example

```javascript
const assets = [
  { code: 'native' },
  { code: 'USDC', issuer: 'GABC...' },
  { code: 'TOKEN', contractId: 'CDEF...' }
];

const results = await batchGetTokenMetadata(assets);
// Array of metadata in same order as input
```

### `resolveMany(assets, options)`

Resolves token metadata for multiple assets with deduplication, single-flight protection, and bounded concurrency.

#### Example

```javascript
const assets = [
  { code: 'native' },
  { code: 'USDC', issuer: 'GABC...' },
  { code: 'USDC', issuer: 'GABC...' }, // Duplicate
];

// Deduplicates inputs and limits RPC fan-out to `concurrency` (default: 5)
const results = await resolveMany(assets, { concurrency: 5 });
```

### `invalidateTokenMetadata(asset)`

Invalidates cached metadata for a specific asset.

#### Example

```javascript
invalidateTokenMetadata({ code: 'USDC', issuer: 'GABC...' });
// Returns true if entry existed and was invalidated
```

### `clearTokenCache()`

Clears all token metadata from cache.

#### Example

```javascript
clearTokenCache();
// Use with caution - forces all subsequent requests to fetch fresh
```

### `getCacheStats()`

Returns cache statistics for monitoring.

#### Example

```javascript
const stats = getCacheStats();
// { size: 42, maxSize: 10000, defaultTtlMs: 1800000 }
```

## Integration with Escrow Read

The token metadata service is integrated into `src/services/escrowRead.js`. When fetching escrow state, you can include funding asset metadata:

```javascript
const { readEscrowState } = require('./services/escrowRead');

const escrowState = await readEscrowState('inv_123', {
  fundingAsset: {
    code: 'USDC',
    issuer: 'GABC123...'
  }
});

console.log(escrowState.funding_token);
// {
//   symbol: 'USDC',
//   name: 'USD Coin',
//   decimals: 7,
//   source: 'horizon',
//   cachedAt: 1714123456789
// }
```

### Error Handling

If token metadata fetch fails, the escrow read continues without it:
- `funding_token` will be `null`
- Error is logged for monitoring
- Other escrow fields are still returned

This ensures token metadata failures don't break escrow reads.

## Security Notes

### Input Validation

All asset descriptors are validated before fetching:
- Asset code: 1-12 alphanumeric characters, uppercase
- Issuer: Valid Stellar public key (G...) format
- Contract ID: Valid Soroban contract ID (C...) format
- Native XLM: Must not have issuer

### No Secrets in Cache

The cache stores only public metadata:
- Symbol (e.g., 'USDC')
- Name (e.g., 'USD Coin')
- Decimals (e.g., 7)
- Source (e.g., 'horizon')

No private keys, secrets, or sensitive data are cached.

### Cache Size Limits

Maximum cache size: **10,000 entries** (`MAX_CACHE_SIZE`).

This prevents memory exhaustion attacks. When the limit is reached, entries are evicted using FIFO policy.

### Rate Limiting

Token metadata fetches are subject to the same rate limiting as other API endpoints:
- Global rate limit (configured via `RATE_LIMIT_*` env vars)
- Sensitive endpoint rate limit for escrow operations

### Audit Logging

Token metadata fetches are logged via the audit middleware for monitoring and debugging.

## Testing

### Unit Tests

Run the token metadata tests:

```bash
npm test -- tests/escrow.tokenMeta.test.js
```

### Test Coverage

The test suite covers:
- Asset validation (native, issued, Soroban)
- Cache key generation
- Caching behavior (hit, miss, expiration)
- Manual invalidation
- Batch fetching
- Integration with escrow read
- Error handling
- Edge cases

Target coverage: **95%+** on new code.

### Mocking

The tests mock the cache store and Soroban RPC calls to avoid external dependencies during testing. Mocks are configured in `jest.mock()`.

## Environment Configuration

No additional environment variables are required for the token metadata service. It uses:

- Existing `SOROBAN_RPC_URL` for Soroban token fetches
- Horizon URL (to be configured via env var in future)

Future configuration options:
```bash
TOKEN_META_CACHE_TTL_MS=1800000      # 30 minutes
TOKEN_META_MAX_CACHE_SIZE=10000      # Maximum cache entries
HORIZON_URL=https://horizon.stellar.org  # Horizon endpoint
```

## Troubleshooting

### Metadata Not Appearing in Escrow DTO

**Issue**: `funding_token` is `null` in escrow state.

**Solutions**:
1. Ensure `fundingAsset` is passed to `readEscrowState()`
2. Check asset descriptor is valid (code, issuer/contractId)
3. Check logs for token metadata fetch errors
4. Verify RPC/Horizon endpoints are accessible

### Cache Not Working

**Issue**: Metadata is fetched on every request despite caching.

**Solutions**:
1. Check cache key generation is consistent
2. Verify TTL hasn't expired (default 30 minutes)
3. Check `skipCache` is not set to `true`
4. Use `getCacheStats()` to verify cache size

### Stale Metadata

**Issue**: Cached metadata is outdated (e.g., after token upgrade).

**Solutions**:
1. Use `invalidateTokenMetadata()` for specific token
2. Use `getFreshTokenMetadata()` to force fresh fetch
3. Reduce TTL for frequently changing tokens
4. Use `clearTokenCache()` to clear all (use with caution)

### Validation Errors

**Issue**: `INVALID_ASSET` error when fetching metadata.

**Solutions**:
1. Check asset code is 1-12 uppercase alphanumeric characters
2. Verify issuer is valid Stellar G... public key
3. Check contract ID is valid Soroban C... contract ID
4. Ensure native XLM doesn't have issuer

## Future Enhancements

1. **Redis cache**: Replace in-memory cache with Redis for distributed deployments
2. **Horizon integration**: Implement actual Horizon API calls for issued assets
3. **Soroban SDK integration**: Replace mock with real Soroban SDK calls
4. **Metadata persistence**: Store metadata in database for long-term caching
5. **Cache warming**: Pre-populate cache with commonly used tokens
6. **Cache metrics**: Track cache hit rates, miss rates, and error frequencies
7. **Webhook invalidation**: Invalidate cache on token metadata change events

## References

- [Stellar SEP-41 Token Standard](https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0041.md)
- [Stellar Horizon API](https://developers.stellar.org/api/resources/assets/)
- [Soroban Documentation](https://developers.stellar.org/docs/build/smart-contracts/)
- [LiquiFact Escrow Contract](./LIQUIFACT_ESCROW.md)
