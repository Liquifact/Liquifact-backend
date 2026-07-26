# Soroban Transaction Simulation

## Overview

The `simulateOrThrow` utility module (`src/services/sorobanSim.js`) provides transaction simulation capabilities for Soroban operations before submission. This prevents failed transactions from being submitted to the network, saving gas and improving user experience.

## Features

- **Pre-submission validation**: Simulates transactions before actual submission
- **Footprint caching**: Stores simulation footprints to avoid redundant simulations
- **Bounded cache policy**: Applies a TTL and a size cap with LRU eviction to prevent unbounded growth
- **Stale-state invalidation**: Rejects cached footprints when the ledger or contract version changes
- **Error classification**: Categorizes simulation errors (insufficient resources, auth, contract, network, validation)
- **Retry guidance**: Provides retry hints based on error type
- **Configurable caching**: Optional cache usage with TTL-based expiration and explicit invalidation hooks

## API Reference

### `simulateOrThrow(params)`

Simulates a Soroban transaction and returns a result object (does not throw).

#### Parameters

```javascript
{
  operation: string,           // Operation type (e.g., 'fund_escrow')
  invoiceId: string,          // Invoice identifier
  funderPublicKey: string,    // Stellar public key (G...)
  transactionXdr: string,     // Transaction XDR (base64 encoded)
  options: {
    useCache: boolean,        // Whether to use footprint cache (default: true)
    currentLedger: number|null, // Latest known ledger sequence for stale-entry invalidation
    contractVersion: string|null, // Current contract version for stale-entry invalidation
    rpcConfig: object         // RPC configuration overrides
  }
}
```

#### Returns

```javascript
{
  status: 'success' | 'failure',
  footprint: object | null,   // Soroban footprint (read/write addresses)
  resourceConfig: object,     // Resource fee configuration
  cached: boolean,            // Whether result came from cache
  errorType: string | null,   // Error type from SIMULATION_ERROR_TYPES
  error: AppError | null      // Structured error (if failed)
}
```

#### Example

```javascript
const { simulateOrThrow, SIMULATION_STATUS } = require('./services/sorobanSim');

const result = await simulateOrThrow({
  operation: 'fund_escrow',
  invoiceId: 'inv_123',
  funderPublicKey: 'GABC123...',
  transactionXdr: 'AAAA...',
  options: {
    useCache: true,
  }
});

if (result.status === SIMULATION_STATUS.SUCCESS) {
  console.log('Simulation successful, footprint:', result.footprint);
  // Proceed with actual submission using result.footprint
} else {
  console.error('Simulation failed:', result.error.detail);
  // Handle error based on result.error.retryable
}
```

### `simulateOrThrowSync(params)`

Convenience wrapper that throws errors immediately instead of returning them in the result object.

#### Parameters

Same as `simulateOrThrow`.

#### Returns

```javascript
{
  status: 'success',
  footprint: object,
  resourceConfig: object,
  cached: boolean,
  errorType: null
}
```

#### Throws

`AppError` if simulation fails or parameters are invalid.

#### Example

```javascript
const { simulateOrThrowSync } = require('./services/sorobanSim');

try {
  const result = await simulateOrThrowSync({
    operation: 'fund_escrow',
    invoiceId: 'inv_123',
    funderPublicKey: 'GABC123...',
    transactionXdr: 'AAAA...',
  });
  
  // Use result.footprint for actual submission
  console.log('Footprint:', result.footprint);
} catch (error) {
  if (error.retryable) {
    console.log('Transient error, retry:', error.retryHint);
  } else {
    console.error('Non-retryable error:', error.detail);
  }
}
```

## Error Types

### `SIMULATION_ERROR_TYPES`

- `INSUFFICIENT_RESOURCES`: Account lacks resources for operation (non-retryable)
- `INVALID_AUTH`: Signature or permission errors (non-retryable)
- `CONTRACT_ERROR`: Contract invocation failures (non-retryable)
- `NETWORK_ERROR`: Transient network/RPC errors (retryable)
- `VALIDATION_ERROR`: Invalid transaction format or parameters (non-retryable)

## Cache Management

### Footprint Cache

The utility uses an in-memory, bounded cache (can be replaced with Redis in production) to store simulation footprints. Cache keys are generated from operation, invoiceId, and funderPublicKey and remain server-controlled, preventing cache-key injection.

- **TTL**: 5 minutes (configurable via `CACHE_TTL_MS`)
- **Max size**: 1000 entries by default (configurable via `MAX_CACHE_SIZE`)
- **Eviction policy**: LRU when the size cap is reached
- **Invalidation**: Cached entries are rejected when they are older than the TTL, when the ledger moved forward, or when the contract version changed
- **Metrics**: Cache hits, misses, and evictions are exported through the Prometheus counters in `src/metrics.js`

### Cache Functions

```javascript
const {
  clearFootprintCache,
  getCachedFootprint,
  cacheFootprint,
  generateCacheKey
} = require('./services/sorobanSim');

// Clear all cached footprints
clearFootprintCache();

// Manually cache a footprint
const key = generateCacheKey('fund_escrow', 'inv_123', 'GABC...');
cacheFootprint(key, { read: ['addr1'], write: ['addr2'] });

// Retrieve a cached footprint
const cached = getCachedFootprint(key);
```

## Integration with Submit Paths

The simulation utility is integrated into `src/services/escrowSubmit.js`. When a signed transaction XDR is provided and the network is configured, the transaction is simulated before submission.

### Example Integration

```javascript
const { simulateOrThrowSync } = require('./sorobanSim');

async function submitEscrowFunding(payload, options) {
  const request = validateFundingRequest(payload, options);
  const config = resolveSigningConfig(options.env, request.signingMode);
  
  // Simulate if we have signed XDR and network is ready
  let simulationResult = null;
  if (request.signedTransactionXdr && config.network.ready) {
    try {
      const sim = await simulateOrThrowSync({
        operation: 'fund_escrow',
        invoiceId: request.invoiceId,
        funderPublicKey: request.funderPublicKey,
        transactionXdr: request.signedTransactionXdr,
      });
      simulationResult = {
        simulated: true,
        simulationStatus: sim.status,
        footprint: sim.footprint,
        resourceConfig: sim.resourceConfig,
        cached: sim.cached,
      };
    } catch (error) {
      simulationResult = {
        simulated: true,
        simulationStatus: 'failure',
        error,
      };
    }
  }
  
  return {
    status: outcome.status,
    simulation: simulationResult || { simulated: false },
    // ... other fields
  };
}
```

## API Examples

### cURL Examples

#### Successful Simulation

```bash
curl -X POST http://localhost:3001/api/escrow \
  -H "Authorization: Bearer <JWT_TOKEN>" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: fund-inv-123" \
  -d '{
    "invoiceId": "inv_123",
    "funderPublicKey": "GABC123...",
    "amount": "100.0000000",
    "asset": { "code": "XLM" },
    "signedTransactionXdr": "AAAA..."
  }'
```

**Response (202 Accepted)**

```json
{
  "message": "Escrow funding transaction prepared; no live transaction was signed or submitted.",
  "data": {
    "status": "stubbed",
    "submitted": false,
    "signingMode": "delegated",
    "simulation": {
      "simulated": true,
      "simulationStatus": "success",
      "footprint": {
        "read": ["addr1", "addr2"],
        "write": ["addr3"]
      },
      "resourceConfig": {
        "instructionFee": 100,
        "resourceFee": 1000
      },
      "cached": false
    },
    "intent": {
      "operation": "fund_escrow",
      "invoiceId": "inv_123",
      "funderPublicKey": "GABC123...",
      "amount": "100.0000000",
      "asset": { "code": "XLM", "issuer": null, "type": "native" }
    }
  }
}
```

#### Simulation Failure (Insufficient Resources)

```json
{
  "error": {
    "type": "https://liquifact.com/probs/soroban-simulation-failed",
    "title": "Soroban Transaction Simulation Failed",
    "status": 400,
    "detail": "Insufficient resources for operation",
    "code": "SIMULATION_INSUFFICIENT_RESOURCES",
    "retryable": false,
    "retry_hint": "Fix the transaction payload or account state before retrying.",
    "context": {
      "errorType": "insufficient_resources",
      "operation": "fund_escrow",
      "invoiceId": "inv_123",
      "funderPublicKey": "GABC123..."
    }
  }
}
```

#### Simulation Failure (Network Error - Retryable)

```json
{
  "error": {
    "type": "https://liquifact.com/probs/soroban-simulation-failed",
    "title": "Soroban Transaction Simulation Failed",
    "status": 503,
    "detail": "Network timeout during RPC call",
    "code": "SIMULATION_NETWORK_ERROR",
    "retryable": true,
    "retry_hint": "Transient network error during simulation. Retry the request."
  }
}
```

## Security Notes

### Input Validation

1. **Parameter validation**: All simulation parameters are validated before simulation:
   - `operation`: Required, must be a non-empty string
   - `invoiceId`: Required, must be a non-empty string
   - `funderPublicKey`: Required, must be a non-empty string
   - `transactionXdr`: Required, must be present

2. **XDR validation**: Transaction XDR is validated to ensure it meets minimum length requirements (prevents empty or malformed XDR).

3. **Type checking**: The `optionalString` utility rejects object values to prevent `[object Object]` stringification issues.

### Secret Management

1. **No secrets in code**: The simulation utility does not store or log private keys, secrets, or sensitive material.

2. **Environment variables**: All configuration comes from environment variables (see `.env.example`):
   - `SOROBAN_RPC_URL`: Soroban RPC endpoint
   - `STELLAR_NETWORK_PASSPHRASE`: Network passphrase
   - `LIQUIFACT_ESCROW_CONTRACT_ID`: Escrow contract ID

3. **KMS integration**: For custodial signing, key material is managed via KMS (AWS KMS, etc.) and never stored in the application.

### Cache Security

1. **No sensitive data in cache**: The cache stores only footprints (read/write addresses) and resource configurations, not transaction data or secrets.

2. **Cache eviction**: Automatic FIFO eviction prevents memory exhaustion attacks.

3. **TTL-based expiration**: Cached entries expire after 5 minutes to prevent stale data.

### Error Handling

1. **Structured errors**: All errors use the `AppError` class with RFC 7807 Problem Details format.

2. **No stack traces in production**: Error responses do not include stack traces or internal implementation details.

3. **Retry guidance**: Errors include `retryable` flag and `retryHint` to guide client behavior without exposing internal state.

### Rate Limiting

1. **Global rate limiting**: Apply to all endpoints including simulation endpoints (configured via `RATE_LIMIT_*` env vars).

2. **Sensitive endpoint rate limiting**: Escrow operations have stricter rate limits (configured via `RATE_LIMIT_SENSITIVE_*` env vars).

### Audit Logging

1. **Simulation attempts**: All simulation attempts are logged via the audit middleware.

2. **Failure tracking**: Simulation failures are logged with error type and context for monitoring.

## Testing

### Unit Tests

Run the simulation utility tests:

```bash
npm test -- tests/soroban.sim.test.js
```

### Test Coverage

The test suite covers:
- Successful simulations with caching
- All error types (insufficient resources, auth, contract, network, validation)
- Cache operations (get, set, clear, expiration, eviction)
- Parameter validation
- Edge cases (null errors, case-insensitive matching, concurrent simulations)

Target coverage: **95%+** on new code.

### Mocking

The tests mock the `callSorobanContract` function to avoid actual RPC calls during testing. Mocks are configured in `jest.mock()`.

## Environment Configuration

Add the following to your `.env` file (see `.env.example`):

```bash
# Soroban RPC Configuration
SOROBAN_RPC_URL=https://soroban-testnet.stellar.org
STELLAR_NETWORK_PASSPHRASE="Test SDF Network ; September 2015"
LIQUIFACT_ESCROW_CONTRACT_ID=C...

# Retry Configuration (optional)
SOROBAN_MAX_RETRIES=3
SOROBAN_BASE_DELAY=200
SOROBAN_MAX_DELAY=5000
```

## Future Enhancements

1. **Redis cache**: Replace in-memory cache with Redis for distributed deployments.

2. **Actual Soroban SDK integration**: Replace mock simulation with real Soroban SDK `simulateTransaction` call.

3. **Footprint persistence**: Store footprints in database for long-term reuse.

4. **Simulation metrics**: Track simulation success rates, cache hit rates, and error frequencies.

5. **Batch simulation**: Support simulating multiple transactions in a single call.

## Troubleshooting

### Simulation Fails with "Network Error"

- Check `SOROBAN_RPC_URL` is accessible
- Verify network connectivity
- Check RPC service status
- Retry the request (error is marked as retryable)

### Simulation Fails with "Insufficient Resources"

- Check funder account balance
- Verify resource fees are sufficient
- Transaction cannot be retried without fixing account state

### Cache Not Working

- Check `useCache` option is not set to `false`
- Verify cache key generation is consistent
- Check cache TTL (5 minutes default)
- Use `clearFootprintCache()` to reset cache if needed

### Validation Errors

- Ensure all required parameters are provided
- Check `transactionXdr` is valid base64
- Verify `funderPublicKey` is a valid Stellar G... public key
- Check `invoiceId` matches expected format

## References

- [Soroban Documentation](https://developers.stellar.org/docs/build/smart-contracts/)
- [RFC 7807 Problem Details](https://datatracker.ietf.org/doc/html/rfc7807)
- [LiquiFact Escrow Contract](./LIQUIFACT_ESCROW.md)
