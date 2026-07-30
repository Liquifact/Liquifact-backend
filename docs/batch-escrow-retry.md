# Batch escrow reader retries

The batch escrow reader classifies per-invoice failures as transient or
permanent. Transient RPC/ledger errors are retried with bounded backoff;
permanent validation failures are logged and skipped so the batch can
complete.

Operators should monitor:

- retry counters on the escrow indexer metrics
- structured logs tagged with `invoiceId` and `attempt`

Tune `ESCROW_BATCH_MAX_RETRIES` and backoff windows via environment when
on-chain load spikes.
