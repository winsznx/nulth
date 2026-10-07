//! P1 distinct-error matrix. Calls __check_auth directly with committed fixtures
//! (scripts/gen_fixture.mjs) so the FULL matrix runs with no proving stack. The
//! on-chain host wraps every __check_auth failure as Error(Auth, InvalidAction),
//! so these direct calls are where each distinct AccError code is proven.
#![cfg(test)]
extern crate std;

use crate::fixture_data as fx;
use crate::{AccError, Bn254G1Affine, Bn254G2Affine, NulthAccount, NulthAccountClient, ProofSig, VerificationKey};
use soroban_sdk::{
    auth::{Context, ContractContext, CustomAccountInterface},
    testutils::{Address as _, Ledger as _},
    vec, Address, Bytes, BytesN, Env, IntoVal, Symbol, U256, Vec,
};

// Test-wide epoch/timelock config: window + cap generous enough that single-spend
// tests never trip the budget; per-test overrides use `register_full`.
const EPOCH_LEN: u32 = 100_000;
const EPOCH_CAP: i128 = 1_000_000_000; // 100x the fixture AMOUNT
const ROT_DELAY: u32 = 10;

fn unhex(s: &str) -> std::vec::Vec<u8> {
    (0..s.len()).step_by(2).map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap()).collect()
}
fn b64(e: &Env, s: &str) -> BytesN<64> {
    let mut a = [0u8; 64];
    a.copy_from_slice(&unhex(s));
    BytesN::from_array(e, &a)
}
fn b128(e: &Env, s: &str) -> BytesN<128> {
    let mut a = [0u8; 128];
    a.copy_from_slice(&unhex(s));
    BytesN::from_array(e, &a)
}
fn u256h(e: &Env, s: &str) -> U256 {
    let mut a = [0u8; 32];
    a.copy_from_slice(&unhex(s));
    U256::from_be_bytes(e, &Bytes::from_array(e, &a))
}
fn vk(e: &Env) -> VerificationKey {
    let mut ic = Vec::new(e);
    for h in fx::VK_IC.iter() {
        ic.push_back(Bn254G1Affine::from_bytes(b64(e, h)));
    }
    VerificationKey {
        alpha: Bn254G1Affine::from_bytes(b64(e, fx::VK_ALPHA)),
        beta: Bn254G2Affine::from_bytes(b128(e, fx::VK_BETA)),
        gamma: Bn254G2Affine::from_bytes(b128(e, fx::VK_GAMMA)),
        delta: Bn254G2Affine::from_bytes(b128(e, fx::VK_DELTA)),
        ic,
    }
}
fn pub_signals(e: &Env) -> Vec<U256> {
    let mut v = Vec::new(e);
    for h in fx::PUB.iter() {
        v.push_back(u256h(e, h));
    }
    v
}
fn proofsig(e: &Env) -> ProofSig {
    ProofSig { a: b64(e, fx::PROOF_A), b: b128(e, fx::PROOF_B), c: b64(e, fx::PROOF_C), pub_signals: pub_signals(e) }
}
fn register(e: &Env, commitment: U256, root: U256) -> Address {
    register_with_admin(e, commitment, root, &Address::generate(e))
}
fn register_with_admin(e: &Env, commitment: U256, root: U256, admin: &Address) -> Address {
    register_full(e, commitment, root, admin, EPOCH_LEN, EPOCH_CAP, ROT_DELAY)
}
fn register_full(e: &Env, commitment: U256, root: U256, admin: &Address, epoch_len: u32, epoch_cap: i128, rot_delay: u32) -> Address {
    let token = Address::from_str(e, fx::TOKEN);
    e.register(NulthAccount, (vk(e), commitment, root, token, admin.clone(), epoch_len, epoch_cap, rot_delay))
}
fn advance(e: &Env, by: u32) {
    let s = e.ledger().sequence();
    e.ledger().set_sequence_number(s + by);
}
fn one_ctx(e: &Env, contract: &Address, from: &Address, to: &Address, amount: i128) -> Vec<Context> {
    vec![e, Context::Contract(ContractContext {
        contract: contract.clone(),
        fn_name: Symbol::new(e, "transfer"),
        args: vec![e, from.into_val(e), to.into_val(e), amount.into_val(e)],
    })]
}
// the payload the proof was built against: sha256(SEED)
fn good_payload(e: &Env) -> soroban_sdk::crypto::Hash<32> {
    e.crypto().sha256(&Bytes::from_slice(e, fx::PAYLOAD_SEED))
}
fn run(e: &Env, id: &Address, payload: soroban_sdk::crypto::Hash<32>, sig: ProofSig, ctxs: Vec<Context>) -> Result<(), AccError> {
    e.as_contract(id, || <NulthAccount as CustomAccountInterface>::__check_auth(e.clone(), payload, sig, ctxs))
}

// ---- happy path + carry-overs ----

#[test]
fn test_valid_proof_authorized() {
    let e = Env::default();
    let id = register(&e, u256h(&e, fx::COMMITMENT), u256h(&e, fx::ROOT));
    let token = Address::from_str(&e, fx::TOKEN);
    let payee = Address::from_str(&e, fx::PAYEE);
    let r = e.as_contract(&id, || {
        let from = e.current_contract_address();
        let c = one_ctx(&e, &token, &from, &payee, fx::AMOUNT);
        <NulthAccount as CustomAccountInterface>::__check_auth(e.clone(), good_payload(&e), proofsig(&e), c)
    });
    assert_eq!(r, Ok(()));
}

#[test]
fn test_amount_binding() {
    let e = Env::default();
    let id = register(&e, u256h(&e, fx::COMMITMENT), u256h(&e, fx::ROOT));
    let token = Address::from_str(&e, fx::TOKEN);
    let payee = Address::from_str(&e, fx::PAYEE);
    let r = e.as_contract(&id, || {
        let from = e.current_contract_address();
        // amount differs from the proven sig_amount (but < 2^100)
        let c = one_ctx(&e, &token, &from, &payee, fx::AMOUNT - 1);
        <NulthAccount as CustomAccountInterface>::__check_auth(e.clone(), good_payload(&e), proofsig(&e), c)
    });
    assert_eq!(r, Err(AccError::BadAmountBinding));
}

#[test]
fn test_dest_binding() {
    let e = Env::default();
    let id = register(&e, u256h(&e, fx::COMMITMENT), u256h(&e, fx::ROOT));
    let token = Address::from_str(&e, fx::TOKEN);
    let other = Address::generate(&e);
    let r = e.as_contract(&id, || {
        let from = e.current_contract_address();
        let c = one_ctx(&e, &token, &from, &other, fx::AMOUNT);
        <NulthAccount as CustomAccountInterface>::__check_auth(e.clone(), good_payload(&e), proofsig(&e), c)
    });
    assert_eq!(r, Err(AccError::BadDestBinding));
}

#[test]
fn test_old_policy_binding() {
    let e = Env::default();
    // stored commitment differs from the proof's -> BadPolicyBinding
    let id = register(&e, u256h(&e, "0000000000000000000000000000000000000000000000000000000000000001"), u256h(&e, fx::ROOT));
    let token = Address::from_str(&e, fx::TOKEN);
    let payee = Address::from_str(&e, fx::PAYEE);
    let r = e.as_contract(&id, || {
        let from = e.current_contract_address();
        let c = one_ctx(&e, &token, &from, &payee, fx::AMOUNT);
        <NulthAccount as CustomAccountInterface>::__check_auth(e.clone(), good_payload(&e), proofsig(&e), c)
    });
    assert_eq!(r, Err(AccError::BadPolicyBinding));
}

#[test]
fn test_bad_proof_swapped_ac() {
    let e = Env::default();
    let id = register(&e, u256h(&e, fx::COMMITMENT), u256h(&e, fx::ROOT));
    let token = Address::from_str(&e, fx::TOKEN);
    let payee = Address::from_str(&e, fx::PAYEE);
    // swap a<->c: valid curve points, wrong proof -> pairing false
    let sig = ProofSig { a: b64(&e, fx::PROOF_C), b: b128(&e, fx::PROOF_B), c: b64(&e, fx::PROOF_A), pub_signals: pub_signals(&e) };
    let r = e.as_contract(&id, || {
        let from = e.current_contract_address();
        let c = one_ctx(&e, &token, &from, &payee, fx::AMOUNT);
        <NulthAccount as CustomAccountInterface>::__check_auth(e.clone(), good_payload(&e), sig, c)
    });
    assert_eq!(r, Err(AccError::BadProof));
}

// ---- P1 hardening negative controls ----

#[test]
fn test_empty_context_rejected() {
    let e = Env::default();
    let id = register(&e, u256h(&e, fx::COMMITMENT), u256h(&e, fx::ROOT));
    let r = run(&e, &id, good_payload(&e), proofsig(&e), Vec::new(&e));
    assert_eq!(r, Err(AccError::NoContext));
}

#[test]
fn test_two_contexts_rejected() {
    let e = Env::default();
    let id = register(&e, u256h(&e, fx::COMMITMENT), u256h(&e, fx::ROOT));
    let token = Address::from_str(&e, fx::TOKEN);
    let payee = Address::from_str(&e, fx::PAYEE);
    let r = e.as_contract(&id, || {
        let from = e.current_contract_address();
        let two = vec![
            &e,
            Context::Contract(ContractContext { contract: token.clone(), fn_name: Symbol::new(&e, "transfer"), args: vec![&e, from.into_val(&e), payee.into_val(&e), fx::AMOUNT.into_val(&e)] }),
            Context::Contract(ContractContext { contract: token.clone(), fn_name: Symbol::new(&e, "transfer"), args: vec![&e, from.into_val(&e), payee.into_val(&e), fx::AMOUNT.into_val(&e)] }),
        ];
        <NulthAccount as CustomAccountInterface>::__check_auth(e.clone(), good_payload(&e), proofsig(&e), two)
    });
    assert_eq!(r, Err(AccError::TooManyContexts));
}

#[test]
fn test_token_binding() {
    let e = Env::default();
    let id = register(&e, u256h(&e, fx::COMMITMENT), u256h(&e, fx::ROOT));
    let wrong_token = Address::generate(&e);
    let payee = Address::from_str(&e, fx::PAYEE);
    let r = e.as_contract(&id, || {
        let from = e.current_contract_address();
        let c = one_ctx(&e, &wrong_token, &from, &payee, fx::AMOUNT);
        <NulthAccount as CustomAccountInterface>::__check_auth(e.clone(), good_payload(&e), proofsig(&e), c)
    });
    assert_eq!(r, Err(AccError::BadTokenBinding));
}

#[test]
fn test_from_binding() {
    let e = Env::default();
    let id = register(&e, u256h(&e, fx::COMMITMENT), u256h(&e, fx::ROOT));
    let token = Address::from_str(&e, fx::TOKEN);
    let payee = Address::from_str(&e, fx::PAYEE);
    let not_self = Address::generate(&e);
    let r = e.as_contract(&id, || {
        let c = one_ctx(&e, &token, &not_self, &payee, fx::AMOUNT);
        <NulthAccount as CustomAccountInterface>::__check_auth(e.clone(), good_payload(&e), proofsig(&e), c)
    });
    assert_eq!(r, Err(AccError::BadFromBinding));
}

#[test]
fn test_amount_too_large() {
    let e = Env::default();
    let id = register(&e, u256h(&e, fx::COMMITMENT), u256h(&e, fx::ROOT));
    let token = Address::from_str(&e, fx::TOKEN);
    let payee = Address::from_str(&e, fx::PAYEE);
    let r = e.as_contract(&id, || {
        let from = e.current_contract_address();
        let c = one_ctx(&e, &token, &from, &payee, 1i128 << 100); // >= 2^100
        <NulthAccount as CustomAccountInterface>::__check_auth(e.clone(), good_payload(&e), proofsig(&e), c)
    });
    assert_eq!(r, Err(AccError::AmountTooLarge));
}

#[test]
fn test_negative_amount() {
    let e = Env::default();
    let id = register(&e, u256h(&e, fx::COMMITMENT), u256h(&e, fx::ROOT));
    let token = Address::from_str(&e, fx::TOKEN);
    let payee = Address::from_str(&e, fx::PAYEE);
    let r = e.as_contract(&id, || {
        let from = e.current_contract_address();
        let c = one_ctx(&e, &token, &from, &payee, -1i128);
        <NulthAccount as CustomAccountInterface>::__check_auth(e.clone(), good_payload(&e), proofsig(&e), c)
    });
    assert_eq!(r, Err(AccError::NegativeAmount));
}

#[test]
fn test_sigpayload_binding() {
    let e = Env::default();
    let id = register(&e, u256h(&e, fx::COMMITMENT), u256h(&e, fx::ROOT));
    let token = Address::from_str(&e, fx::TOKEN);
    let payee = Address::from_str(&e, fx::PAYEE);
    // a DIFFERENT payload (different invocation) -> halves mismatch the proof
    let wrong_payload = e.crypto().sha256(&Bytes::from_slice(&e, b"a-different-invocation"));
    let r = e.as_contract(&id, || {
        let from = e.current_contract_address();
        let c = one_ctx(&e, &token, &from, &payee, fx::AMOUNT);
        <NulthAccount as CustomAccountInterface>::__check_auth(e.clone(), wrong_payload, proofsig(&e), c)
    });
    assert_eq!(r, Err(AccError::BadSigPayload));
}

#[test]
fn test_bad_signal_count() {
    let e = Env::default();
    let id = register(&e, u256h(&e, fx::COMMITMENT), u256h(&e, fx::ROOT));
    let token = Address::from_str(&e, fx::TOKEN);
    let payee = Address::from_str(&e, fx::PAYEE);
    let mut short = pub_signals(&e);
    short.pop_back(); // 5 signals instead of 6
    let sig = ProofSig { a: b64(&e, fx::PROOF_A), b: b128(&e, fx::PROOF_B), c: b64(&e, fx::PROOF_C), pub_signals: short };
    let r = e.as_contract(&id, || {
        let from = e.current_contract_address();
        let c = one_ctx(&e, &token, &from, &payee, fx::AMOUNT);
        <NulthAccount as CustomAccountInterface>::__check_auth(e.clone(), good_payload(&e), sig, c)
    });
    assert_eq!(r, Err(AccError::BadSignalCount));
}

#[test]
#[should_panic(expected = "#14")]
fn test_malformed_vk_rejected_at_construction() {
    let e = Env::default();
    let mut bad = vk(&e);
    bad.ic.pop_back(); // 6 ic entries instead of 7
    let token = Address::from_str(&e, fx::TOKEN);
    let admin = Address::generate(&e);
    let _ = e.register(NulthAccount, (bad, u256h(&e, fx::COMMITMENT), u256h(&e, fx::ROOT), token, admin, EPOCH_LEN, EPOCH_CAP, ROT_DELAY));
}

// ---- P2 governance (admin-authorized rotation + freeze; admin cannot move funds) ----

const BOGUS: &str = "0000000000000000000000000000000000000000000000000000000000000009";

fn valid_run(e: &Env, id: &Address) -> Result<(), AccError> {
    let token = Address::from_str(e, fx::TOKEN);
    let payee = Address::from_str(e, fx::PAYEE);
    e.as_contract(id, || {
        let from = e.current_contract_address();
        let c = one_ctx(e, &token, &from, &payee, fx::AMOUNT);
        <NulthAccount as CustomAccountInterface>::__check_auth(e.clone(), good_payload(e), proofsig(e), c)
    })
}

#[test]
fn test_rotate_then_old_proof_fails() {
    let e = Env::default();
    e.mock_all_auths();
    let admin = Address::generate(&e);
    let id = register_with_admin(&e, u256h(&e, fx::COMMITMENT), u256h(&e, fx::ROOT), &admin);
    assert_eq!(valid_run(&e, &id), Ok(())); // proof authorizes under the original policy
    let client = NulthAccountClient::new(&e, &id);
    client.propose_rotation(&u256h(&e, BOGUS), &u256h(&e, fx::ROOT)); // admin STAGES rotating the commitment away
    // during the timelock window the OLD policy is still in force
    assert_eq!(valid_run(&e, &id), Ok(()));
    advance(&e, ROT_DELAY + 1); // advance past the timelock
    client.execute_rotation();
    assert_eq!(valid_run(&e, &id), Err(AccError::BadPolicyBinding)); // old proof no longer matches
}

#[test]
fn test_rotate_to_matching_policy_succeeds() {
    let e = Env::default();
    e.mock_all_auths();
    let admin = Address::generate(&e);
    // committed to a bogus policy first -> the fixture proof does not match
    let id = register_with_admin(&e, u256h(&e, BOGUS), u256h(&e, BOGUS), &admin);
    assert_eq!(valid_run(&e, &id), Err(AccError::BadPolicyBinding));
    let client = NulthAccountClient::new(&e, &id);
    client.propose_rotation(&u256h(&e, fx::COMMITMENT), &u256h(&e, fx::ROOT)); // stage rotation to the proof's policy
    advance(&e, ROT_DELAY + 1);
    client.execute_rotation();
    assert_eq!(valid_run(&e, &id), Ok(())); // a proof for the newly-committed policy authorizes
}

#[test]
fn test_freeze_blocks_valid_proof() {
    let e = Env::default();
    e.mock_all_auths();
    let admin = Address::generate(&e);
    let id = register_with_admin(&e, u256h(&e, fx::COMMITMENT), u256h(&e, fx::ROOT), &admin);
    assert_eq!(valid_run(&e, &id), Ok(()));
    NulthAccountClient::new(&e, &id).freeze();
    assert_eq!(valid_run(&e, &id), Err(AccError::AccountFrozen)); // frozen -> rejected before pairing
}

#[test]
fn test_unfreeze_restores_spend() {
    let e = Env::default();
    e.mock_all_auths();
    let admin = Address::generate(&e);
    let id = register_with_admin(&e, u256h(&e, fx::COMMITMENT), u256h(&e, fx::ROOT), &admin);
    let client = NulthAccountClient::new(&e, &id);
    client.freeze();
    assert_eq!(valid_run(&e, &id), Err(AccError::AccountFrozen));
    client.unfreeze();
    assert_eq!(valid_run(&e, &id), Ok(())); // spending resumes after unfreeze
}

#[test]
#[should_panic] // admin.require_auth() is unsatisfiable without the admin's authorization
fn test_non_admin_rotate_rejected() {
    let e = Env::default();
    let admin = Address::generate(&e);
    let id = register_with_admin(&e, u256h(&e, fx::COMMITMENT), u256h(&e, fx::ROOT), &admin);
    // no auth mocked: a non-admin caller cannot satisfy the admin gate
    NulthAccountClient::new(&e, &id).propose_rotation(&u256h(&e, BOGUS), &u256h(&e, BOGUS));
}

#[test]
#[should_panic] // admin.require_auth() is unsatisfiable without the admin's authorization
fn test_non_admin_freeze_rejected() {
    let e = Env::default();
    let admin = Address::generate(&e);
    let id = register_with_admin(&e, u256h(&e, fx::COMMITMENT), u256h(&e, fx::ROOT), &admin);
    NulthAccountClient::new(&e, &id).freeze();
}

// ---- extended coverage (per-binding edges + BadContext variants) ----

fn ctx_fn(e: &Env, contract: &Address, fnname: &str, from: &Address, to: &Address, amount: i128) -> Vec<Context> {
    vec![e, Context::Contract(ContractContext { contract: contract.clone(), fn_name: Symbol::new(e, fnname), args: vec![e, from.into_val(e), to.into_val(e), amount.into_val(e)] })]
}

#[test]
fn test_bad_context_wrong_fn_name() {
    let e = Env::default();
    let id = register(&e, u256h(&e, fx::COMMITMENT), u256h(&e, fx::ROOT));
    let token = Address::from_str(&e, fx::TOKEN);
    let payee = Address::from_str(&e, fx::PAYEE);
    let r = e.as_contract(&id, || { let from = e.current_contract_address(); let c = ctx_fn(&e, &token, "approve", &from, &payee, fx::AMOUNT);
        <NulthAccount as CustomAccountInterface>::__check_auth(e.clone(), good_payload(&e), proofsig(&e), c) });
    assert_eq!(r, Err(AccError::BadContext));
}

#[test]
fn test_bad_context_burn_fn() {
    let e = Env::default();
    let id = register(&e, u256h(&e, fx::COMMITMENT), u256h(&e, fx::ROOT));
    let token = Address::from_str(&e, fx::TOKEN);
    let payee = Address::from_str(&e, fx::PAYEE);
    let r = e.as_contract(&id, || { let from = e.current_contract_address(); let c = ctx_fn(&e, &token, "burn", &from, &payee, fx::AMOUNT);
        <NulthAccount as CustomAccountInterface>::__check_auth(e.clone(), good_payload(&e), proofsig(&e), c) });
    assert_eq!(r, Err(AccError::BadContext));
}

#[test]
fn test_bad_context_too_few_args() {
    let e = Env::default();
    let id = register(&e, u256h(&e, fx::COMMITMENT), u256h(&e, fx::ROOT));
    let token = Address::from_str(&e, fx::TOKEN);
    let payee = Address::from_str(&e, fx::PAYEE);
    let r = e.as_contract(&id, || { let from = e.current_contract_address();
        let c = vec![&e, Context::Contract(ContractContext { contract: token.clone(), fn_name: Symbol::new(&e, "transfer"), args: vec![&e, from.into_val(&e), payee.into_val(&e)] })]; // missing amount
        <NulthAccount as CustomAccountInterface>::__check_auth(e.clone(), good_payload(&e), proofsig(&e), c) });
    assert_eq!(r, Err(AccError::BadContext));
}

#[test]
fn test_root_binding() {
    let e = Env::default();
    // correct commitment, WRONG allowlist root -> BadPolicyBinding (the root path, distinct from commitment)
    let id = register(&e, u256h(&e, fx::COMMITMENT), u256h(&e, "0000000000000000000000000000000000000000000000000000000000000002"));
    let token = Address::from_str(&e, fx::TOKEN);
    let payee = Address::from_str(&e, fx::PAYEE);
    let r = e.as_contract(&id, || { let from = e.current_contract_address(); let c = one_ctx(&e, &token, &from, &payee, fx::AMOUNT);
        <NulthAccount as CustomAccountInterface>::__check_auth(e.clone(), good_payload(&e), proofsig(&e), c) });
    assert_eq!(r, Err(AccError::BadPolicyBinding));
}

#[test]
fn test_amount_binding_plus_one() {
    let e = Env::default();
    let id = register(&e, u256h(&e, fx::COMMITMENT), u256h(&e, fx::ROOT));
    let token = Address::from_str(&e, fx::TOKEN);
    let payee = Address::from_str(&e, fx::PAYEE);
    let r = e.as_contract(&id, || { let from = e.current_contract_address(); let c = one_ctx(&e, &token, &from, &payee, fx::AMOUNT + 1);
        <NulthAccount as CustomAccountInterface>::__check_auth(e.clone(), good_payload(&e), proofsig(&e), c) });
    assert_eq!(r, Err(AccError::BadAmountBinding));
}

#[test]
fn test_zero_amount_rejected() {
    let e = Env::default();
    let id = register(&e, u256h(&e, fx::COMMITMENT), u256h(&e, fx::ROOT));
    let token = Address::from_str(&e, fx::TOKEN);
    let payee = Address::from_str(&e, fx::PAYEE);
    // a zero-value transfer is refused in-contract (policy: 0 < amount), before any binding check
    let r = e.as_contract(&id, || { let from = e.current_contract_address(); let c = one_ctx(&e, &token, &from, &payee, 0i128);
        <NulthAccount as CustomAccountInterface>::__check_auth(e.clone(), good_payload(&e), proofsig(&e), c) });
    assert_eq!(r, Err(AccError::ZeroAmount));
}

#[test]
fn test_amount_max_minus_one_is_amount_binding() {
    let e = Env::default();
    let id = register(&e, u256h(&e, fx::COMMITMENT), u256h(&e, fx::ROOT));
    let token = Address::from_str(&e, fx::TOKEN);
    let payee = Address::from_str(&e, fx::PAYEE);
    // (2^100 - 1) is in-range (not AmountTooLarge) but != the proven amount -> BadAmountBinding
    let r = e.as_contract(&id, || { let from = e.current_contract_address(); let c = one_ctx(&e, &token, &from, &payee, (1i128 << 100) - 1);
        <NulthAccount as CustomAccountInterface>::__check_auth(e.clone(), good_payload(&e), proofsig(&e), c) });
    assert_eq!(r, Err(AccError::BadAmountBinding));
}

#[test]
fn test_dest_binding_second() {
    let e = Env::default();
    let id = register(&e, u256h(&e, fx::COMMITMENT), u256h(&e, fx::ROOT));
    let token = Address::from_str(&e, fx::TOKEN);
    let other = Address::generate(&e);
    let r = e.as_contract(&id, || { let from = e.current_contract_address(); let c = one_ctx(&e, &token, &from, &other, fx::AMOUNT);
        <NulthAccount as CustomAccountInterface>::__check_auth(e.clone(), good_payload(&e), proofsig(&e), c) });
    assert_eq!(r, Err(AccError::BadDestBinding));
}

#[test]
fn test_token_binding_second() {
    let e = Env::default();
    let id = register(&e, u256h(&e, fx::COMMITMENT), u256h(&e, fx::ROOT));
    let other_token = Address::generate(&e);
    let payee = Address::from_str(&e, fx::PAYEE);
    let r = e.as_contract(&id, || { let from = e.current_contract_address(); let c = one_ctx(&e, &other_token, &from, &payee, fx::AMOUNT);
        <NulthAccount as CustomAccountInterface>::__check_auth(e.clone(), good_payload(&e), proofsig(&e), c) });
    assert_eq!(r, Err(AccError::BadTokenBinding));
}

#[test]
fn test_from_binding_second() {
    let e = Env::default();
    let id = register(&e, u256h(&e, fx::COMMITMENT), u256h(&e, fx::ROOT));
    let token = Address::from_str(&e, fx::TOKEN);
    let payee = Address::from_str(&e, fx::PAYEE);
    let attacker = Address::generate(&e);
    let r = e.as_contract(&id, || { let c = one_ctx(&e, &token, &attacker, &payee, fx::AMOUNT);
        <NulthAccount as CustomAccountInterface>::__check_auth(e.clone(), good_payload(&e), proofsig(&e), c) });
    assert_eq!(r, Err(AccError::BadFromBinding));
}

#[test]
fn test_three_contexts_rejected() {
    let e = Env::default();
    let id = register(&e, u256h(&e, fx::COMMITMENT), u256h(&e, fx::ROOT));
    let token = Address::from_str(&e, fx::TOKEN);
    let payee = Address::from_str(&e, fx::PAYEE);
    let r = e.as_contract(&id, || { let from = e.current_contract_address();
        let mk = || Context::Contract(ContractContext { contract: token.clone(), fn_name: Symbol::new(&e, "transfer"), args: vec![&e, from.into_val(&e), payee.into_val(&e), fx::AMOUNT.into_val(&e)] });
        let three = vec![&e, mk(), mk(), mk()];
        <NulthAccount as CustomAccountInterface>::__check_auth(e.clone(), good_payload(&e), proofsig(&e), three) });
    assert_eq!(r, Err(AccError::TooManyContexts));
}

#[test]
fn test_sigpayload_binding_other() {
    let e = Env::default();
    let id = register(&e, u256h(&e, fx::COMMITMENT), u256h(&e, fx::ROOT));
    let token = Address::from_str(&e, fx::TOKEN);
    let payee = Address::from_str(&e, fx::PAYEE);
    let other_payload = e.crypto().sha256(&Bytes::from_slice(&e, b"yet-another-invocation-xyz"));
    let r = e.as_contract(&id, || { let from = e.current_contract_address(); let c = one_ctx(&e, &token, &from, &payee, fx::AMOUNT);
        <NulthAccount as CustomAccountInterface>::__check_auth(e.clone(), other_payload, proofsig(&e), c) });
    assert_eq!(r, Err(AccError::BadSigPayload));
}

#[test]
fn test_negative_amount_min() {
    let e = Env::default();
    let id = register(&e, u256h(&e, fx::COMMITMENT), u256h(&e, fx::ROOT));
    let token = Address::from_str(&e, fx::TOKEN);
    let payee = Address::from_str(&e, fx::PAYEE);
    let r = e.as_contract(&id, || { let from = e.current_contract_address(); let c = one_ctx(&e, &token, &from, &payee, i128::MIN);
        <NulthAccount as CustomAccountInterface>::__check_auth(e.clone(), good_payload(&e), proofsig(&e), c) });
    assert_eq!(r, Err(AccError::NegativeAmount));
}

#[test]
fn test_bad_signal_count_extra() {
    let e = Env::default();
    let id = register(&e, u256h(&e, fx::COMMITMENT), u256h(&e, fx::ROOT));
    let token = Address::from_str(&e, fx::TOKEN);
    let payee = Address::from_str(&e, fx::PAYEE);
    let mut extra = pub_signals(&e);
    extra.push_back(u256h(&e, fx::COMMITMENT)); // 7 signals instead of 6
    let sig = ProofSig { a: b64(&e, fx::PROOF_A), b: b128(&e, fx::PROOF_B), c: b64(&e, fx::PROOF_C), pub_signals: extra };
    let r = e.as_contract(&id, || { let from = e.current_contract_address(); let c = one_ctx(&e, &token, &from, &payee, fx::AMOUNT);
        <NulthAccount as CustomAccountInterface>::__check_auth(e.clone(), good_payload(&e), sig, c) });
    assert_eq!(r, Err(AccError::BadSignalCount));
}

// ---- rotation timelock (propose -> delay -> execute) ----

#[test]
#[should_panic(expected = "#22")] // RotationLocked: cannot execute before the timelock elapses
fn test_rotation_locked_before_delay() {
    let e = Env::default();
    e.mock_all_auths();
    let admin = Address::generate(&e);
    let id = register_with_admin(&e, u256h(&e, fx::COMMITMENT), u256h(&e, fx::ROOT), &admin);
    let client = NulthAccountClient::new(&e, &id);
    client.propose_rotation(&u256h(&e, BOGUS), &u256h(&e, BOGUS));
    client.execute_rotation(); // still inside the delay window -> panics RotationLocked
}

#[test]
#[should_panic(expected = "#21")] // NoPendingRotation: nothing staged to execute
fn test_execute_without_pending_rejected() {
    let e = Env::default();
    e.mock_all_auths();
    let admin = Address::generate(&e);
    let id = register_with_admin(&e, u256h(&e, fx::COMMITMENT), u256h(&e, fx::ROOT), &admin);
    NulthAccountClient::new(&e, &id).execute_rotation();
}

#[test]
#[should_panic(expected = "#21")] // cancelled staging cannot be executed
fn test_cancel_rotation_blocks_execute() {
    let e = Env::default();
    e.mock_all_auths();
    let admin = Address::generate(&e);
    let id = register_with_admin(&e, u256h(&e, fx::COMMITMENT), u256h(&e, fx::ROOT), &admin);
    let client = NulthAccountClient::new(&e, &id);
    client.propose_rotation(&u256h(&e, BOGUS), &u256h(&e, BOGUS));
    client.cancel_rotation();
    advance(&e, ROT_DELAY + 1);
    client.execute_rotation(); // nothing pending -> NoPendingRotation
}

#[test]
#[should_panic] // non-admin cannot execute a staged rotation
fn test_non_admin_execute_rejected() {
    let e = Env::default();
    let admin = Address::generate(&e);
    let id = register_with_admin(&e, u256h(&e, fx::COMMITMENT), u256h(&e, fx::ROOT), &admin);
    NulthAccountClient::new(&e, &id).execute_rotation();
}

// ---- rolling epoch spend budget ----

#[test]
fn test_epoch_cap_blocks_cumulative_drain() {
    let e = Env::default();
    let admin = Address::generate(&e);
    // cap = exactly one fixture payment; a second in-policy spend in the same window is refused
    let id = register_full(&e, u256h(&e, fx::COMMITMENT), u256h(&e, fx::ROOT), &admin, EPOCH_LEN, fx::AMOUNT, ROT_DELAY);
    assert_eq!(valid_run(&e, &id), Ok(()));                          // 1st spend fills the window budget
    assert_eq!(valid_run(&e, &id), Err(AccError::EpochCapExceeded)); // 2nd would exceed EPOCH_CAP
}

#[test]
fn test_epoch_rollover_resets_budget() {
    let e = Env::default();
    let admin = Address::generate(&e);
    let id = register_full(&e, u256h(&e, fx::COMMITMENT), u256h(&e, fx::ROOT), &admin, EPOCH_LEN, fx::AMOUNT, ROT_DELAY);
    assert_eq!(valid_run(&e, &id), Ok(()));
    assert_eq!(valid_run(&e, &id), Err(AccError::EpochCapExceeded));
    advance(&e, EPOCH_LEN + 1); // advance into a fresh window
    assert_eq!(valid_run(&e, &id), Ok(()));        // budget reset -> spend allowed again
}

#[test]
#[should_panic(expected = "#23")] // BadEpochConfig: a zero cap would be a degenerate/unspendable budget
fn test_bad_epoch_config_zero_cap_rejected() {
    let e = Env::default();
    let admin = Address::generate(&e);
    let _ = register_full(&e, u256h(&e, fx::COMMITMENT), u256h(&e, fx::ROOT), &admin, EPOCH_LEN, 0i128, ROT_DELAY);
}

#[test]
#[should_panic(expected = "#23")] // BadEpochConfig: an instant (zero-delay) rotation re-opens the drain
fn test_bad_epoch_config_zero_delay_rejected() {
    let e = Env::default();
    let admin = Address::generate(&e);
    let _ = register_full(&e, u256h(&e, fx::COMMITMENT), u256h(&e, fx::ROOT), &admin, EPOCH_LEN, EPOCH_CAP, 0u32);
}
