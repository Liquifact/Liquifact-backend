use super::tests::setup;
use super::*;
extern crate std;
use soroban_sdk::{
    testutils::{Address as _, Events as _},
    token::{Client as TokenClient, StellarAssetClient},
    vec,
    xdr::ToXdr,
    Address, Env, IntoVal, Map, Val,
};

#[cfg(feature = "wasm-tests")]
#[test]
fn compiled_wasm_preserves_validated_lifecycle_and_maximum_amount() {
    let env = Env::default();
    env.mock_all_auths();
    let wasm = include_bytes!("../target/wasm32v1-none/release/liquifact_bounty.wasm");
    let contract = env.register_contract_wasm(None, &wasm[..]);
    let creator = Address::generate(&env);
    let hunter = Address::generate(&env);
    let recipient = Address::generate(&env);
    let token = env
        .register_stellar_asset_contract_v2(Address::generate(&env))
        .address();
    let asset = StellarAssetClient::new(&env, &token);
    asset.mint(&creator, &MAX_BOUNTY_AMOUNT);
    let client = BountyContractClient::new(&env, &contract);
    client.initialize(&recipient);
    let first = client.create_bounty(&creator, &hunter, &token, &MAX_BOUNTY_AMOUNT, &500);
    assert_eq!(first, 0);
    client.release_bounty(&first);
    let balances = TokenClient::new(&env, &token);
    let fee = MAX_BOUNTY_AMOUNT / 20;
    assert_eq!(balances.balance(&recipient), fee);
    assert_eq!(balances.balance(&hunter), MAX_BOUNTY_AMOUNT - fee);
    assert_eq!(balances.balance(&contract), 0);
    assert!(client.get_bounty(&first).released);
    asset.mint(&creator, &1);
    assert_eq!(client.create_bounty(&creator, &hunter, &token, &1, &0), 1);
    assert_eq!(client.get_bounty(&first).amount, MAX_BOUNTY_AMOUNT);
}

// A token that fails on the hunter transfer lets us exercise a failure after
// the fee leg succeeds. This is a test double, never deployed by the contract.
#[contract]
struct FailingToken;

#[contractimpl]
impl FailingToken {
    pub fn configure(env: Env, reject: Address) {
        env.storage()
            .instance()
            .set(&Symbol::new(&env, "reject"), &reject);
    }

    pub fn transfer(env: Env, from: Address, to: Address, amount: i128) {
        let reject: Address = env
            .storage()
            .instance()
            .get(&Symbol::new(&env, "reject"))
            .unwrap();
        assert!(to != reject, "payout rejected");
        let sent: i128 = env.storage().persistent().get(&from).unwrap_or(0);
        let received: i128 = env.storage().persistent().get(&to).unwrap_or(0);
        env.storage().persistent().set(&from, &(sent - amount));
        env.storage().persistent().set(&to, &(received + amount));
    }

    pub fn balance(env: Env, address: Address) -> i128 {
        env.storage().persistent().get(&address).unwrap_or(0)
    }
}

#[test]
fn initialization_preserves_preexisting_bounty_counter() {
    let env = Env::default();
    env.mock_all_auths();
    let contract = env.register_contract(None, BountyContract);
    let creator = Address::generate(&env);
    let hunter = Address::generate(&env);
    let recipient = Address::generate(&env);
    let admin = Address::generate(&env);
    let token = env.register_stellar_asset_contract_v2(admin).address();
    StellarAssetClient::new(&env, &token).mint(&creator, &300);
    let client = BountyContractClient::new(&env, &contract);
    env.as_contract(&contract, || {
        env.storage().instance().set(&DataKey::NextId, &1u64);
        env.storage().persistent().set(
            &DataKey::Bounty(0),
            &Bounty {
                creator: creator.clone(),
                hunter: hunter.clone(),
                token: token.clone(),
                amount: 100,
                protocol_fee_bps: 0,
                released: false,
            },
        );
    });
    TokenClient::new(&env, &token).transfer(&creator, &contract, &100);
    client.initialize(&recipient);
    let second = client.create_bounty(&creator, &hunter, &token, &200, &0);
    assert_eq!(second, 1);
    assert_eq!(client.get_bounty(&0).amount, 100);
    client.release_bounty(&0);
    client.release_bounty(&second);
    assert_eq!(TokenClient::new(&env, &token).balance(&hunter), 300);
}

#[test]
fn reinitialization_does_not_change_recipient_or_counter() {
    let (env, contract, recipient, creator, hunter, token) = setup();
    let client = BountyContractClient::new(&env, &contract);
    let id = client.create_bounty(&creator, &hunter, &token, &100, &100);
    assert!(client.try_initialize(&Address::generate(&env)).is_err());
    assert_eq!(client.create_bounty(&creator, &hunter, &token, &100, &0), 1);
    client.release_bounty(&id);
    assert_eq!(TokenClient::new(&env, &token).balance(&recipient), 1);
}

#[test]
fn maximum_amount_fee_does_not_overflow() {
    let (env, contract, recipient, creator, hunter, token) = setup();
    StellarAssetClient::new(&env, &token).mint(&creator, &(MAX_BOUNTY_AMOUNT - 10_000));
    let client = BountyContractClient::new(&env, &contract);
    let id = client.create_bounty(&creator, &hunter, &token, &MAX_BOUNTY_AMOUNT, &500);
    client.release_bounty(&id);
    let expected_fee = MAX_BOUNTY_AMOUNT / 20;
    let balances = TokenClient::new(&env, &token);
    assert_eq!(balances.balance(&recipient), expected_fee);
    assert_eq!(balances.balance(&hunter), MAX_BOUNTY_AMOUNT - expected_fee);
    assert_eq!(balances.balance(&contract), 0);
    assert!(client.get_bounty(&id).released);
}

#[test]
fn rounding_and_fee_boundaries_preserve_total_amount() {
    for (amount, bps, expected_fee) in [
        (1, 0, 0),
        (1, 1, 0),
        (19, 500, 0),
        (21, 500, 1),
        (101, 9_999, 100),
    ] {
        let (env, contract, recipient, creator, hunter, token) = setup();
        let client = BountyContractClient::new(&env, &contract);
        let id = client.create_bounty(&creator, &hunter, &token, &amount, &bps);
        client.release_bounty(&id);
        let balances = TokenClient::new(&env, &token);
        assert_eq!(balances.balance(&recipient), expected_fee);
        assert_eq!(balances.balance(&hunter), amount - expected_fee);
        assert_eq!(balances.balance(&contract), 0);
    }
}

#[test]
fn invalid_creation_does_not_spend_funds_or_consume_id() {
    let (env, contract, _, creator, hunter, token) = setup();
    let client = BountyContractClient::new(&env, &contract);
    for (amount, bps) in [(0, 0), (-1, 0), (i128::MIN, 0), (1, 10_001), (1, u32::MAX)] {
        assert!(client
            .try_create_bounty(&creator, &hunter, &token, &amount, &bps)
            .is_err());
        assert_eq!(TokenClient::new(&env, &token).balance(&creator), 10_000);
        assert_eq!(TokenClient::new(&env, &token).balance(&contract), 0);
    }
    assert_eq!(client.create_bounty(&creator, &hunter, &token, &1, &0), 0);
}

#[test]
fn insufficient_funds_roll_back_creation_and_id() {
    let (env, contract, _, creator, hunter, token) = setup();
    let client = BountyContractClient::new(&env, &contract);
    assert!(client
        .try_create_bounty(&creator, &hunter, &token, &10_001, &0)
        .is_err());
    assert!(client.try_get_bounty(&0).is_err());
    assert_eq!(TokenClient::new(&env, &token).balance(&creator), 10_000);
    assert_eq!(client.create_bounty(&creator, &hunter, &token, &1, &0), 0);
}

#[test]
fn inconsistent_or_missing_counter_cannot_overwrite_legacy_bounty() {
    for missing in [false, true] {
        let (env, contract, _, creator, hunter, token) = setup();
        let client = BountyContractClient::new(&env, &contract);
        client.create_bounty(&creator, &hunter, &token, &100, &0);
        env.as_contract(&contract, || {
            if missing {
                env.storage().instance().remove(&DataKey::NextId);
            } else {
                env.storage().instance().set(&DataKey::NextId, &0u64);
            }
        });
        assert!(client
            .try_create_bounty(&creator, &hunter, &token, &200, &0)
            .is_err());
        assert_eq!(client.get_bounty(&0).amount, 100);
        assert_eq!(TokenClient::new(&env, &token).balance(&contract), 100);
        assert_eq!(TokenClient::new(&env, &token).balance(&creator), 9_900);
        client.release_bounty(&0);
        assert_eq!(TokenClient::new(&env, &token).balance(&hunter), 100);
    }
}

#[test]
fn exhausted_id_rejects_before_transfer() {
    let (env, contract, _, creator, hunter, token) = setup();
    let client = BountyContractClient::new(&env, &contract);
    env.as_contract(&contract, || {
        env.storage().instance().set(&DataKey::NextId, &u64::MAX)
    });
    assert!(client
        .try_create_bounty(&creator, &hunter, &token, &1, &0)
        .is_err());
    assert_eq!(TokenClient::new(&env, &token).balance(&creator), 10_000);
    assert!(client.try_get_bounty(&u64::MAX).is_err());
}

#[test]
fn missing_bounty_and_uninitialized_release_are_rejected() {
    let (env, contract, _, creator, hunter, token) = setup();
    let client = BountyContractClient::new(&env, &contract);
    assert!(client.try_release_bounty(&0).is_err());
    assert!(client.try_get_bounty(&u64::MAX).is_err());
    let id = client.create_bounty(&creator, &hunter, &token, &100, &0);
    env.as_contract(&contract, || {
        env.storage().instance().remove(&DataKey::FeeRecipient)
    });
    assert!(client.try_release_bounty(&id).is_err());
    assert!(!client.get_bounty(&id).released);
    assert_eq!(TokenClient::new(&env, &token).balance(&contract), 100);
}

#[test]
fn malformed_legacy_records_fail_before_transfers() {
    for (amount, bps) in [(0, 0), (-1, 0), (100, 10_001)] {
        let (env, contract, _, creator, hunter, token) = setup();
        let client = BountyContractClient::new(&env, &contract);
        let id = client.create_bounty(&creator, &hunter, &token, &100, &0);
        env.as_contract(&contract, || {
            let mut record: Bounty = env
                .storage()
                .persistent()
                .get(&DataKey::Bounty(id))
                .unwrap();
            record.amount = amount;
            record.protocol_fee_bps = bps;
            env.storage()
                .persistent()
                .set(&DataKey::Bounty(id), &record);
        });
        assert!(client.try_release_bounty(&id).is_err());
        assert!(!client.get_bounty(&id).released);
        assert_eq!(TokenClient::new(&env, &token).balance(&contract), 100);
        assert_eq!(TokenClient::new(&env, &token).balance(&hunter), 0);
    }
}

#[test]
fn payout_failure_rolls_back_fee_flag_and_allows_retry() {
    let (env, contract, recipient, creator, hunter, _) = setup();
    let token = env.register_contract(None, FailingToken);
    let token_client = FailingTokenClient::new(&env, &token);
    token_client.configure(&hunter);
    let client = BountyContractClient::new(&env, &contract);
    let id = client.create_bounty(&creator, &hunter, &token, &1_000, &100);
    let events_before = env.events().all().to_xdr(&env);
    assert!(client.try_release_bounty(&id).is_err());
    assert_eq!(env.events().all().to_xdr(&env), events_before);
    assert!(!client.get_bounty(&id).released);
    assert_eq!(token_client.balance(&contract), 1_000);
    assert_eq!(token_client.balance(&recipient), 0);
    assert_eq!(token_client.balance(&hunter), 0);
    token_client.configure(&Address::generate(&env));
    client.release_bounty(&id);
    assert!(client.get_bounty(&id).released);
    assert_eq!(token_client.balance(&recipient), 10);
    assert_eq!(token_client.balance(&hunter), 990);
    assert_eq!(token_client.balance(&contract), 0);
}

#[test]
fn creator_authorization_is_required_for_create_and_release() {
    let (env, contract, _, creator, hunter, token) = setup();
    let client = BountyContractClient::new(&env, &contract);
    let id = client.create_bounty(&creator, &hunter, &token, &100, &0);
    let unauthenticated_token = env.register_contract(None, FailingToken);
    FailingTokenClient::new(&env, &unauthenticated_token).configure(&hunter);
    // Switch from blanket test authorization to an empty explicit set.
    env.mock_auths(&[]);
    // This test token does not require auth itself, so it cannot mask a
    // missing require_auth in create_bounty.
    assert!(client
        .try_create_bounty(&creator, &hunter, &unauthenticated_token, &100, &0)
        .is_err());
    assert!(client.try_release_bounty(&id).is_err());
    assert!(!client.get_bounty(&id).released);
    assert_eq!(TokenClient::new(&env, &token).balance(&contract), 100);
}

#[test]
fn legacy_storage_encoding_and_records_remain_compatible() {
    let (env, contract, _, creator, hunter, token) = setup();
    let legacy_key: soroban_sdk::Vec<Val> = vec![
        &env,
        Symbol::new(&env, "Bounty").into_val(&env),
        7u64.into_val(&env),
    ];
    let legacy_record: Map<Symbol, Val> = Map::from_array(
        &env,
        [
            (Symbol::new(&env, "creator"), creator.into_val(&env)),
            (Symbol::new(&env, "hunter"), hunter.into_val(&env)),
            (Symbol::new(&env, "token"), token.into_val(&env)),
            (Symbol::new(&env, "amount"), 100i128.into_val(&env)),
            (Symbol::new(&env, "protocol_fee_bps"), 100u32.into_val(&env)),
            (Symbol::new(&env, "released"), false.into_val(&env)),
        ],
    );
    assert_eq!(
        DataKey::Bounty(7).to_xdr(&env),
        legacy_key.clone().to_xdr(&env)
    );
    let recipient_key: soroban_sdk::Vec<Val> =
        vec![&env, Symbol::new(&env, "FeeRecipient").into_val(&env)];
    let counter_key: soroban_sdk::Vec<Val> = vec![&env, Symbol::new(&env, "NextId").into_val(&env)];
    assert_eq!(
        DataKey::FeeRecipient.to_xdr(&env),
        recipient_key.to_xdr(&env)
    );
    assert_eq!(DataKey::NextId.to_xdr(&env), counter_key.to_xdr(&env));
    env.as_contract(&contract, || {
        env.storage().persistent().set(&legacy_key, &legacy_record)
    });
    TokenClient::new(&env, &token).transfer(&creator, &contract, &100);
    let client = BountyContractClient::new(&env, &contract);
    assert_eq!(
        client.get_bounty(&7).to_xdr(&env),
        legacy_record.to_xdr(&env)
    );
    client.release_bounty(&7);
    assert!(client.get_bounty(&7).released);
    assert_eq!(TokenClient::new(&env, &token).balance(&hunter), 99);
}

#[test]
fn lifecycle_event_topics_and_payloads_remain_compatible() {
    let (env, contract, _, creator, hunter, token) = setup();
    let client = BountyContractClient::new(&env, &contract);
    let id = client.create_bounty(&creator, &hunter, &token, &1_000, &100);
    client.release_bounty(&id);
    let events = env.events().all();
    let mut bounty_events = events.iter().filter(|(address, _, _)| address == &contract);
    let (_, created_topics, created_data) = bounty_events.next().unwrap();
    let (_, released_topics, released_data) = bounty_events.next().unwrap();
    assert!(bounty_events.next().is_none());
    let expected_created: soroban_sdk::Vec<Val> = vec![
        &env,
        Symbol::new(&env, "bounty_created").into_val(&env),
        id.into_val(&env),
    ];
    let expected_released: soroban_sdk::Vec<Val> = vec![
        &env,
        Symbol::new(&env, "bounty_released").into_val(&env),
        id.into_val(&env),
    ];
    assert_eq!(created_topics.to_xdr(&env), expected_created.to_xdr(&env));
    assert_eq!(created_data.to_xdr(&env), 1_000i128.to_xdr(&env));
    assert_eq!(released_topics.to_xdr(&env), expected_released.to_xdr(&env));
    assert_eq!(released_data.to_xdr(&env), (990i128, 10i128).to_xdr(&env));
}

#[test]
fn public_function_specs_keep_legacy_argument_order_and_types() {
    use soroban_sdk::xdr::{
        Limits, ReadXdr, ScSpecEntry, ScSpecTypeDef, ScSpecTypeResult, ScSpecTypeTuple,
        ScSpecTypeUdt,
    };
    use std::boxed::Box;
    let result_void = ScSpecTypeDef::Result(Box::new(ScSpecTypeResult {
        ok_type: Box::new(ScSpecTypeDef::Tuple(Box::new(ScSpecTypeTuple {
            value_types: Default::default(),
        }))),
        error_type: Box::new(ScSpecTypeDef::Udt(ScSpecTypeUdt {
            name: "BountyError".try_into().unwrap(),
        })),
    }));
    let result_u64 = ScSpecTypeDef::Result(Box::new(ScSpecTypeResult {
        ok_type: Box::new(ScSpecTypeDef::U64),
        error_type: Box::new(ScSpecTypeDef::Udt(ScSpecTypeUdt {
            name: "BountyError".try_into().unwrap(),
        })),
    }));
    fn check(
        bytes: &[u8],
        name: &str,
        inputs: &[(&str, ScSpecTypeDef)],
        outputs: &[ScSpecTypeDef],
    ) {
        let ScSpecEntry::FunctionV0(spec) = ScSpecEntry::from_xdr(bytes, Limits::none()).unwrap()
        else {
            panic!("expected function specification");
        };
        assert_eq!(spec.name.to_utf8_string().unwrap(), name);
        assert_eq!(spec.inputs.len(), inputs.len());
        for (input, (name, kind)) in spec.inputs.iter().zip(inputs) {
            assert_eq!(input.name.to_utf8_string().unwrap(), *name);
            assert_eq!(&input.type_, kind);
        }
        assert_eq!(&spec.outputs[..], outputs);
    }
    check(
        &BountyContract::spec_xdr_initialize(),
        "initialize",
        &[("fee_recipient", ScSpecTypeDef::Address)],
        std::slice::from_ref(&result_void),
    );
    check(
        &BountyContract::spec_xdr_create_bounty(),
        "create_bounty",
        &[
            ("creator", ScSpecTypeDef::Address),
            ("hunter", ScSpecTypeDef::Address),
            ("token", ScSpecTypeDef::Address),
            ("amount", ScSpecTypeDef::I128),
            ("protocol_fee_bps", ScSpecTypeDef::U32),
        ],
        &[result_u64],
    );
    check(
        &BountyContract::spec_xdr_release_bounty(),
        "release_bounty",
        &[("id", ScSpecTypeDef::U64)],
        &[result_void],
    );
    let ScSpecEntry::FunctionV0(spec) =
        ScSpecEntry::from_xdr(BountyContract::spec_xdr_get_bounty(), Limits::none()).unwrap()
    else {
        panic!("expected get_bounty specification");
    };
    assert_eq!(spec.name.to_utf8_string().unwrap(), "get_bounty");
    assert_eq!(spec.inputs.len(), 1);
    assert_eq!(spec.inputs[0].name.to_utf8_string().unwrap(), "id");
    assert_eq!(spec.inputs[0].type_, ScSpecTypeDef::U64);
    assert_eq!(spec.outputs.len(), 1);
    let ScSpecTypeDef::Udt(output) = &spec.outputs[0] else {
        panic!("expected Bounty return type");
    };
    assert_eq!(output.name.to_utf8_string().unwrap(), "Bounty");
}
