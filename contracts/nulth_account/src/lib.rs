//! Nulth Account (P1 hardened): a Soroban custom account whose ONLY spend
//! authorization mechanism is a Groth16 proof (native BN254).
//!
//! __check_auth authorizes a payment iff ALL hold:
//!   1. exactly ONE auth context (no empty -> blanket approval; no multi -> N-fold spend)
//!   2. that context is `transfer` on the PINNED token contract
//!   3. transfer.from == this account (no confused deputy)
//!   4. 0 < amount < 2^100 (in-contract range, shared with the circuit)
//!   5. pub_signals = [amount, dest_field, policy_commitment, allowlist_root,
//!      sigpayload_hi, sigpayload_lo]; commitment/root match instance storage
//!      (anti-substitution), amount/dest match the actual transfer
//!      (anti-redirect), and sigpayload halves match THIS invocation's
//!      signature_payload (anti-replay / non-transferable proof, §8).
//!   6. the cumulative spend in the current epoch window stays within EPOCH_CAP
//!      (closes the "N proofs x per-payment cap = unbounded drain" gap).
//!   7. the Groth16 proof verifies against the VK stored at construction.
//!
//! The policy itself (per-payment cap, allowlist members) never appears on-chain.
//! Replay is closed by binding signature_payload + the host's native
//! per-(address,nonce) consumption — no hand-rolled nullifier storage.
//!
//! GOVERNANCE TRUST MODEL (read this before "keyless" claims): the account has
//! no Ed25519 SPENDING key — every spend needs a valid proof. It DOES have a
//! disclosed `admin` governance key that can freeze/unfreeze and rotate the
//! committed policy. The admin cannot move funds in a single call, but rotating
//! the policy to one it controls and then proving under it IS a two-step spend
//! path. To bound that, `rotate_policy` is a TIMELOCKED two-step
//! propose -> (delay) -> execute, so a malicious/compromised admin rotation is
//! publicly observable for `rotation_delay` ledgers before it can take effect
//! (during which the account can be frozen or funds withdrawn under the old
//! policy). Multisig admin + epoch-versioned rotation with a previous-epoch
//! grace window are the documented complementary hardening paths (SECURITY.md),
//! intentionally not built here.
#![no_std]

#[cfg(test)]
mod fixture_data;
#[cfg(test)]
mod test;

use soroban_sdk::{
    auth::{Context, CustomAccountInterface},
    contract, contracterror, contractimpl, contracttype,
    crypto::bn254::{Bn254Fr, Bn254G1Affine, Bn254G2Affine},
    crypto::Hash,
    panic_with_error, symbol_short, vec, Address, Bytes, BytesN, Env, Symbol, TryIntoVal, U256, Vec,
    xdr::ToXdr,
};

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum AccError {
    NotInit = 1,
    AlreadyInit = 2,
    BadProof = 3,
    BadPolicyBinding = 4,
    BadAmountBinding = 5,
    BadDestBinding = 6,
    BadContext = 7,
    BadSignalCount = 8,
    NegativeAmount = 9,
    BadTokenBinding = 10,
    BadFromBinding = 11,
    AmountTooLarge = 12,
    BadSigPayload = 13,
    MalformedVk = 14,
    NoContext = 15,
    TooManyContexts = 16,
    AccountFrozen = 17,
    // Reserved: non-admin governance calls are rejected by `admin.require_auth()`
    // (host-enforced) before any body runs, so this code is never returned in practice.
    Unauthorized = 18,
    ZeroAmount = 19,
    EpochCapExceeded = 20,
    NoPendingRotation = 21,
    RotationLocked = 22,
    BadEpochConfig = 23,
}

#[derive(Clone)]
#[contracttype]
pub struct VerificationKey {
    pub alpha: Bn254G1Affine,
    pub beta: Bn254G2Affine,
    pub gamma: Bn254G2Affine,
    pub delta: Bn254G2Affine,
    pub ic: Vec<Bn254G1Affine>,
}

/// The "signature" for this account is a Groth16 proof + its public signals.
#[derive(Clone)]
#[contracttype]
pub struct ProofSig {
    pub a: BytesN<64>,
    pub b: BytesN<128>,
    pub c: BytesN<64>,
    pub pub_signals: Vec<U256>,
}

/// A rotation staged by the admin, applicable only once `unlock_ledger` is reached.
#[derive(Clone)]
#[contracttype]
pub struct PendingRotation {
    pub commitment: U256,
    pub root: U256,
    pub unlock_ledger: u32,
}

/// Read-only snapshot of the rolling epoch budget for the admin surface.
#[derive(Clone)]
#[contracttype]
pub struct EpochStatus {
    pub anchor_ledger: u32,
    pub spent: i128,
    pub epoch_ledgers: u32,
    pub epoch_cap: i128,
}

const VK: Symbol = symbol_short!("VK");
const POL: Symbol = symbol_short!("POL");
const ROOT: Symbol = symbol_short!("ROOT");
const TOKEN: Symbol = symbol_short!("TOKEN");
// Governance (P2): a DISCLOSED admin key that can rotate the committed policy and
// freeze/unfreeze the account, but CANNOT move funds in one step (only a valid proof
// for the committed policy authorizes a transfer). Rotation is timelocked; single-admin,
// with multisig + epoch-versioned rotation as documented hardening paths (SECURITY.md).
const ADMIN: Symbol = symbol_short!("ADMIN");
const FROZEN: Symbol = symbol_short!("FROZEN");
// Rolling epoch spend budget: EPOCHLEN ledgers per window, EPOCHCAP cumulative cap,
// (EPOCHANC, EPOCHSPT) = current window anchor + spend-so-far.
const EPOCHLEN: Symbol = symbol_short!("EPOCHLEN");
const EPOCHCAP: Symbol = symbol_short!("EPOCHCAP");
const EPOCHANC: Symbol = symbol_short!("EPOCHANC");
const EPOCHSPT: Symbol = symbol_short!("EPOCHSPT");
// Timelocked rotation: ROTDELAY ledgers of delay; PENDROT holds the staged rotation.
const ROTDELAY: Symbol = symbol_short!("ROTDELAY");
const PENDROT: Symbol = symbol_short!("PENDROT");
const E_INIT: Symbol = symbol_short!("init");
const E_PROPOSE: Symbol = symbol_short!("propose");
const E_ROTATE: Symbol = symbol_short!("rotate");
const E_CANCEL: Symbol = symbol_short!("cancel");
const E_FREEZE: Symbol = symbol_short!("freeze");
const E_UNFREEZE: Symbol = symbol_short!("unfreeze");

// 6 public signals -> ic must have 7 entries (ic[0] + one per signal).
const N_PUBLIC: u32 = 6;
// Shared range bound with policy.circom Num2Bits(100): amount must be < 2^100.
const AMOUNT_BITS: u32 = 100;

#[contract]
pub struct NulthAccount;

#[contractimpl]
impl NulthAccount {
    /// Atomic, deploy-time initialization — cannot be front-run (no uninit window).
    /// `admin` is the governance key (rotate/freeze authority); it can never move funds
    /// in one step. `epoch_ledgers`/`epoch_cap` define the rolling cumulative spend budget;
    /// `rotation_delay_ledgers` is the timelock on committed-policy rotation.
    pub fn __constructor(
        env: Env,
        vk: VerificationKey,
        policy_commitment: U256,
        allowlist_root: U256,
        token: Address,
        admin: Address,
        epoch_ledgers: u32,
        epoch_cap: i128,
        rotation_delay_ledgers: u32,
    ) {
        if vk.ic.len() != N_PUBLIC + 1 {
            panic_with_error!(&env, AccError::MalformedVk);
        }
        // A real budget and a real timelock: reject degenerate config that would
        // silently re-open the drain (0-length window / non-positive cap / instant rotation).
        if epoch_ledgers == 0
            || epoch_cap <= 0
            || epoch_cap >= (1i128 << AMOUNT_BITS)
            || rotation_delay_ledgers == 0
        {
            panic_with_error!(&env, AccError::BadEpochConfig);
        }
        env.storage().instance().set(&VK, &vk);
        env.storage().instance().set(&POL, &policy_commitment);
        env.storage().instance().set(&ROOT, &allowlist_root);
        env.storage().instance().set(&TOKEN, &token);
        env.storage().instance().set(&ADMIN, &admin);
        env.storage().instance().set(&FROZEN, &false);
        env.storage().instance().set(&EPOCHLEN, &epoch_ledgers);
        env.storage().instance().set(&EPOCHCAP, &epoch_cap);
        env.storage().instance().set(&EPOCHANC, &env.ledger().sequence());
        env.storage().instance().set(&EPOCHSPT, &0i128);
        env.storage().instance().set(&ROTDELAY, &rotation_delay_ledgers);
        env.events().publish((E_INIT,), (admin, policy_commitment, allowlist_root));
    }

    fn require_admin(env: &Env) {
        let admin: Address = env
            .storage()
            .instance()
            .get(&ADMIN)
            .unwrap_or_else(|| panic_with_error!(env, AccError::NotInit));
        admin.require_auth();
    }

    /// Stage a committed-policy rotation (admin only). It does NOT take effect until
    /// `execute_rotation` is called after `rotation_delay` ledgers — the delay makes a
    /// malicious/compromised-admin rotation publicly observable before it can spend.
    /// In-flight proofs against the CURRENT commitment/root keep working during the delay.
    pub fn propose_rotation(env: Env, new_commitment: U256, new_root: U256) {
        Self::require_admin(&env);
        let delay: u32 = env
            .storage()
            .instance()
            .get(&ROTDELAY)
            .unwrap_or_else(|| panic_with_error!(&env, AccError::NotInit));
        let unlock_ledger = env.ledger().sequence().saturating_add(delay);
        let pending = PendingRotation {
            commitment: new_commitment.clone(),
            root: new_root.clone(),
            unlock_ledger,
        };
        env.storage().instance().set(&PENDROT, &pending);
        env.events().publish((E_PROPOSE,), (new_commitment, new_root, unlock_ledger));
    }

    /// Apply a previously-proposed rotation (admin only) once its timelock has elapsed.
    /// In-flight proofs against the OLD commitment/root immediately fail `BadPolicyBinding`.
    pub fn execute_rotation(env: Env) {
        Self::require_admin(&env);
        let pending: PendingRotation = match env.storage().instance().get(&PENDROT) {
            Some(p) => p,
            None => panic_with_error!(&env, AccError::NoPendingRotation),
        };
        if env.ledger().sequence() < pending.unlock_ledger {
            panic_with_error!(&env, AccError::RotationLocked);
        }
        env.storage().instance().set(&POL, &pending.commitment);
        env.storage().instance().set(&ROOT, &pending.root);
        env.storage().instance().remove(&PENDROT);
        env.events().publish((E_ROTATE,), (pending.commitment, pending.root));
    }

    /// Cancel a staged rotation before it executes (admin only). Safe no-op if none pending.
    pub fn cancel_rotation(env: Env) {
        Self::require_admin(&env);
        env.storage().instance().remove(&PENDROT);
        env.events().publish((E_CANCEL,), ());
    }

    /// Freeze the account (admin only): every proof-authorized spend is rejected
    /// `AccountFrozen` until unfrozen. Does not, and cannot, move funds.
    pub fn freeze(env: Env) {
        Self::require_admin(&env);
        env.storage().instance().set(&FROZEN, &true);
        env.events().publish((E_FREEZE,), ());
    }

    /// Unfreeze the account (admin only): proof-authorized spending resumes.
    pub fn unfreeze(env: Env) {
        Self::require_admin(&env);
        env.storage().instance().set(&FROZEN, &false);
        env.events().publish((E_UNFREEZE,), ());
    }

    /// Read-only governance view for the admin surface (frozen flag).
    pub fn is_frozen(env: Env) -> bool {
        env.storage().instance().get(&FROZEN).unwrap_or(false)
    }

    /// Read-only governance view for the admin surface (governance key).
    pub fn admin(env: Env) -> Address {
        env.storage()
            .instance()
            .get(&ADMIN)
            .unwrap_or_else(|| panic_with_error!(&env, AccError::NotInit))
    }

    /// Read-only view of a staged (timelocked) rotation, if any.
    pub fn pending_rotation(env: Env) -> Option<PendingRotation> {
        env.storage().instance().get(&PENDROT)
    }

    /// Read-only snapshot of the rolling epoch spend budget.
    pub fn epoch_status(env: Env) -> EpochStatus {
        EpochStatus {
            anchor_ledger: env.storage().instance().get(&EPOCHANC).unwrap_or(0),
            spent: env.storage().instance().get(&EPOCHSPT).unwrap_or(0),
            epoch_ledgers: env.storage().instance().get(&EPOCHLEN).unwrap_or(0),
            epoch_cap: env.storage().instance().get(&EPOCHCAP).unwrap_or(0),
        }
    }

    /// Deterministic Address -> field-element mapping used for binding.
    /// sha256(xdr(address)) with the top byte zeroed (< 2^248 < r).
    /// Exposed so the off-chain prover derives the identical value via simulation.
    pub fn dest_field(env: Env, dest: Address) -> U256 {
        Self::addr_to_field(&env, &dest)
    }

    fn addr_to_field(env: &Env, a: &Address) -> U256 {
        let b: Bytes = a.clone().to_xdr(env);
        let h = env.crypto().sha256(&b);
        let mut arr = h.to_array();
        arr[0] = 0;
        U256::from_be_bytes(env, &Bytes::from_array(env, &arr))
    }

    /// Split a 32-byte signature_payload into two 128-bit field elements (hi, lo).
    fn split_payload(env: &Env, payload: &Hash<32>) -> (U256, U256) {
        let sp = payload.to_array();
        let mut hi = [0u8; 32];
        let mut lo = [0u8; 32];
        hi[16..32].copy_from_slice(&sp[0..16]);
        lo[16..32].copy_from_slice(&sp[16..32]);
        (
            U256::from_be_bytes(env, &Bytes::from_array(env, &hi)),
            U256::from_be_bytes(env, &Bytes::from_array(env, &lo)),
        )
    }

    fn groth16_verify(env: &Env, vk: &VerificationKey, sig: &ProofSig) -> bool {
        let bn = env.crypto().bn254();
        if sig.pub_signals.len() + 1 != vk.ic.len() {
            return false;
        }
        let mut vk_x = vk.ic.get(0).unwrap();
        for (s, v) in sig.pub_signals.iter().zip(vk.ic.iter().skip(1)) {
            let fr = Bn254Fr::from_u256(s);
            let prod = bn.g1_mul(&v, &fr);
            vk_x = bn.g1_add(&vk_x, &prod);
        }
        let a = Bn254G1Affine::from_bytes(sig.a.clone());
        let b = Bn254G2Affine::from_bytes(sig.b.clone());
        let c = Bn254G1Affine::from_bytes(sig.c.clone());
        let neg_a = -a;
        let vk_clone = vk.clone();
        let vp1 = vec![env, neg_a, vk_clone.alpha, vk_x, c];
        let vp2 = vec![env, b, vk_clone.beta, vk_clone.gamma, vk_clone.delta];
        bn.pairing_check(vp1, vp2)
    }
}

#[contractimpl]
impl CustomAccountInterface for NulthAccount {
    type Signature = ProofSig;
    type Error = AccError;

    #[allow(non_snake_case)]
    fn __check_auth(
        env: Env,
        signature_payload: Hash<32>,
        sig: ProofSig,
        auth_contexts: Vec<Context>,
    ) -> Result<(), AccError> {
        let vk: VerificationKey = env.storage().instance().get(&VK).ok_or(AccError::NotInit)?;
        let pol: U256 = env.storage().instance().get(&POL).ok_or(AccError::NotInit)?;
        let root: U256 = env.storage().instance().get(&ROOT).ok_or(AccError::NotInit)?;
        let token: Address = env.storage().instance().get(&TOKEN).ok_or(AccError::NotInit)?;

        // 0. governance freeze: reject all spending before any binding/pairing work.
        if env.storage().instance().get(&FROZEN).unwrap_or(false) {
            return Err(AccError::AccountFrozen);
        }

        // pub_signals layout (snarkjs declaration order):
        // [0]=amount [1]=dest_field [2]=policy_commitment [3]=allowlist_root
        // [4]=sigpayload_hi [5]=sigpayload_lo
        if sig.pub_signals.len() != N_PUBLIC {
            return Err(AccError::BadSignalCount);
        }
        let sig_amount = sig.pub_signals.get(0).unwrap();
        let sig_dest = sig.pub_signals.get(1).unwrap();
        let sig_pol = sig.pub_signals.get(2).unwrap();
        let sig_root = sig.pub_signals.get(3).unwrap();
        let sig_sphi = sig.pub_signals.get(4).unwrap();
        let sig_splo = sig.pub_signals.get(5).unwrap();

        // 1. proof must be about THIS account's committed policy.
        if sig_pol != pol || sig_root != root {
            return Err(AccError::BadPolicyBinding);
        }

        // 2. proof must be bound to THIS invocation (anti-replay, non-transferable).
        let (sp_hi, sp_lo) = Self::split_payload(&env, &signature_payload);
        if sp_hi != sig_sphi || sp_lo != sig_splo {
            return Err(AccError::BadSigPayload);
        }

        // 3. EXACTLY ONE validated context. Empty -> blanket approval; multi -> N-fold spend.
        if auth_contexts.len() == 0 {
            return Err(AccError::NoContext);
        }
        if auth_contexts.len() > 1 {
            return Err(AccError::TooManyContexts);
        }
        // Computed inside the matched context, consumed after the pairing check to
        // atomically advance the epoch budget only on a fully-valid authorization.
        let new_anchor: u32;
        let new_spent: i128;
        let ctx = auth_contexts.get(0).unwrap();
        match ctx {
            Context::Contract(c) => {
                if c.fn_name != symbol_short!("transfer") {
                    return Err(AccError::BadContext);
                }
                // 3a. token pinning: the matched context must target the stored token.
                if c.contract != token {
                    return Err(AccError::BadTokenBinding);
                }
                // SAC transfer(from, to, amount)
                let from: Address = c
                    .args
                    .get(0)
                    .ok_or(AccError::BadContext)?
                    .try_into_val(&env)
                    .map_err(|_| AccError::BadContext)?;
                // 3b. from == self (no confused deputy).
                if from != env.current_contract_address() {
                    return Err(AccError::BadFromBinding);
                }
                let to: Address = c
                    .args
                    .get(1)
                    .ok_or(AccError::BadContext)?
                    .try_into_val(&env)
                    .map_err(|_| AccError::BadContext)?;
                let amount: i128 = c
                    .args
                    .get(2)
                    .ok_or(AccError::BadContext)?
                    .try_into_val(&env)
                    .map_err(|_| AccError::BadContext)?;
                if amount < 0 {
                    return Err(AccError::NegativeAmount);
                }
                // 3c. reject zero-value transfers (README/policy: 0 < amount).
                if amount == 0 {
                    return Err(AccError::ZeroAmount);
                }
                // 3d. in-contract range check (do not rely on circuit-only enforcement).
                if amount >= (1i128 << AMOUNT_BITS) {
                    return Err(AccError::AmountTooLarge);
                }
                if U256::from_u128(&env, amount as u128) != sig_amount {
                    return Err(AccError::BadAmountBinding);
                }
                if Self::addr_to_field(&env, &to) != sig_dest {
                    return Err(AccError::BadDestBinding);
                }

                // 3e. rolling epoch budget: cap CUMULATIVE spend per window so that
                // N sequential in-policy proofs cannot drain more than EPOCH_CAP.
                let now = env.ledger().sequence();
                let epoch_len: u32 = env.storage().instance().get(&EPOCHLEN).ok_or(AccError::NotInit)?;
                let epoch_cap: i128 = env.storage().instance().get(&EPOCHCAP).ok_or(AccError::NotInit)?;
                let mut anchor: u32 = env.storage().instance().get(&EPOCHANC).unwrap_or(now);
                let mut spent: i128 = env.storage().instance().get(&EPOCHSPT).unwrap_or(0);
                if now >= anchor.saturating_add(epoch_len) {
                    anchor = now;
                    spent = 0;
                }
                // amount in (0, 2^100), spent in [0, epoch_cap) < 2^100 -> sum < 2^101, no i128 overflow.
                let projected = spent + amount;
                if projected > epoch_cap {
                    return Err(AccError::EpochCapExceeded);
                }
                new_anchor = anchor;
                new_spent = projected;
            }
            _ => return Err(AccError::BadContext),
        }

        // 4. the Groth16 proof itself must verify (native BN254 pairing).
        if !Self::groth16_verify(&env, &vk, &sig) {
            return Err(AccError::BadProof);
        }

        // 5. authorization fully valid — commit the epoch spend atomically.
        env.storage().instance().set(&EPOCHANC, &new_anchor);
        env.storage().instance().set(&EPOCHSPT, &new_spent);
        Ok(())
    }
}
