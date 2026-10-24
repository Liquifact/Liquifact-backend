# Bounty contract compatibility

`contracts/src/lib.rs` implements the existing `BountyContract` scaffold. Its
interface is separate from the intended invoice-based `LiquifactEscrow` described
in [the escrow integration overview](escrow-integration-overview.md). This fix
does not require backend callers or stored bounties to migrate.

## Preserved interface

| Method | Arguments | Result |
| --- | --- | --- |
| `initialize` | `fee_recipient: Address` | `()` |
| `create_bounty` | `creator: Address`, `hunter: Address`, `token: Address`, `amount: i128`, `protocol_fee_bps: u32` | `u64` bounty ID |
| `release_bounty` | `id: u64` | `()` |
| `get_bounty` | `id: u64` | `Bounty` |

The existing `FeeRecipient`, `NextId`, and `Bounty(u64)` storage keys, storage
classes, and all `Bounty` fields retain their serialized representation.
Creation emits topics `(bounty_created, id)` with amount as data. Release emits
topics `(bounty_released, id)` with `(payout, fee)` as data.

## Validation and state transitions

- Creation and release require the bounty creator's authorization. Initialization
  retains the existing one-time public interface: deployment must initialize the
  intended recipient in a trusted deployment transaction. This change does not
  introduce an administrator or alter that trust boundary.
- Positive amounts and fees from 0 through 10,000 basis points are accepted.
  Release also validates stored records before invoking a token. Invalid amounts
  or fee rates fail without transferring funds.
- Creating before initialization remains supported. Later initialization preserves
  the existing ID counter and funded records; release still requires initialization.
- IDs increase monotonically. Exhausted IDs or a counter pointing at an existing
  bounty fail before token transfer. No existing record is overwritten. Inconsistent
  legacy state fails closed rather than being repaired silently.
- The protocol fee is `floor(amount * fee_bps / 10000)`. Quotient/remainder
  arithmetic preserves rounding and works through `i128::MAX` without intermediate
  overflow. The hunter receives the remainder, including zero at a 100% fee.
- Release reserves the released flag before calling the token. A failed Soroban
  invocation rolls back that flag, token balances, and events, including a fee
  transfer followed by a failed hunter transfer. A subsequent authorized retry can
  succeed; an already successful release cannot pay twice. Soroban transaction
  execution and the ID/released guards prevent conflicting state transitions.
- Repeated successful creation calls represent distinct funded bounties, as before.
  Callers must track transaction submission when retrying; the existing interface
  has no application-level idempotency key.

Existing panic diagnostics are preserved for initialization, missing records,
duplicate release, amount, and fee validation. Counter conflicts and exhaustion
have explicit static messages. No credentials or authorization payloads are logged.
Malformed legacy records or inconsistent counters require an operator-reviewed
upgrade/repair; this contract does not expose a new recovery endpoint.

## Regression checks

`contracts/src/compatibility_tests.rs` covers generated method specifications,
independently encoded legacy storage records, event formats, initialization order,
repeat initialization, missing/reset/exhausted counters, boundary fees and amounts,
invalid stored data, missing authorization, failed funding, and rollback/retry after
partial payout failure. The original fee and double-release tests remain in `lib.rs`.

Run with Rust 1.88.0 and the `wasm32v1-none` target. This target avoids the
unsupported Wasm features enabled by newer Rust versions on
`wasm32-unknown-unknown`; see [Stellar's Rust dialect guide](https://developers.stellar.org/docs/learn/fundamentals/contract-development/rust-dialect).

```sh
cargo test --locked --manifest-path contracts/Cargo.toml
cargo build --locked --manifest-path contracts/Cargo.toml --release --target wasm32v1-none
cargo test --locked --manifest-path contracts/Cargo.toml --features wasm-tests
```

The `wasm-tests` feature loads the release artifact from the default Cargo target
directory into the pinned Soroban runtime, then checks creation before
initialization, maximum-amount payout, and sequential IDs using that Wasm.
Build the artifact before enabling this feature. The contract CI job builds the
artifact and runs all native and Wasm compatibility tests. SDK 21's unused
`alloc` feature is disabled because it imports `std` on Wasm, which is unavailable
on this target. The contract uses SDK host-backed values rather than Rust heap
allocation. Dependency versions and `Cargo.lock` are unchanged.
