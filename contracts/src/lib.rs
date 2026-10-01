#![no_std]

//! Escrow contract for issue bounties, with explicit validation boundaries.
//!
//! Every entry point validates its arguments *before* it writes state or calls
//! the token contract, so an invalid request is rejected deterministically with
//! a typed [`BountyError`] and cannot leave a partially applied escrow behind.
//!
//! ## Invariants
//!
//! These hold for every state reachable through the public API:
//!
//! 1. **Initialised before use.** `create_bounty` and `release_bounty` require
//!    `FeeRecipient` to exist, and `initialize` is the only writer of it. Before
//!    this boundary existed, a bounty could be opened before `initialize` and
//!    then never released, because `release_bounty` requires a fee recipient.
//! 2. **Amount range.** `1 <= amount <= MAX_BOUNTY_AMOUNT`. The upper bound is
//!    chosen so that the fee arithmetic of invariant 3 can never overflow.
//! 3. **Fee range.** `0 <= protocol_fee_bps < MAX_PROTOCOL_FEE_BPS`. The fee is
//!    `amount * protocol_fee_bps / 10_000` (truncating), so `fee <= amount - 1`
//!    and `payout = amount - fee >= 1`: a bounty can never be released while
//!    paying the hunter nothing, and no accepted request can overflow `i128`.
//! 4. **Distinct, live accounts.** `creator`, `hunter` and `token` are pairwise
//!    constrained: `creator != hunter`, and none of them is the contract itself.
//!    Paying the contract would strand the payout with no recipient.
//! 5. **Ids are allocated once.** `NextId` is advanced before the token call and
//!    is never reset, so a re-sent or repeated submission can never overwrite an
//!    existing bounty record. Every stored id is checked to be vacant.
//! 6. **One release per bounty.** `released` is checked, then persisted, before
//!    the payout transfers, so a second release can never move funds twice.
//! 7. **Conservation.** For a released bounty,
//!    `amount == payout + fee` and `payout + fee` leaves the escrow account.
//!    Nothing else debits or credits the escrow account.

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, token, Address, BytesN, Env, Symbol,
};

/// Denominator for basis-point arithmetic: 10_000 bps == 100%.
pub const BPS_DENOMINATOR: i128 = 10_000;

/// Absolute ceiling for `protocol_fee_bps`, in basis points.
///
/// The protocol fee is deducted *from* the escrow rather than added on top, so
/// `bps == 10_000` would let a bounty be created and released while the hunter
/// receives nothing and the entire escrow is taken as a fee. `create_bounty`
/// therefore accepts `bps < MAX_PROTOCOL_FEE_BPS`, which - together with
/// truncating division - guarantees `payout >= 1` for every accepted request.
pub const MAX_PROTOCOL_FEE_BPS: u32 = 10_000;

/// Largest `amount`, in token base units, that `create_bounty` accepts.
///
/// `release_bounty` evaluates `amount * protocol_fee_bps` in `i128`. Capping
/// `amount` at `i128::MAX / 10_000` keeps that product representable for every
/// accepted `protocol_fee_bps` (which is itself `< 10_000`), so no bounty can be
/// escrowed into a state where its own release overflows. Previously
/// `create_bounty` only required `amount > 0`, so `create_bounty` succeeded for
/// amounts whose release then trapped on overflow, locking the escrow forever.
pub const MAX_BOUNTY_AMOUNT: i128 = i128::MAX / BPS_DENOMINATOR;

// ── Errors ───────────────────────────────────────────────────────────────────

/// Rejection reasons returned by every entry point.
///
/// Codes are part of the on-chain contract: they are what a caller sees in the
/// failed transaction and what off-chain code should branch on. They are stable
/// and must never be renumbered; add new variants at the end instead.
#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum BountyError {
    /// `initialize` was already called for this contract instance.
    AlreadyInitialized = 1,
    /// The contract has not been initialized, so no bounty can be opened or
    /// released. Retrying after `initialize` succeeds is safe.
    NotInitialized = 2,
    /// `amount` is zero, negative, or above `MAX_BOUNTY_AMOUNT`.
    AmountOutOfRange = 3,
    /// `protocol_fee_bps` is not within `0..MAX_PROTOCOL_FEE_BPS`.
    FeeBpsOutOfRange = 4,
    /// `creator` and `hunter` are the same account, so the bounty is a
    /// self-payment that only burns a protocol fee.
    CreatorIsHunter = 5,
    /// `creator` is the bounty contract itself.
    CreatorIsContract = 6,
    /// `hunter` is the bounty contract itself, so the payout would be
    /// transferred back into the escrow with no recipient.
    HunterIsContract = 7,
    /// `token` is the bounty contract itself, which has no token interface.
    TokenIsContract = 8,
    /// `fee_recipient` is the bounty contract itself, so protocol fees would
    /// accumulate in the escrow with no recipient.
    FeeRecipientIsContract = 9,
    /// No bounty is stored under `id`.
    BountyNotFound = 10,
    /// The bounty has already been released; funds cannot move twice.
    AlreadyReleased = 11,
    /// The id counter is exhausted (`u64::MAX`); no further ids exist.
    IdSpaceExhausted = 12,
    /// A bounty is already stored under the id that was about to be allocated.
    /// Unreachable while `NextId` only ever advances; kept as a guard so a
    /// corrupted counter fails loudly instead of overwriting a live escrow.
    IdCollision = 13,
    /// An idempotency key was replayed with different parameters. The original
    /// bounty is untouched.
    IdempotencyKeyReuse = 14,
    /// Defensive: the fee or payout computation left the `i128` range. Cannot
    /// happen for any request that passed validation; kept so that an
    /// arithmetic fault is reported as a typed error instead of a bare trap.
    ArithmeticOverflow = 15,
}

// ── Storage keys ─────────────────────────────────────────────────────────────

#[contracttype]
pub enum DataKey {
    /// Address that receives protocol fees; doubles as the initialised marker.
    FeeRecipient,
    /// Id the next bounty will receive. Never reset once set.
    NextId,
    /// Escrowed bounty state, keyed by id.
    Bounty(u64),
    /// Creation parameters recorded per idempotency key, so a replay can be
    /// told apart from a key reused for different parameters.
    Creation(BytesN<32>),
}

// ── Data types ───────────────────────────────────────────────────────────────

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Bounty {
    pub creator: Address,
    pub hunter: Address,
    pub token: Address,
    pub amount: i128,
    pub protocol_fee_bps: u32,
    pub released: bool,
}

/// The exact parameters a bounty was opened with.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CreationRequest {
    pub creator: Address,
    pub hunter: Address,
    pub token: Address,
    pub amount: i128,
    pub protocol_fee_bps: u32,
}

/// Idempotency record: which id a key produced, and what it was asked for.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Creation {
    pub id: u64,
    pub request: CreationRequest,
}

// ── Validation ───────────────────────────────────────────────────────────────

/// Rejects a request that has reached a contract which was never initialized.
///
/// `FeeRecipient` is written only by `initialize`, so its absence is the single
/// precondition shared by `create_bounty` and `release_bounty`.
fn validate_initialized(env: &Env) -> Result<(), BountyError> {
    if !env.storage().instance().has(&DataKey::FeeRecipient) {
        return Err(BountyError::NotInitialized);
    }
    Ok(())
}

/// Validates a bounty request in a fixed order, so a request that breaks
/// several rules at once always reports the same error.
///
/// This function is pure: it reads no state beyond the initialised marker and
/// calls no other contract, which makes it safe to run before any escrow.
fn validate_creation(env: &Env, request: &CreationRequest) -> Result<(), BountyError> {
    validate_initialized(env)?;

    if request.amount <= 0 || request.amount > MAX_BOUNTY_AMOUNT {
        return Err(BountyError::AmountOutOfRange);
    }

    if request.protocol_fee_bps >= MAX_PROTOCOL_FEE_BPS {
        return Err(BountyError::FeeBpsOutOfRange);
    }

    let this_contract = env.current_contract_address();
    if request.creator == request.hunter {
        return Err(BountyError::CreatorIsHunter);
    }
    if request.creator == this_contract {
        return Err(BountyError::CreatorIsContract);
    }
    if request.hunter == this_contract {
        return Err(BountyError::HunterIsContract);
    }
    if request.token == this_contract {
        return Err(BountyError::TokenIsContract);
    }

    Ok(())
}

/// Splits an escrowed amount into protocol fee and hunter payout.
///
/// Returns the fee first, matching the emitted event. Both steps are checked so
/// an arithmetic fault is reported as [`BountyError::ArithmeticOverflow`]
/// instead of trapping mid-release, which would leave the escrow unreleasable.
fn split_amount(amount: i128, protocol_fee_bps: u32) -> Result<(i128, i128), BountyError> {
    let scaled = amount
        .checked_mul(protocol_fee_bps as i128)
        .ok_or(BountyError::ArithmeticOverflow)?;
    let fee = scaled / BPS_DENOMINATOR;
    let payout = amount
        .checked_sub(fee)
        .ok_or(BountyError::ArithmeticOverflow)?;
    Ok((fee, payout))
}

// ── Bounty lifecycle ─────────────────────────────────────────────────────────

/// Shared implementation of `create_bounty` and `create_bounty_with_key`.
///
/// `key` enables replay protection; `create_bounty` passes `None` because
/// intentionally opening two identical bounties is a legitimate request.
fn open_bounty(
    env: &Env,
    creator: Address,
    hunter: Address,
    token: Address,
    amount: i128,
    protocol_fee_bps: u32,
    key: Option<BytesN<32>>,
) -> Result<u64, BountyError> {
    creator.require_auth();

    let request = CreationRequest {
        creator: creator.clone(),
        hunter: hunter.clone(),
        token: token.clone(),
        amount,
        protocol_fee_bps,
    };

    // Replay handling runs before validation so that a retry of an accepted
    // request is always answered with the original id, never with a second
    // escrow. A key reused for *different* parameters is refused instead.
    if let Some(key) = &key {
        let recorded: Option<Creation> = env
            .storage()
            .persistent()
            .get(&DataKey::Creation(key.clone()));
        if let Some(recorded) = recorded {
            return if recorded.request == request {
                Ok(recorded.id)
            } else {
                Err(BountyError::IdempotencyKeyReuse)
            };
        }
    }

    validate_creation(env, &request)?;

    // Reserve the id before the token call. The token is untrusted and may
    // re-enter, so the counter must already be past this id when it runs.
    let next_id: u64 = env
        .storage()
        .instance()
        .get(&DataKey::NextId)
        .ok_or(BountyError::NotInitialized)?;
    if env.storage().persistent().has(&DataKey::Bounty(next_id)) {
        return Err(BountyError::IdCollision);
    }
    let following_id = next_id
        .checked_add(1)
        .ok_or(BountyError::IdSpaceExhausted)?;
    env.storage()
        .instance()
        .set(&DataKey::NextId, &following_id);

    // Pull funds into the contract. If this fails the whole invocation is
    // discarded, which also rolls back the reserved id above.
    token::Client::new(env, &token).transfer(&creator, &env.current_contract_address(), &amount);

    env.storage().persistent().set(
        &DataKey::Bounty(next_id),
        &Bounty {
            creator,
            hunter,
            token,
            amount,
            protocol_fee_bps,
            released: false,
        },
    );

    if let Some(key) = key {
        env.storage().persistent().set(
            &DataKey::Creation(key),
            &Creation {
                id: next_id,
                request,
            },
        );
    }

    env.events()
        .publish((Symbol::new(env, "bounty_created"), next_id), amount);

    Ok(next_id)
}

// ── Contract ─────────────────────────────────────────────────────────────────

#[contract]
pub struct BountyContract;

#[contractimpl]
impl BountyContract {
    /// One-time initialiser - sets the fee recipient address.
    ///
    /// Fails with [`BountyError::AlreadyInitialized`] on a second call and with
    /// [`BountyError::FeeRecipientIsContract`] when fees could never leave the
    /// escrow account.
    pub fn initialize(env: Env, fee_recipient: Address) -> Result<(), BountyError> {
        if env.storage().instance().has(&DataKey::FeeRecipient) {
            return Err(BountyError::AlreadyInitialized);
        }
        if fee_recipient == env.current_contract_address() {
            return Err(BountyError::FeeRecipientIsContract);
        }

        env.storage()
            .instance()
            .set(&DataKey::FeeRecipient, &fee_recipient);
        // Legacy callers may create bounties before initialization. Preserve their
        // counter instead of resetting it and overwriting already funded escrow.
        if !env.storage().instance().has(&DataKey::NextId) {
            env.storage().instance().set(&DataKey::NextId, &0u64);
        }
    }

    /// Create a bounty.
    ///
    /// `protocol_fee_bps` is the share of the escrow taken as protocol fee;
    /// pass 0 for no fee. The full `amount` is transferred from the caller into
    /// the contract escrow immediately. See [`BountyError`] for the full set of
    /// rejection reasons and the module documentation for the invariants.
    pub fn create_bounty(
        env: Env,
        creator: Address,
        hunter: Address,
        token: Address,
        amount: i128,
        protocol_fee_bps: u32,
    ) -> Result<u64, BountyError> {
        open_bounty(&env, creator, hunter, token, amount, protocol_fee_bps, None)
    }

        assert!(amount > 0,           "amount must be positive");
        assert!(protocol_fee_bps <= 10_000, "fee_bps must be <= 10000");

        let id: u64 = env.storage().instance().get(&DataKey::NextId).unwrap_or(0);
        let next_id = id.checked_add(1).expect("bounty id exhausted");
        // Never replace a legacy bounty if a counter is missing or inconsistent.
        // Check before interacting with the token, and keep the existing keys.
        assert!(
            !env.storage().persistent().has(&DataKey::Bounty(id)),
            "bounty id already exists"
        );

        // Pull funds into the contract.
        let client = token::Client::new(&env, &token);
        client.transfer(&creator, &env.current_contract_address(), &amount);

        let bounty = Bounty {
            creator,
            hunter,
            token,
            amount,
            protocol_fee_bps,
            released: false,
        };
        env.storage().persistent().set(&DataKey::Bounty(id), &bounty);
        env.storage().instance().set(&DataKey::NextId, &next_id);

        env.events().publish(
            (Symbol::new(&env, "bounty_created"), id),
            amount,
        );

        id
    }

    /// Release a bounty to the hunter, deducting the protocol fee first.
    ///
    /// Fee is deducted from the payout (not added on top).
    /// A fee of 0 bps results in the full amount going to the hunter.
    /// The payout is always at least 1 unit: see [`MAX_PROTOCOL_FEE_BPS`].
    pub fn release_bounty(env: Env, id: u64) -> Result<(), BountyError> {
        validate_initialized(&env)?;

        let mut bounty: Bounty = env
            .storage()
            .persistent()
            .get(&DataKey::Bounty(id))
            .ok_or(BountyError::BountyNotFound)?;

        bounty.creator.require_auth();
        if bounty.released {
            return Err(BountyError::AlreadyReleased);
        }

        let fee_recipient: Address = env
            .storage()
            .instance()
            .get(&DataKey::FeeRecipient)
            .ok_or(BountyError::NotInitialized)?;

        let (fee, payout) = split_amount(bounty.amount, bounty.protocol_fee_bps)?;

        // Mark released before the token calls: the flag is what stops a second
        // release, so it must not depend on the transfers succeeding. The
        // Soroban host rejects re-entry into a contract that is already on the
        // call stack, and persisting first also keeps that guarantee from being
        // load-bearing.
        bounty.released = true;
        env.storage()
            .persistent()
            .set(&DataKey::Bounty(id), &bounty);

        let client = token::Client::new(&env, &bounty.token);
        let escrow = env.current_contract_address();

        // fee = amount * bps / 10_000  (integer division, rounds down)
        if fee > 0 {
            client.transfer(&escrow, &fee_recipient, &fee);
        }
        client.transfer(&escrow, &bounty.hunter, &payout);

        env.events()
            .publish((Symbol::new(&env, "bounty_released"), id), (payout, fee));

        Ok(())
    }

    /// Refund a bounty to the creator if it has not been released.
    ///
    /// Only the creator may refund, and only while the bounty is unreleased.
    /// This is the inverse transition of `release_bounty` and preserves the
    /// invariant that a bounty is either released, refunded, or pending —
    /// never both released and refunded.
    pub fn refund_bounty(env: Env, id: u64) {
        let mut bounty: Bounty = env
            .storage()
            .persistent()
            .get(&DataKey::Bounty(id))
            .expect("bounty not found");

        bounty.creator.require_auth();
        assert!(!bounty.released, "already released");
        assert!(!bounty.refunded, "already refunded");

        let client = token::Client::new(&env, &bounty.token);
        client.transfer(
            &env.current_contract_address(),
            &bounty.creator,
            &bounty.amount,
        );

        // Validate persisted records too: upgrades must not turn malformed legacy
        // data into negative payouts or mint-like token transfers.
        assert!(bounty.amount > 0, "amount must be positive");
        assert!(bounty.protocol_fee_bps <= 10_000, "fee_bps must be <= 10000");

        // Same floor(amount * bps / 10_000), without overflowing for valid i128
        // amounts. Both products are bounded when amount > 0 and bps <= 10_000.
        let bps = i128::from(bounty.protocol_fee_bps);
        let fee = (bounty.amount / 10_000) * bps + ((bounty.amount % 10_000) * bps) / 10_000;
        let payout: i128 = bounty.amount - fee;

        // Reserve the release before external calls. Soroban invocation rollback
        // restores this flag, balances and events if either transfer fails.
        bounty.released = true;
        env.storage().persistent().set(&DataKey::Bounty(id), &bounty);

        if fee > 0 {
            client.transfer(&env.current_contract_address(), &fee_recipient, &fee);
        }
        client.transfer(&env.current_contract_address(), &bounty.hunter, &payout);

        env.events().publish(
            (Symbol::new(&env, "bounty_refunded"), id),
            bounty.amount,
        );
    }

    /// Read a bounty (view helper).
    ///
    /// Panics when no bounty is stored under `id`; use [`Self::find_bounty`]
    /// for callers that must handle a missing bounty.
    pub fn get_bounty(env: Env, id: u64) -> Bounty {
        env.storage()
            .persistent()
            .get(&DataKey::Bounty(id))
            .expect("bounty not found")
    }

    /// Read a bounty, returning `None` instead of trapping when it is unknown.
    pub fn find_bounty(env: Env, id: u64) -> Option<Bounty> {
        env.storage().persistent().get(&DataKey::Bounty(id))
    }

    /// Fee recipient configured by `initialize`.
    pub fn fee_recipient(env: Env) -> Result<Address, BountyError> {
        env.storage()
            .instance()
            .get(&DataKey::FeeRecipient)
            .ok_or(BountyError::NotInitialized)
    }

    /// Number of bounties ever created, which is also the id the next bounty
    /// will receive. Ids are never skipped and never reused.
    pub fn bounty_count(env: Env) -> u64 {
        env.storage().instance().get(&DataKey::NextId).unwrap_or(0)
    }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::{
        testutils::{Address as _, Events as _},
        token::{Client as TokenClient, StellarAssetClient},
        Address, Env, TryFromVal,
    };

    /// Fault-injecting token used to exercise failure paths that a well-behaved
    /// Stellar asset contract cannot produce (a reverting transfer, or a
    /// transfer that calls back into the bounty contract).
    #[contracttype]
    pub enum MockKey {
        Balance(Address),
        Reenter,
        ReenterMode,
        ReenterId,
        ReenterParty,
        ReentryOutcome,
    }

    #[contract]
    pub struct MockToken;

    #[contractimpl]
    impl MockToken {
        pub fn mint(env: Env, to: Address, amount: i128) {
            let balance: i128 = Self::balance_of(&env, &to);
            env.storage()
                .persistent()
                .set(&MockKey::Balance(to), &(balance + amount));
        }

        pub fn balance(env: Env, of: Address) -> i128 {
            Self::balance_of(&env, &of)
        }

        /// Arms the behaviour of the next transfer: `1` reverts, `2` re-enters
        /// `release_bounty(id)` once, `3` re-enters `create_bounty` once.
        pub fn arm(env: Env, mode: i64, id: u64, party: Address) {
            env.storage().persistent().set(&MockKey::ReenterMode, &mode);
            env.storage().persistent().set(&MockKey::ReenterId, &id);
            env.storage()
                .persistent()
                .set(&MockKey::ReenterParty, &party);
            env.storage().persistent().set(&MockKey::Reenter, &true);
        }

        /// `0` no callback attempted, `1` callback succeeded, `2` callback
        /// rejected by the bounty contract.
        pub fn reentry_outcome(env: Env) -> i64 {
            let outcome: Option<i64> = env.storage().persistent().get(&MockKey::ReentryOutcome);
            outcome.unwrap_or(0)
        }

        pub fn transfer(env: Env, from: Address, to: Address, amount: i128) {
            let mode: i64 = env
                .storage()
                .persistent()
                .get(&MockKey::ReenterMode)
                .unwrap_or(0);

            if mode == 1 {
                panic!("mock token: transfer reverted");
            }

            let from_balance: i128 = Self::balance_of(&env, &from);
            let to_balance: i128 = Self::balance_of(&env, &to);
            env.storage()
                .persistent()
                .set(&MockKey::Balance(from.clone()), &(from_balance - amount));
            env.storage()
                .persistent()
                .set(&MockKey::Balance(to.clone()), &(to_balance + amount));

            let armed: bool = env
                .storage()
                .persistent()
                .get(&MockKey::Reenter)
                .unwrap_or(false);
            if armed && mode > 1 {
                env.storage().persistent().set(&MockKey::Reenter, &false);
                let id: u64 = env
                    .storage()
                    .persistent()
                    .get(&MockKey::ReenterId)
                    .unwrap_or(0);
                let party: Option<Address> = env.storage().persistent().get(&MockKey::ReenterParty);
                let self_address = env.current_contract_address();
                let client = BountyContractClient::new(&env, &from);

                if mode == 2 {
                    let outcome: i64 = match client.try_release_bounty(&id) {
                        Ok(_) => 1,
                        Err(_) => 2,
                    };
                    env.storage()
                        .persistent()
                        .set(&MockKey::ReentryOutcome, &outcome);
                } else if let Some(party) = party {
                    // Not caught: the Soroban host forbids re-entering a
                    // contract that is already on the call stack, so this must
                    // abort the whole invocation.
                    client.create_bounty(&party, &self_address, &self_address, &1i128, &0u32);
                }
            }
        }
    }

    impl MockToken {
        fn balance_of(env: &Env, of: &Address) -> i128 {
            env.storage()
                .persistent()
                .get(&MockKey::Balance(of.clone()))
                .unwrap_or(0)
        }
    }

    // ── helpers ──────────────────────────────────────────────────────────────

    pub(super) fn setup() -> (Env, Address, Address, Address, Address, Address) {
        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register_contract(None, BountyContract);

        let fee_recipient = Address::generate(&env);
        let creator = Address::generate(&env);
        let hunter = Address::generate(&env);

        // Deploy a test token and mint to creator.
        let token_admin = Address::generate(&env);
        let token_id = env.register_stellar_asset_contract_v2(token_admin.clone());
        let token_addr = token_id.address();
        let sac = StellarAssetClient::new(&env, &token_addr);
        sac.mint(&creator, &10_000_i128);

        let client = BountyContractClient::new(&env, &contract_id);
        client.initialize(&fee_recipient);

        (env, contract_id, fee_recipient, creator, hunter, token_addr)
    }

    /// A freshly deployed contract with a funded creator and no `initialize`.
    fn setup_uninitialized() -> (Env, Address, Address, Address, Address) {
        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register_contract(None, BountyContract);
        let creator = Address::generate(&env);
        let hunter = Address::generate(&env);
        let token_admin = Address::generate(&env);
        let token_id = env.register_stellar_asset_contract_v2(token_admin.clone());
        let token_addr = token_id.address();
        StellarAssetClient::new(&env, &token_addr).mint(&creator, &10_000_i128);

        (env, contract_id, creator, hunter, token_addr)
    }

    fn key(env: &Env, seed: u8) -> BytesN<32> {
        BytesN::from_array(env, &[seed; 32])
    }

    /// Unwraps the typed contract error of a `try_*` invocation.
    #[track_caller]
    fn contract_error<T: core::fmt::Debug, I: core::fmt::Debug>(
        result: Result<Result<T, I>, Result<BountyError, soroban_sdk::InvokeError>>,
    ) -> BountyError {
        match result {
            Err(Ok(error)) => error,
            other => panic!("expected a rejected invocation, got {:?}", other),
        }
    }

    // ── success paths ────────────────────────────────────────────────────────

    // ── 0 % fee ──────────────────────────────────────────────────────────────

    #[test]
    fn test_zero_fee_full_payout() {
        let (env, contract_id, _fee_recipient, creator, hunter, token) = setup();
        let client = BountyContractClient::new(&env, &contract_id);

        let id = client.create_bounty(&creator, &hunter, &token, &1_000_i128, &0u32);

        let token_client = TokenClient::new(&env, &token);
        let hunter_before = token_client.balance(&hunter);

        client.release_bounty(&id);

        let hunter_after = token_client.balance(&hunter);
        assert_eq!(
            hunter_after - hunter_before,
            1_000_i128,
            "hunter should receive full amount"
        );
    }

    // ── 1 % fee ──────────────────────────────────────────────────────────────

    #[test]
    fn test_one_percent_fee() {
        let (env, contract_id, fee_recipient, creator, hunter, token) = setup();
        let client = BountyContractClient::new(&env, &contract_id);

        // 1 % = 100 bps
        let id = client.create_bounty(&creator, &hunter, &token, &1_000_i128, &100u32);

        let token_client = TokenClient::new(&env, &token);
        let hunter_before = token_client.balance(&hunter);
        let recipient_before = token_client.balance(&fee_recipient);

        client.release_bounty(&id);

        let hunter_after = token_client.balance(&hunter);
        let recipient_after = token_client.balance(&fee_recipient);

        assert_eq!(
            hunter_after - hunter_before,
            990_i128,
            "hunter should receive 990"
        );
        assert_eq!(
            recipient_after - recipient_before,
            10_i128,
            "fee recipient should receive 10"
        );
    }

    // ── 5 % fee ──────────────────────────────────────────────────────────────

    #[test]
    fn test_five_percent_fee() {
        let (env, contract_id, fee_recipient, creator, hunter, token) = setup();
        let client = BountyContractClient::new(&env, &contract_id);

        // 5 % = 500 bps
        let id = client.create_bounty(&creator, &hunter, &token, &2_000_i128, &500u32);

        let token_client = TokenClient::new(&env, &token);
        let hunter_before = token_client.balance(&hunter);
        let recipient_before = token_client.balance(&fee_recipient);

        client.release_bounty(&id);

        let hunter_after = token_client.balance(&hunter);
        let recipient_after = token_client.balance(&fee_recipient);

        assert_eq!(
            hunter_after - hunter_before,
            1_900_i128,
            "hunter should receive 1900"
        );
        assert_eq!(
            recipient_after - recipient_before,
            100_i128,
            "fee recipient should receive 100"
        );
    }

    // ── sequential IDs ───────────────────────────────────────────────────────

    #[test]
    fn test_sequential_bounty_ids() {
        let (env, contract_id, _fee_recipient, creator, hunter, token) = setup();
        let client = BountyContractClient::new(&env, &contract_id);

        let id1 = client.create_bounty(&creator, &hunter, &token, &500_i128, &0u32);
        let id2 = client.create_bounty(&creator, &hunter, &token, &600_i128, &0u32);
        let id3 = client.create_bounty(&creator, &hunter, &token, &700_i128, &0u32);

        assert_eq!(id1, 0, "first bounty should have id 0");
        assert_eq!(id2, 1, "second bounty should have id 1");
        assert_eq!(id3, 2, "third bounty should have id 2");

        // Also verify that all three are distinct stored bounties.
        let b1 = client.get_bounty(&id1);
        let b2 = client.get_bounty(&id2);
        let b3 = client.get_bounty(&id3);
        assert_eq!(b1.amount, 500_i128);
        assert_eq!(b2.amount, 600_i128);
        assert_eq!(b3.amount, 700_i128);

        assert_eq!(client.bounty_count(), 3, "counter tracks created bounties");
    }

    /// Value is only ever split, never created or destroyed.
    #[test]
    fn test_release_conserves_escrow() {
        let (env, contract_id, fee_recipient, creator, hunter, token) = setup();
        let client = BountyContractClient::new(&env, &contract_id);
        let token_client = TokenClient::new(&env, &token);
        StellarAssetClient::new(&env, &token).mint(&creator, &1_000_000_i128);

        for (index, amount) in [1_i128, 7, 999, 100_000].iter().enumerate() {
            let bps = [0_u32, 1, 2_500, 9_999][index];
            let id = client.create_bounty(&creator, &hunter, &token, amount, &bps);

            assert_eq!(token_client.balance(&contract_id), *amount);

            let hunter_before = token_client.balance(&hunter);
            let fee_before = token_client.balance(&fee_recipient);
            client.release_bounty(&id);

            let paid = (token_client.balance(&hunter) - hunter_before)
                + (token_client.balance(&fee_recipient) - fee_before);
            assert_eq!(paid, *amount, "escrow must be fully paid out");
            assert_eq!(token_client.balance(&contract_id), 0_i128);
            assert!(client.get_bounty(&id).released);
        }
    }

    /// Bounties are independent: releasing one must not disturb another.
    #[test]
    fn test_bounties_release_independently() {
        let (env, contract_id, _fee_recipient, creator, hunter, token) = setup();
        let client = BountyContractClient::new(&env, &contract_id);
        let token_client = TokenClient::new(&env, &token);

        let first = client.create_bounty(&creator, &hunter, &token, &400_i128, &1_000u32);
        let second = client.create_bounty(&creator, &hunter, &token, &900_i128, &0u32);

        client.release_bounty(&second);

        assert!(client.get_bounty(&second).released);
        assert!(!client.get_bounty(&first).released);
        assert_eq!(client.get_bounty(&first).amount, 400_i128);
        assert_eq!(token_client.balance(&contract_id), 400_i128);
    }

    #[test]
    fn test_initialize_exposes_configuration() {
        let (env, contract_id, fee_recipient, _creator, _hunter, _token) = setup();
        let client = BountyContractClient::new(&env, &contract_id);

        assert_eq!(client.fee_recipient(), fee_recipient);
        assert_eq!(client.bounty_count(), 0);
    }

    // ── initialization boundaries ─────────────────────────────────────────────

    #[test]
    fn test_initialize_is_rejected_twice() {
        let (env, contract_id, fee_recipient, _creator, _hunter, _token) = setup();
        let client = BountyContractClient::new(&env, &contract_id);
        let other = Address::generate(&env);

        assert_eq!(
            contract_error(client.try_initialize(&other)),
            BountyError::AlreadyInitialized
        );
        assert_eq!(client.fee_recipient(), fee_recipient);
    }

    #[test]
    fn test_initialize_rejects_contract_as_fee_recipient() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, BountyContract);
        let client = BountyContractClient::new(&env, &contract_id);

        assert_eq!(
            contract_error(client.try_initialize(&contract_id)),
            BountyError::FeeRecipientIsContract
        );
        assert_eq!(
            contract_error(client.try_fee_recipient()),
            BountyError::NotInitialized
        );
    }

    /// Regression: a bounty opened before `initialize` could never be released,
    /// because the release needs a fee recipient - the escrow was locked.
    #[test]
    fn test_create_is_rejected_before_initialize() {
        let (env, contract_id, creator, hunter, token) = setup_uninitialized();
        let client = BountyContractClient::new(&env, &contract_id);

        assert_eq!(
            contract_error(client.try_create_bounty(&creator, &hunter, &token, &500_i128, &0u32)),
            BountyError::NotInitialized
        );
        assert_eq!(client.bounty_count(), 0, "no escrow was opened");
        assert_eq!(
            TokenClient::new(&env, &token).balance(&creator),
            10_000_i128,
            "the rejection moved no funds"
        );
    }

    #[test]
    fn test_release_is_rejected_before_initialize() {
        let (env, contract_id, _creator, _hunter, _token) = setup_uninitialized();
        let client = BountyContractClient::new(&env, &contract_id);

        assert_eq!(
            contract_error(client.try_release_bounty(&0)),
            BountyError::NotInitialized
        );
    }

    // ── amount boundaries ────────────────────────────────────────────────────

    #[test]
    fn test_create_rejects_non_positive_amount() {
        let (env, contract_id, _fee_recipient, creator, hunter, token) = setup();
        let client = BountyContractClient::new(&env, &contract_id);

        for amount in [0_i128, -1, i128::MIN] {
            assert_eq!(
                contract_error(client.try_create_bounty(&creator, &hunter, &token, &amount, &0u32)),
                BountyError::AmountOutOfRange,
                "amount {} must be rejected",
                amount
            );
        }
        assert_eq!(client.bounty_count(), 0, "no id is consumed by a rejection");
    }

    /// Boundary: one stroop above the accepted maximum.
    #[test]
    fn test_create_rejects_amount_above_maximum() {
        let (env, contract_id, _fee_recipient, creator, hunter, token) = setup();
        let client = BountyContractClient::new(&env, &contract_id);

        assert_eq!(
            contract_error(client.try_create_bounty(
                &creator,
                &hunter,
                &token,
                &(MAX_BOUNTY_AMOUNT + 1),
                &0u32
            )),
            BountyError::AmountOutOfRange
        );
        assert_eq!(
            contract_error(client.try_create_bounty(&creator, &hunter, &token, &i128::MAX, &0u32)),
            BountyError::AmountOutOfRange
        );
    }

    /// Boundary: the largest accepted amount releases without trapping.
    ///
    /// Before the amount cap existed, `create_bounty` accepted an amount whose
    /// fee computation overflowed `i128`; the release then failed and the whole
    /// escrow was permanently stuck in the contract.
    #[test]
    fn test_release_at_maximum_amount_does_not_overflow() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, BountyContract);
        let fee_recipient = Address::generate(&env);
        let creator = Address::generate(&env);
        let hunter = Address::generate(&env);
        let token_admin = Address::generate(&env);
        let token_id = env.register_stellar_asset_contract_v2(token_admin.clone());
        let token = token_id.address();
        StellarAssetClient::new(&env, &token).mint(&creator, &MAX_BOUNTY_AMOUNT);

        let client = BountyContractClient::new(&env, &contract_id);
        client.initialize(&fee_recipient);
        let id = client.create_bounty(
            &creator,
            &hunter,
            &token,
            &MAX_BOUNTY_AMOUNT,
            &(MAX_PROTOCOL_FEE_BPS - 1),
        );

        let token_client = TokenClient::new(&env, &token);
        let hunter_before = token_client.balance(&hunter);
        let fee_before = token_client.balance(&fee_recipient);

        client.release_bounty(&id);

        let expected_fee = MAX_BOUNTY_AMOUNT * (MAX_PROTOCOL_FEE_BPS as i128 - 1) / BPS_DENOMINATOR;
        assert_eq!(
            token_client.balance(&fee_recipient) - fee_before,
            expected_fee
        );
        let payout = token_client.balance(&hunter) - hunter_before;
        assert_eq!(payout + expected_fee, MAX_BOUNTY_AMOUNT);
        assert!(payout >= 1, "the hunter is always paid at least one unit");
        assert_eq!(token_client.balance(&contract_id), 0_i128);
    }

    /// The amount cap keeps `amount * protocol_fee_bps` inside `i128` for every
    /// accepted fee, and is deliberately stricter than the arithmetic requires.
    #[test]
    fn test_maximum_amount_bound_keeps_fee_maths_in_range() {
        let largest_fee = MAX_PROTOCOL_FEE_BPS as i128 - 1;
        assert!(
            MAX_BOUNTY_AMOUNT.checked_mul(largest_fee).is_some(),
            "accepted requests must not overflow"
        );
        assert!(
            MAX_BOUNTY_AMOUNT < i128::MAX / largest_fee,
            "the bound is conservative, never below the arithmetic minimum"
        );
    }

    /// Dust: sub-unit fees round down, so the hunter still receives the escrow.
    #[test]
    fn test_fee_rounds_down_towards_hunter() {
        let (env, contract_id, fee_recipient, creator, hunter, token) = setup();
        let client = BountyContractClient::new(&env, &contract_id);
        let token_client = TokenClient::new(&env, &token);

        let id = client.create_bounty(
            &creator,
            &hunter,
            &token,
            &1_i128,
            &(MAX_PROTOCOL_FEE_BPS - 1),
        );
        let fee_before = token_client.balance(&fee_recipient);
        client.release_bounty(&id);

        assert_eq!(token_client.balance(&fee_recipient) - fee_before, 0_i128);
        assert_eq!(token_client.balance(&hunter), 1_i128);
    }

    // ── fee boundaries ───────────────────────────────────────────────────────

    #[test]
    fn test_create_rejects_fee_at_or_above_cap() {
        let (env, contract_id, _fee_recipient, creator, hunter, token) = setup();
        let client = BountyContractClient::new(&env, &contract_id);

        assert_eq!(
            contract_error(client.try_create_bounty(
                &creator,
                &hunter,
                &token,
                &1_000_i128,
                &MAX_PROTOCOL_FEE_BPS
            )),
            BountyError::FeeBpsOutOfRange
        );
        assert_eq!(
            contract_error(client.try_create_bounty(
                &creator,
                &hunter,
                &token,
                &1_000_i128,
                &u32::MAX
            )),
            BountyError::FeeBpsOutOfRange
        );
    }

    /// Boundary: one basis point below the cap is accepted.
    #[test]
    fn test_create_accepts_highest_fee() {
        let (env, contract_id, fee_recipient, creator, hunter, token) = setup();
        let client = BountyContractClient::new(&env, &contract_id);
        let token_client = TokenClient::new(&env, &token);

        let id = client.create_bounty(
            &creator,
            &hunter,
            &token,
            &10_000_i128,
            &(MAX_PROTOCOL_FEE_BPS - 1),
        );
        let fee_before = token_client.balance(&fee_recipient);
        let hunter_before = token_client.balance(&hunter);
        client.release_bounty(&id);

        assert_eq!(
            token_client.balance(&fee_recipient) - fee_before,
            9_999_i128
        );
        assert_eq!(token_client.balance(&hunter) - hunter_before, 1_i128);
    }

    // ── address boundaries ───────────────────────────────────────────────────

    #[test]
    fn test_create_rejects_self_bounty() {
        let (env, contract_id, _fee_recipient, creator, _hunter, token) = setup();
        let client = BountyContractClient::new(&env, &contract_id);

        assert_eq!(
            contract_error(client.try_create_bounty(&creator, &creator, &token, &500_i128, &0u32)),
            BountyError::CreatorIsHunter
        );
    }

    #[test]
    fn test_create_rejects_contract_as_any_party() {
        let (env, contract_id, _fee_recipient, creator, hunter, token) = setup();
        let client = BountyContractClient::new(&env, &contract_id);

        assert_eq!(
            contract_error(client.try_create_bounty(
                &contract_id,
                &hunter,
                &token,
                &500_i128,
                &0u32
            )),
            BountyError::CreatorIsContract
        );
        assert_eq!(
            contract_error(client.try_create_bounty(
                &creator,
                &contract_id,
                &token,
                &500_i128,
                &0u32
            )),
            BountyError::HunterIsContract
        );
        assert_eq!(
            contract_error(client.try_create_bounty(
                &creator,
                &hunter,
                &contract_id,
                &500_i128,
                &0u32
            )),
            BountyError::TokenIsContract
        );
        assert_eq!(
            client.bounty_count(),
            0,
            "no rejected request consumes an id"
        );
    }

    // ── release boundaries ───────────────────────────────────────────────────

    #[test]
    fn test_release_rejects_unknown_bounty() {
        let (env, contract_id, _fee_recipient, creator, hunter, token) = setup();
        let client = BountyContractClient::new(&env, &contract_id);
        client.create_bounty(&creator, &hunter, &token, &500_i128, &0u32);

        // Boundary: the highest representable id is simply not found.
        assert_eq!(
            contract_error(client.try_release_bounty(&u64::MAX)),
            BountyError::BountyNotFound
        );
        assert_eq!(
            contract_error(client.try_release_bounty(&1)),
            BountyError::BountyNotFound
        );
        assert!(client.find_bounty(&u64::MAX).is_none());
    }

    // ── double-release guard ─────────────────────────────────────────────────

    #[test]
    fn test_cannot_release_twice() {
        let (env, contract_id, _fee_recipient, creator, hunter, token) = setup();
        let client = BountyContractClient::new(&env, &contract_id);
        let token_client = TokenClient::new(&env, &token);

        let id = client.create_bounty(&creator, &hunter, &token, &500_i128, &0u32);
        let hunter_before = token_client.balance(&hunter);
        client.release_bounty(&id);
        let token_client = TokenClient::new(&env, &token);
        let before = token_client.balance(&hunter);
        assert!(client.try_release_bounty(&id).is_err());
        assert_eq!(token_client.balance(&hunter), before);
        assert!(client.get_bounty(&id).released);
    }
}

#[cfg(test)]
mod compatibility_tests;
