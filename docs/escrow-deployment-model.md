# Escrow Deployment Model Design Document

> **Status:** Draft  
> **Scope:** Documentation only — no factory implementation  
> **Last Updated:** 2026-04-27  
> **Contract:** LiquifactEscrow (Soroban/Stellar)

---

## Table of Contents

1. [Current Deployment Model](#1-current-deployment-model)
2. [Core Invariants](#2-core-invariants)
3. [Future Factory Model (Design Constraints)](#3-future-factory-model-design-constraints)
4. [Risks of a Factory](#4-risks-of-a-factory)
5. [Comparison: Current vs Factory Model](#5-comparison-current-vs-factory-model)
6. [External Calls Context](#6-external-calls-context)
7. [Security Notes](#7-security-notes)
8. [Design Principles](#8-design-principles)
9. [Explicit Non-Goals](#9-explicit-non-goals)

---

## 1. Current Deployment Model

### 1.1 Architecture Overview

The LiquiFact system currently employs a **single-instance-per-deployment** model for escrow contracts on the Stellar/Soroban network. Each deployment represents an isolated funding instance with its own state, token bindings, and access controls.

### 1.2 Deployment Process

**How contracts are deployed:**

1. **Manual/Scripted Deployment:** Each escrow contract is deployed individually via Soroban CLI or deployment scripts
2. **One Contract = One Invoice/Funding Instance:** Each deployed contract instance maps to a specific invoice or funding operation
3. **Environment-Based Configuration:** Contract addresses are registered in the backend via `ESCROW_ADDR_BY_INVOICE` environment variable or database mappings
4. **No Factory Pattern:** There is no automated cloning or instantiation mechanism — each deployment is explicit

**Deployment flow:**
```
Invoice Created → Deploy New Escrow Contract → Register Contract ID → Map to Invoice → Fund Escrow
```

### 1.3 State Isolation

Each escrow instance maintains complete state isolation:

- **Independent Storage:** Each contract has its own persistent storage on the Soroban ledger
- **No Shared Mutable State:** Contract instances do not share storage keys or mutable data
- **Per-Instance Authorization:** Access controls (e.g., creator, hunter, fee recipient) are bound to the specific contract instance
- **Separate Token Bindings:** Each escrow binds to its own token address during initialization

**Storage structure (per instance):**
```rust
// Instance-level storage (shared across all invocations of this contract)
- DataKey::FeeRecipient  → Address (immutable after initialization)
- DataKey::NextId        → u64 (auto-incrementing bounty counter)

// Persistent storage (per-bounty)
- DataKey::Bounty(id)    → Bounty { creator, hunter, token, amount, protocol_fee_bps, released }
```

### 1.4 User Interaction Model

Users interact with each deployed escrow through:

1. **Backend API Routes:** 
   - `GET /api/escrow/:invoiceId` — reads on-chain state
   - `POST /api/invest/escrow` — submits funding transactions
   - `POST /api/admin/escrow/refresh` — triggers contract list refresh

2. **Direct Soroban RPC:** Advanced users can query contract state directly via Soroban RPC using the contract ID

3. **Contract Address Resolution:** The backend maintains a mapping of invoice IDs to Stellar contract addresses (`C...` format) via:
   - Environment variable: `ESCROW_ADDR_BY_INVOICE`
   - Database mappings (future)
   - Allowlist validation for security

---

## 2. Core Invariants

⚠️ **CRITICAL:** The following invariants MUST NEVER be violated, regardless of future architectural changes.

### A. Token Immutability

**Rule:** Token address and configuration MUST NOT change after deployment.

**Rationale:**
- Prevents bait-and-switch attacks where a token is swapped post-deployment
- Ensures fund recipients know exactly which asset they will receive
- Maintains audit trail integrity

**Enforcement:**
```rust
// Token is bound at bounty creation time and stored immutably
pub struct Bounty {
    pub token: Address,  // Set once, never modified
    // ...
}
```

**Violation Scenarios:**
- ❌ Modifying token address after `create_bounty`
- ❌ Allowing admin to reconfigure token post-deployment
- ❌ Using proxy patterns that could redirect token calls

---

### B. Treasury Safety

**Rule:** Treasury (fee recipient) address MUST be fixed or strictly controlled. No unauthorized redirection of funds.

**Rationale:**
- Prevents fee diversion attacks
- Ensures protocol revenue flows to intended recipient
- Maintains trust in fee collection mechanism

**Enforcement:**
```rust
// Fee recipient set once during initialization
pub fn initialize(env: Env, fee_recipient: Address) {
    if env.storage().instance().has(&DataKey::FeeRecipient) {
        panic!("already initialized");  // Prevents re-initialization
    }
    env.storage().instance().set(&DataKey::FeeRecipient, &fee_recipient);
}
```

**Violation Scenarios:**
- ❌ Allowing `initialize` to be called multiple times
- ❌ Adding admin functions to change fee recipient
- ❌ Using upgradeable contracts that could modify treasury logic

---

### C. Escrow Isolation

**Rule:** Each escrow MUST be independent. No shared mutable state across escrows.

**Rationale:**
- Prevents cross-contamination between funding instances
- Ensures failure in one escrow doesn't affect others
- Maintains clear audit boundaries per invoice

**Enforcement:**
- Each contract instance has its own ledger storage namespace
- No global variables or cross-contract state sharing
- Storage keys are instance-scoped (not global)

**Violation Scenarios:**
- ❌ Using global storage keys that span multiple contracts
- ❌ Implementing shared liquidity pools without proper isolation
- ❌ Cross-contract calls that mutate state in other escrows

---

### D. Funding Integrity

**Rule:** Deposits and releases MUST remain deterministic. No cross-escrow leakage of funds or accounting.

**Rationale:**
- Ensures exact amounts are transferred as specified
- Prevents double-spending or fund loss
- Maintains mathematical correctness of fee calculations

**Enforcement:**
```rust
// Deterministic fee calculation
let fee: i128 = bounty.amount * (bounty.protocol_fee_bps as i128) / 10_000;
let payout: i128 = bounty.amount - fee;

// Atomic transfers
client.transfer(&env.current_contract_address(), &fee_recipient, &fee);
client.transfer(&env.current_contract_address(), &bounty.hunter, &payout);
```

**Violation Scenarios:**
- ❌ Rounding errors that lose funds
- ❌ Race conditions in concurrent releases
- ❌ Incorrect fee calculations that over/under-charge

---

## 3. Future Factory Model (Design Constraints)

If a factory pattern is introduced in the future, it MUST enforce the following guarantees:

### 3.1 Required Guarantees

#### Deterministic Deployment

- Factory must produce predictable contract addresses (if applicable)
- Deployment parameters must be validated before instantiation
- Failed deployments must not leave partial state

**Example pattern:**
```rust
// Factory creates escrow with known parameters
pub fn create_escrow(
    env: Env,
    fee_recipient: Address,
    // ... other init params
) -> Address {
    // Validate inputs BEFORE deployment
    assert!(is_valid_address(&fee_recipient));
    
    // Deploy and initialize atomically
    let escrow_id = env.deployer().with_current_contract().deploy(...);
    
    // Initialize immediately (prevent uninitialized state)
    let client = EscrowClient::new(&env, &escrow_id);
    client.initialize(&fee_recipient);
    
    escrow_id
}
```

#### Immutable Initialization Parameters

- All configuration must be set during factory creation call
- No post-creation mutation of escrow config allowed
- Factory cannot retain admin privileges over created escrows

#### No Post-Creation Mutation

- Factory must NOT be able to call admin functions on created escrows
- Initialization must be idempotent and irreversible
- No upgrade paths that could weaken invariants

#### Safe Multi-Instance Instantiation

- Factory must ensure each escrow is fully initialized before returning
- No shared state between factory-created instances
- Each instance must have unique storage namespace

---

### 3.2 Factory Constraints

| Constraint | Description | Enforcement |
|------------|-------------|-------------|
| **No Override of Invariants** | Factory cannot bypass token immutability, treasury safety, or escrow isolation | Contract-level assertions and storage guards |
| **Per-Instance Isolation** | Each created escrow must be fully independent | No shared storage keys, no cross-escrow calls |
| **Correct Token + Treasury Binding** | Factory must validate token and treasury addresses before deployment | Input validation + initialization guards |
| **No Factory Admin Backdoors** | Factory cannot retain privileged access to created escrows | No stored admin references, no privileged functions |
| **Atomic Creation** | Escrow must be fully initialized or not created at all | Deploy + initialize in single transaction |

---

## 4. Risks of a Factory

⚠️ **WARNING:** Introducing a factory pattern significantly increases attack surface and operational risk.

### 4.1 Misconfigured Deployments

**Risk:** Factory creates escrows with wrong token or treasury addresses.

**Impact:**
- Funds locked in incorrectly configured contracts
- Fees diverted to wrong treasury
- Token mismatches causing payout failures

**Mitigation:**
- Strict input validation before deployment
- Allowlist of approved token addresses
- Multi-sig or timelock on factory deployment functions

---

### 4.2 Shared-State Vulnerabilities

**Risk:** Factory inadvertently introduces shared mutable state across escrows.

**Impact:**
- Cross-escrow contamination
- Cascading failures
- Violation of isolation invariants

**Examples:**
- Factory maintains registry of created escrows in mutable storage
- Escrows reference factory for configuration (creates coupling)
- Shared event handlers that process multiple escrows

**Mitigation:**
- Factory should be stateless after creation
- No escrow-to-factory callbacks after initialization
- Independent storage namespaces for each escrow

---

### 4.3 Upgradeability Risks

**Risk:** If factory or escrows are made upgradeable, invariants could be violated in future versions.

**Impact:**
- Token binding could be changed
- Treasury could be redirected
- Access controls could be weakened

**Mitigation:**
- **Strongly prefer non-upgradeable contracts** for escrow logic
- If upgradeability is required, use multi-sig governance with timelocks
- Immutable core invariants enforced at storage level (not just code)

---

### 4.4 Incorrect Initialization

**Risk:** Factory creates escrows but fails to initialize them properly.

**Impact:**
- Uninitialized escrows accepting funds
- Missing fee recipient configuration
- Broken access controls

**Mitigation:**
- Atomic deploy + initialize in single transaction
- Post-deployment verification checks
- Reject calls to uninitialized escrows

---

### 4.5 Factory as Single Point of Failure

**Risk:** Factory contract becomes a central target for attacks.

**Impact:**
- Compromised factory could create malicious escrows
- Factory bugs affect all future deployments
- Gas/fee manipulation during batch creation

**Mitigation:**
- Minimal factory logic (deploy + initialize only)
- No stored state in factory after creation
- Rate limiting on factory calls (if applicable)

---

## 5. Comparison: Current vs Factory Model

| Aspect | Current Model | Factory Model |
|--------|---------------|---------------|
| **Deployment** | One contract per escrow (manual/scripted) | Factory creates instances programmatically |
| **Isolation** | Strong (inherent in separate deployments) | Must be explicitly enforced by factory |
| **Complexity** | Low (simple deployment flow) | Higher (factory logic + instance management) |
| **Risk** | Lower (each deployment is audited) | Higher if misconfigured or buggy |
| **Gas Cost** | Higher per-instance (full deployment cost) | Potentially lower (optimized creation) |
| **Auditability** | High (each contract independently verifiable) | Requires auditing factory + instances |
| **Flexibility** | Low (manual process) | High (automated, parameterized) |
| **Trust Model** | Trust each deployed contract | Trust factory + all created instances |
| **State Management** | Fully isolated by default | Must ensure no shared state |
| **Upgradeability** | Per-contract decision | Factory-wide policy (risky) |

**Recommendation:** The current model is **strongly preferred** for production use until a factory pattern can be designed, audited, and tested with equivalent security guarantees.

---

## 6. External Calls Context

### 6.1 Token Interactions

The escrow contract interacts with external tokens via the Soroban token interface:

```rust
// Token client created for each bounty's specific token
let client = token::Client::new(&env, &bounty.token);

// Transfer into escrow (funding)
client.transfer(&creator, &env.current_contract_address(), &amount);

// Transfer out of escrow (payout)
client.transfer(&env.current_contract_address(), &fee_recipient, &fee);
client.transfer(&env.current_contract_address(), &bounty.hunter, &payout);
```

**Assumptions about token behavior:**
1. Token implements standard Soroban token interface
2. `transfer` is atomic and either succeeds or fails completely
3. Token balance checks are accurate and consistent
4. Token does not have reentrancy vulnerabilities
5. Token decimals and precision are compatible with escrow calculations

---

### 6.2 External Call Guarantees

**What MUST remain consistent in any deployment model:**

| Guarantee | Description |
|-----------|-------------|
| **Atomic Transfers** | Token transfers must complete fully or not at all |
| **No Reentrancy** | External token calls must not allow reentrant calls into escrow |
| **Balance Accuracy** | Token balances must reflect actual escrowed amounts |
| **Address Validity** | Token addresses must be validated before use |

**Reentrancy Protection:**
- Current implementation is naturally reentrancy-safe (no callbacks)
- Future versions should maintain this property
- Consider adding explicit reentrancy guards if complex flows are introduced

---

### 6.3 Soroban RPC Interactions

The backend interacts with deployed escrows via Soroban RPC:

```javascript
// Backend reads on-chain state
async function fetchLegalHold(invoiceId, adapter) {
  // Calls Soroban RPC to read contract state
  return await callSorobanContract(operation);
}
```

**Assumptions:**
- Soroban RPC is reliable and returns consistent state
- Contract getters (`get_bounty`, `get_legal_hold`, etc.) are view-only
- RPC failures default to safe states (e.g., legal hold = false)

---

## 7. Security Notes

### 7.1 Token Behavior Assumptions

| Assumption | Risk if Violated | Mitigation |
|------------|------------------|------------|
| Standard token interface | Transfer failures, fund loss | Validate token contract before binding |
| No hidden fees in transfers | Payout mismatches | Use trusted token allowlist |
| Accurate balance reporting | Over/under-payment | Verify balances before/after transfers |
| No minting after escrow creation | Token dilution | Audit token supply mechanics |

---

### 7.2 Trust Boundaries

```
┌─────────────────────────────────────────────┐
│  Untrusted Zone                             │
│  - User wallets                             │
│  - External token contracts                 │
│  - Soroban RPC endpoints                    │
└──────────────┬──────────────────────────────┘
               │
               ▼
┌─────────────────────────────────────────────┐
│  Trust Boundary (Contract Enforced)         │
│  - Authorization checks (require_auth)      │
│  - Input validation (assert)                │
│  - State guards (already initialized)       │
└──────────────┬──────────────────────────────┘
               │
               ▼
┌─────────────────────────────────────────────┐
│  Trusted Zone                               │
│  - Escrow contract storage                  │
│  - Verified token transfers                 │
│  - Deterministic calculations               │
└─────────────────────────────────────────────┘
```

**Key principles:**
- Never trust external calls without validation
- Always require explicit authorization for state mutations
- Default to safe states on errors

---

### 7.3 Out-of-Scope

The following are **explicitly out-of-scope** for this deployment model:

- ❌ Token economics or tokenomics design
- ❌ Token governance mechanisms
- ❌ Market liquidity or price oracle integration
- ❌ Cross-chain bridge operations
- ❌ MEV protection (Soroban ordering model handles this)
- ❌ Gas optimization (correctness > efficiency)

---

### 7.4 Why Immutability is Critical

**Immutability protects against:**
1. **Insider threats:** Developers cannot modify contracts to steal funds
2. **Governance attacks:** No admin keys to compromise
3. **Upgrade vulnerabilities:** No attack surface from version changes
4. **State corruption:** Immutable storage prevents accidental mutations

**Trade-offs:**
- ✅ Higher security guarantees
- ✅ Simpler audit surface
- ❌ Less flexibility for bug fixes
- ❌ Requires new deployment for changes

**Recommendation:** Prefer immutability for all escrow logic. If bugs are discovered, deploy new contracts and migrate users rather than attempting upgrades.

---

## 8. Design Principles

### 8.1 Why Single-Instance Deployment is Currently Safer

1. **Minimal Trust Surface:** Each contract is independently auditable
2. **No Factory Risk:** Eliminates factory-related attack vectors
3. **Clear Accountability:** Each deployment has its own security boundary
4. **Simpler Testing:** Test each instance in isolation
5. **Gradual Rollout:** Canary deployments with new versions
6. **Failure Containment:** Bugs in one instance don't affect others

---

### 8.2 Why Factory Must Not Weaken Guarantees

If a factory is introduced, it must:

- **Preserve all existing invariants** (token immutability, treasury safety, isolation, funding integrity)
- **Add no new trust assumptions** beyond the factory itself
- **Maintain equivalent auditability** as individual deployments
- **Provide no admin backdoors** to created instances
- **Ensure atomic initialization** (no partially-configured escrows)

---

### 8.3 Alignment with Soroban/Stellar Design Patterns

The current model aligns with Stellar best practices:

| Pattern | Implementation |
|---------|----------------|
| **Minimal contracts** | Escrow contains only essential logic |
| **No upgradeability** | Contracts are immutable after deployment |
| **Explicit authorization** | `require_auth()` on all state mutations |
| **Event logging** | `env.events().publish()` for audit trail |
| **Storage isolation** | Per-instance persistent storage |
| **Standard interfaces** | Soroban token client for transfers |

**Soroban-specific considerations:**
- WASM contracts are deployed with unique IDs
- Storage is scoped to contract instance (not global)
- Authorization is enforced at runtime (not compile-time)
- Events provide off-chain audit capabilities

---

## 9. Explicit Non-Goals

This document and the associated design **explicitly exclude**:

- ❌ **No factory implementation** — This is documentation only
- ❌ **No changes to contract logic** — Existing contracts remain unchanged
- ❌ **No introduction of upgradeability** — Contracts stay immutable
- ❌ **No migration path** — Current deployments are not affected
- ❌ **No new deployment scripts** — Operational tooling is out-of-scope
- ❌ **No security audit** — This document informs but does not replace audits

---

## Appendix A: Glossary

| Term | Definition |
|------|------------|
| **Escrow Instance** | A single deployed Soroban contract representing one funding operation |
| **Factory** | A contract that creates and initializes other contracts (not yet implemented) |
| **Invariant** | A condition that must always hold true for system correctness |
| **Treasury** | The fee recipient address configured during initialization |
| **Token Binding** | The association of a specific token with an escrow instance |
| **Soroban RPC** | Remote procedure call interface for interacting with Soroban contracts |
| **WASM** | WebAssembly binary format used for Soroban smart contracts |

---

## Appendix B: Related Documentation

- [Escrow Integration Overview](./escrow-integration-overview.md) — End-to-end indexer, read API, funding, and reconciliation
- [Wasm Deployment Operations](./wasm-ops.md) — Operational guide for escrow wasm upgrades
- [Ops Signing Design](./ops-signing.md) — Server-orchestrated signing interface
- [API Examples](./API-Examples.md) — Backend API usage examples
- [Database Migrations](../DB_MIGRATIONS.md) — Schema evolution guide

---

## Appendix C: Contract Storage Layout

```rust
// Instance-level storage (shared across all calls to this contract)
DataKey::FeeRecipient  → Address       // Set once, never changes
DataKey::NextId        → u64           // Auto-incrementing counter

// Persistent storage (per-bounty entries)
DataKey::Bounty(0)     → Bounty { ... }
DataKey::Bounty(1)     → Bounty { ... }
DataKey::Bounty(n)     → Bounty { ... }
```

**Storage tiers:**
- `instance()` — Lives as long as contract is deployed
- `persistent()` — Lives until explicitly removed (with rent)
- `temporary()` — Short-lived (not used in current escrow)

---

**Document Version:** 1.0  
**Maintained By:** LiquiFact Core Team  
**Review Cycle:** Before any factory implementation is attempted
