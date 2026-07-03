# Using a ZK Proof as a Soroban Authorization Signature

A Soroban *custom account* lets you replace the signature check in `__check_auth` with arbitrary logic.
Almost everyone uses that to swap Ed25519 for secp256r1 (passkeys) or to add multisig. This post does
something different: it makes the account's **signature a Groth16 proof**. The account has no key. It
spends only if the caller can prove, in zero knowledge, that the payment obeys a policy the chain has
never seen.

Everything below is from a working deployment on Stellar testnet (Protocol 26). Code is quoted from the
repo and lightly trimmed for readability (comments added, defensive guards elided) — behavior unchanged;
numbers are decoded from real transactions and cited.

## The custom-account interface

Soroban hands `__check_auth` three things: the `signature_payload` (a 32-byte hash of the authorized
invocations + nonce + expiration), the account's declared `Signature` type, and the list of
authorization contexts. For an Ed25519 account, `Signature` is 64 bytes. For Nulth, it is a proof:

```rust
// contracts/covenant_account/src/lib.rs
/// The "signature" for this account is a Groth16 proof + its public signals.
#[contracttype]
pub struct ProofSig {
    pub a: BytesN<64>,          // Groth16 A  (G1)
    pub b: BytesN<128>,         // Groth16 B  (G2)
    pub c: BytesN<64>,          // Groth16 C  (G1)
    pub pub_signals: Vec<U256>, // the 6 public inputs
}

impl CustomAccountInterface for CovenantAccount {
    type Signature = ProofSig;          // <-- the signature IS a proof
    type Error = AccError;

    fn __check_auth(
        env: Env,
        signature_payload: Hash<32>,
        sig: ProofSig,
        auth_contexts: Vec<Context>,
    ) -> Result<(), AccError> { /* ... */ }
}
```

There is no `PublicKey` in storage. There is a verification key, a policy commitment, an allowlist root,
and a pinned token — set once in the constructor.

## What the proof proves

The circuit is `policy.circom`. Its public signals are the only things the verifier sees; the policy
itself stays private:

```circom
// circuits/policy.circom
template PaymentPolicy(DEPTH) {
    // public
    signal input amount;
    signal input dest;
    signal input policy_commitment;
    signal input allowlist_root;
    signal input sigpayload_hi;   // high 128 bits of Soroban signature_payload
    signal input sigpayload_lo;   // low  128 bits of Soroban signature_payload
    // private
    signal input cap;
    signal input salt;
    signal input path[DEPTH];
    signal input index_bits[DEPTH];
    // ...
}
component main {public [amount, dest, policy_commitment,
                        allowlist_root, sigpayload_hi, sigpayload_lo]} = PaymentPolicy(16);
```

A valid witness asserts three things at once:

1. **Spend cap** — `Poseidon(cap, salt) == policy_commitment` and `amount <= cap` (a 100-bit range
   check). The prover knows the `cap` behind the on-chain commitment, and the payment is under it.
2. **Allowlist membership** — a Poseidon-Merkle path opens `dest` to `allowlist_root`. The destination
   is one of the committed addresses.
3. **Transaction binding** — `sigpayload_hi/lo` are the two halves of *this* invocation's
   `signature_payload` (see below).

`cap`, `salt`, and the Merkle path are private. The chain stores only the commitment and the root — it
never learns the cap or any allowlisted address that hasn't yet been paid.

## Why the proof can't be lifted or redirected

A proof is just bytes in the mempool. The interesting question is why an attacker can't grab one and
point it at their own address, or replay it. The answer is that `__check_auth` re-checks every public
signal against on-chain reality before it ever runs the pairing.

**Policy binding** — the proof must be about *this* account's committed policy:

```rust
// 1. proof must be about THIS account's committed policy.
if sig_pol != pol || sig_root != root {
    return Err(AccError::BadPolicyBinding);
}
```

**Replay / non-transferability** — Soroban's `signature_payload` already commits to the nonce,
expiration, and the exact invocation. Nulth splits that 32-byte hash into two field elements and
requires the proof to carry them as public inputs:

```rust
/// Split a 32-byte signature_payload into two 128-bit field elements (hi, lo).
fn split_payload(env: &Env, payload: &Hash<32>) -> (U256, U256) {
    let sp = payload.to_array();
    let mut hi = [0u8; 32];
    let mut lo = [0u8; 32];
    hi[16..32].copy_from_slice(&sp[0..16]);
    lo[16..32].copy_from_slice(&sp[16..32]);
    (U256::from_be_bytes(env, &Bytes::from_array(env, &hi)),
     U256::from_be_bytes(env, &Bytes::from_array(env, &lo)))
}

// 2. proof must be bound to THIS invocation (anti-replay, non-transferable).
let (sp_hi, sp_lo) = Self::split_payload(&env, &signature_payload);
if sp_hi != sig_sphi || sp_lo != sig_splo {
    return Err(AccError::BadSigPayload);
}
```

Lift the proof into any other transaction and the `signature_payload` differs, so the public inputs no
longer match the witness — `BadSigPayload`. There is no separate nullifier; the host's native
`(address, nonce)` consumption closes the same-transaction replay, and this binding closes the
lifted-into-a-new-transaction case.

**Payment-fact binding** — the `amount` and `dest` public signals must equal the *actual* transfer
arguments the context carries:

```rust
if U256::from_u128(&env, amount as u128) != sig_amount {
    return Err(AccError::BadAmountBinding);
}
if Self::addr_to_field(&env, &to) != sig_dest {
    return Err(AccError::BadDestBinding);
}
```

So the proof isn't a blank check — it is welded to one amount, to one destination, in one transaction.
Change any of them and the public signals stop matching.

## The number: verify is a constant 8.537%

Only after all the bindings pass does the contract run the pairing — inline, on Protocol 26's native
BN254 host functions:

```rust
fn groth16_verify(env: &Env, vk: &VerificationKey, sig: &ProofSig) -> bool {
    let bn = env.crypto().bn254();
    let mut vk_x = vk.ic.get(0).unwrap();
    for (s, v) in sig.pub_signals.iter().zip(vk.ic.iter().skip(1)) {
        let fr = Bn254Fr::from_u256(s);
        vk_x = bn.g1_add(&vk_x, &bn.g1_mul(&v, &fr));   // one g1_mul per public input
    }
    let neg_a = -Bn254G1Affine::from_bytes(sig.a.clone());
    let b = Bn254G2Affine::from_bytes(sig.b.clone());
    let c = Bn254G1Affine::from_bytes(sig.c.clone());
    // Groth16: e(-A,B)·e(alpha,beta)·e(vk_x,gamma)·e(C,delta) == 1
    bn.pairing_check(vec![env, neg_a, vk.alpha, vk_x, c],
                     vec![env, b, vk.beta, vk.gamma, vk.delta])
}
```

The work is **one `g1_mul` per public input** (here, 6) plus a **fixed pairing**. That is the whole
reason the cost is flat: Groth16 verification is `f(#public_inputs, pairing)` — it does **not** depend
on the size of the circuit or the depth of the Merkle tree. A 65,536-slot allowlist (DEPTH-16) verifies
for exactly what a 16-slot one would.

Decoded from a real proof-authorized payment transaction
(`sorobanData.resources().instructions()`):

```
verify cost = 34,149,591 instructions = 8.537% of the 400,000,000 ceiling
```

It is **byte-identical at DEPTH-4 and DEPTH-16 (Δ = 0)** — the proving time grows with depth, but the
on-chain verify does not. (Source: `docs/ARCHITECTURE.md` §6; `REPORT_DEPTH16.md` §F; mirrored in
`web/config.js` as `costInstr: '34,149,591'`, `costPct: '8.537'`. A live *total* payment runs slightly
higher — ≈8.56% on a first-receive — because the SAC transfer also writes a balance entry; that delta is
storage I/O, not proof verification.)

## The point: the chain enforces a policy it has never seen

Step back from the code. The ledger shows a normal USDC `transfer` — public amount, public destination,
like any Stellar payment. What is *not* on the ledger is the rule that authorized it: the spend cap and
the full allowlist are never published. The only policy artifacts on-chain are one Poseidon commitment
and one Merkle root, which reveal nothing.

This is the inverse of a privacy pool. A privacy pool hides the *amount* and keeps the *rules* public.
Nulth publishes the amount and hides the *rules*.

## Why this fits Stellar specifically

Nulth keeps **no shielded note-set and no nullifier-set**. There is nothing to accumulate, scan, or
prune. Replay protection is the host's native `(address, nonce)` consumption plus the in-proof
`signature_payload` binding above — not a contract-maintained nullifier table.

The practical consequence: there is **no event-history indexer and no archival-RPC dependency**. A
privacy-pool design has to reconstruct a Merkle note-set from historical events to build a withdrawal
proof, which ties it to an indexer and to archived ledger state. Nulth's prover needs only the policy
secret it already holds; verification needs only the current committed root. That makes it a clean fit
for Soroban's stateless-by-default, fee-metered execution model.

## Honesty (the part most demos skip)

Two trust facts a serious reader should know up front:

- **The trusted setup's phase-2 is a dev setup.** Phase-1 is the public, multi-party Hermez
  `powersOfTau28_hez_final_15` ceremony. Phase-2, which produced the deployed keys, is a single local
  contribution — a party that retained its toxic waste could forge proofs. A production deployment needs
  a proper multi-party phase-2 (or a transparent-setup system). This is a dev/hackathon posture, stated
  plainly. (`SECURITY.md` §8; `REPORT_DEPTH16.md` §B.)
- **The admin is a governance trust root.** A disclosed admin key cannot spend in one step — every spend
  still needs a valid proof for the committed policy — but it *can* `rotate_policy` to a policy it
  controls and then spend, in two observable, event-emitting steps. Hardening (multisig + timelock +
  epoch-grace rotation) is documented, not built. (`SECURITY.md` §5.)

Neither of these weakens the core mechanism; both are the kind of thing worth knowing before you trust
it with real money.

## Try it

Repo: **`<repository URL>`** (insert the published URL before posting) · a real proof-authorized USDC
payment on testnet (browser proof → `token.transfer`, authorized solely by the proof):
[`24ce435e…0677`](https://stellar.expert/explorer/testnet/tx/24ce435e822caa5961913ca1a98491d413bf18309857164b10c42e3ab0650677).

The full adversarial matrix (every rejection mode with a real failed-transaction hash) is in
`ADVERSARIAL_TESTING.md`; the binding and trust analysis is in `SECURITY.md`; the golden vectors a
reviewer can re-run are in `docs/CIRCUIT_VERIFICATION.md`.
