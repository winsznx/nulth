# Nulth — CIRCUIT VERIFICATION

> Doc 4 of the Nulth documentation set — the "trust the cryptography" doc: circuit specs,
> trusted-setup provenance, serialization findings, and **reproducible golden vectors** a reviewer
> can re-run. Every value traces to the repository (see **§8 Provenance**); the golden vectors in
> §3–§5 were re-run while writing this doc and the exact outputs are reproduced verbatim.
>
> References **ARCHITECTURE.md** (the `__check_auth` flow), **PROTOCOL.md** (the primitive), and
> **[SECURITY.md](../SECURITY.md) §8** (trusted-setup security — kept consistent here).

---

## 1. The circuits

**`circuits/policy.circom`** — `pragma circom 2.0.0`, `PaymentPolicy(16)` (`policy.circom:63`):

- **DEPTH = 16 → 65,536-leaf** Poseidon-Merkle allowlist.
- **Constraints: 9,402** (4,736 non-linear + 4,666 linear) — REPORT_DEPTH16.md §A.
- **6 public inputs, in exact order** (`policy.circom:63`): `[amount, dest, policy_commitment, allowlist_root, sigpayload_hi, sigpayload_lo]`.
- **Private inputs** (`policy.circom:26–29`): `cap, salt, path[16], index_bits[16]`.
- Constraints enforced: `amount, cap < 2^100` (`Num2Bits(100)`), `amount ≤ cap`, Merkle membership of `dest` under `allowlist_root`, `policy_commitment == Poseidon(cap, salt)`, and `sigpayload_hi/lo` range-bound (`Num2Bits(128)`) — the invocation binding (ARCHITECTURE §5).

**`circuits/disclosure.circom`** — `pragma circom 2.0.0`, `CapDisclosure()` (`disclosure.circom:37`):

- **Constraints: 824** (544 non-linear + 280 linear) — REPORT_VERIFY_TIER1.md.
- **2 public inputs**: `[policy_commitment, regulatory_max]` (`disclosure.circom:37`).
- **Private inputs**: `cap, salt` (`disclosure.circom:17–18`).
- Asserts `Poseidon(cap, salt) === policy_commitment ∧ cap ≤ regulatory_max` (`LessEqThan(100)`). The auditor learns only the boolean; the cap is never revealed.

Both circuits target the **same generic BN254 Groth16 verifier** on-chain; the disclosure proof verifies via a **vk swap** (PROTOCOL.md §3), no new contract.

## 2. Trusted-setup provenance (HONEST — consistent with SECURITY.md §8)

- **Phase 1:** the public **Hermez `powersOfTau28_hez_final_15`** powers-of-tau (2^15 = 32,768; covers the 9,402 constraints) — a multi-party ceremony (REPORT_DEPTH16.md §B, §A).
- **Phase 2:** a **single, fresh, local contribution** produced the deployed proving/verification keys (REPORT_DEPTH16.md §B). **This is a DEV setup, not a production ceremony:** phase-2 has one contributor, so a party that retained the phase-2 toxic waste could forge proofs — **a phase-2 compromise breaks soundness.** A production deployment **requires a multi-party phase-2 ceremony** (or a transparent-setup system). Stated identically in SECURITY.md §8.

**Committed artifacts (real sizes + sha256, the verification anchors):**

| Artifact | Size (bytes) | sha256 |
|---|---|---|
| `circuits/build/policy_final.zkey` | 4,507,630 | `dbe9849aa788247da999c09c876b58a3214370b66f8924718ffd49b84da70ac2` |
| `circuits/build/verification_key.json` | 3,836 | `66d804b1deb41244f63c777fb05cc8746aa3c576d8f36ea88e839c237ccca91f` |
| `circuits/build/policy_js/policy.wasm` | 1,804,328 | *(witness calculator)* |
| `circuits/build/disclosure_final.zkey` | 391,745 | `02b9110f3bcce0c57632d073e2344909c80dc07df68ab6a6404546ad7f2c0ab6` |
| `circuits/build/disclosure_vk.json` | 3,105 | `830812017a534e21df9f5842c4e7094fecab71de007ea1fb92557db03031edf6` |

> Reviewer note: the **phase-2 contribution command is not committed as a script** — the zkey/vkey
> artifacts above (with their hashes) are the committed evidence, and §6 reproduces the *proof and
> on-chain verify* from them. (Flagged in §8.)

## 3. Address → field encoding + golden vector

The allowlist leaf for an address is its **`dest_field`**, defined identically in the contract and the client:

```
addrToField(addr) = U256( sha256( xdr(ScVal::Address(addr)) )  with byte[0] = 0 )   // big-endian
```

(`contracts/covenant_account/src/lib.rs` `addr_to_field`; client `web/lib/poseidon.js` `addrToField` = `U256(sha256(Address.toScVal().toXDR()) , byte[0]=0)`.) Computing it **client-side** is what (a) lets a proof verify against the on-chain `dest_field` binding, and (b) keeps the allowlist in the browser (no `dest_field` RPC — SECURITY.md §4).

**Golden vector — client-side JS `addrToField` ≡ on-chain `dest_field`** (re-run against the deployed account `CANA5QYV…`; both columns identical):

| address | client `addrToField` = on-chain `dest_field` |
|---|---|
| `GBEOVHEZ…` (G) | `286103071656424117412880620840866802369366030803021886209497613222348234984` |
| `GCES7J7A…` (G) | `225358798824386335574909253758602147795716296517185140353457992786427938953` |
| `CBIELTK6…` (C, USDC SAC) | `434876735873296940524849344420632069569237535719074608570706991724706661005` |

**Golden vector — the client-side *sparse* tree reproduces a LIVE account's commitment + root.** Account `CA5PGJ65PUDND6XNO6USZ6WX4RYMI3ZNWHPJPDDE4G5MFJBWTS7E54FA` was created in-browser; rebuilding its policy from `cap=500000000`, `salt=86002717667906330598776412128047889623`, allowlist `[GBEOVHEZ…]` via `CovenantPoseidon.buildPolicyForAddresses` yields:

```
commitment = 13828430850036681054971484468800379982101659289833662393808527290468956613566   (matches keystore)
root       = 15278201483075821216927311687582186012363948746690962776716855817101893245834   (matches keystore)
```

That this same commitment/root is the account's **on-chain** committed policy is confirmed by that account's **successful** proof-authorized payment `f4dae3cb…` (REPORT_CREATE_FLOW.md §F) — a `BadPolicyBinding (#4)` mismatch would have failed it.

## 4. BN254 serialization finding (c1/c0 byte order) — empirically validated

snarkjs encodes a G2 point as `[[x_c0, x_c1], [y_c0, y_c1]]`. The Soroban BN254 host expects **c1-first, big-endian (EIP-197)**:

```
G2 (128 bytes) = be(x_c1) || be(x_c0) || be(y_c1) || be(y_c0)        // c1 FIRST
```

(`scripts/lib.mjs:1–4`, `web/lib/serialize.js`.) **Golden bytes — `vk_beta_2` serialized both ways:**

```
c1c0 (correct, EIP-197): 0967032fcbf776d1afc985f88877f182d38480a653f2decaa9794cbc3bf3060c
                         0e187847ad4c798374d0d6732bf501847dd68bc0e071241e0213bc7fc13db7ab
                         304cfbd1e08a704a99f5e847d93f8c3caafddec46b7a0d379da69a4d112346a71
                         739c1b1a457a8c7313123d24d2f9192f896b7c63eea05a9d57f06547ad0cec8
c0c1 (reversed)        : 0e187847ad4c798374d0d6732bf501847dd68bc0e071241e0213bc7fc13db7ab
                         0967032fcbf776d1afc985f88877f182d38480a653f2decaa9794cbc3bf3060c
                         1739c1b1a457a8c7313123d24d2f9192f896b7c63eea05a9d57f06547ad0cec8
                         304cfbd1e08a704a99f5e847d93f8c3caafddec46b7a0d379da69a4d112346a7
```

**Validated empirically against the DEPLOYED verifier** `CCKBPVP7MZJOQYU44RK5MG4PA2YKV4UQ7CJMPK3OIHNFHLG5PEMNDREG` (`verify_proof` simulation over a real policy proof, vk + proof serialized each way):

```
c1c0 (EIP-197) : verify_proof -> true
c0c1 (reversed): HostError: Error(Crypto, InvalidInput)
```

So the c1-first convention is **not a stylistic choice** — the reversed ordering yields invalid curve input on the host. Every successful on-chain verify in this repo uses `c1c0`. (Proof `a` is passed raw — the contract negates A itself; `lib.rs groth16_verify`.)

## 5. Poseidon parity (browser ≡ circomlibjs ≡ circuit/on-chain)

`web/lib/poseidon.js` (the dependency-free in-browser Poseidon used for client-side policy building) is **byte-identical** to circomlibjs and to the on-chain commitment. **Golden vector** — `Poseidon(cap, salt)` for the demo policy (`build/policy_secret.json`), computed three ways:

```
circomlibjs            : 20326128423241515686449026519755988889622554201640353473569591527972994051670
web/lib/poseidon.js    : 20326128423241515686449026519755988889622554201640353473569591527972994051670
on-chain POL (stored)  : 20326128423241515686449026519755988889622554201640353473569591527972994051670   ✓ all three equal
```

The on-chain value is the account's stored `policy_commitment` (`build/deployed_p2.json`). `web/lib/poseidon.js` is **generated** from poseidon-lite constants by `scripts/gen_poseidon_browser.mjs` and verified against circomlibjs (and, transitively, against the circuit's Poseidon, since the same commitment proves and verifies on-chain).

## 6. Reproduce it

A reviewer can regenerate a proof and verify it from the committed artifacts:

1. **Inputs** (the policy secret + the payment facts): `cap, salt, path[16], index_bits[16]` (private) and `amount, dest (=dest_field), policy_commitment, allowlist_root, sigpayload_hi, sigpayload_lo` (public).
2. **Witness + proof** — snarkjs over the committed circuit:
   ```js
   const { proof, publicSignals } =
     await snarkjs.groth16.fullProve(input,
       'circuits/build/policy_js/policy.wasm',
       'circuits/build/policy_final.zkey');
   // publicSignals order = [amount, dest, policy_commitment, allowlist_root, sigpayload_hi, sigpayload_lo]
   ```
3. **Verify off-chain:** `await snarkjs.groth16.verify(vk, publicSignals, proof) === true` (`vk = circuits/build/verification_key.json`).
4. **Verify on-chain** (the real check): `verify_proof(vkScVal(vk,'c1c0'), proofScVal(proof,'c1c0'), pubVecScVal(publicSignals))` on the deployed verifier `CCKBPVP7…` → `true` (demonstrated in §4).
5. **Cost decode:** from a real proof-authorized payment tx, `sorobanData.resources().instructions()` = **34,149,591 instr = 8.537%** of the 400,000,000 ceiling — constant across DEPTH-4/16 (REPORT_DEPTH16.md §F; ARCHITECTURE.md §6).

Runnable harnesses already in the repo: `scripts/test_circuits.mjs` (snarkjs prove+verify, policy + disclosure, 7/7), `scripts/create_trace_e2e.mjs` (client-side build, no allowlist leak), and the golden-vector computations reproduced in §3–§5.

## 7. See —

- **ARCHITECTURE.md** — how the proof + 6 public signals authorize a payment in `__check_auth`.
- **PROTOCOL.md** — the primitive and the disclosure-via-vk-swap extension.
- **[SECURITY.md](../SECURITY.md) §8** — trusted-setup security (the dev phase-2 limitation, stated identically).

## 8. Provenance — sources, and what could not be sourced

**Sourced from the repository (cited inline):**
- Circuit params, signal order, depth, ranges — `circuits/policy.circom`, `circuits/disclosure.circom`.
- Constraint counts (9,402 policy; 824 disclosure) — REPORT_DEPTH16.md §A, REPORT_VERIFY_TIER1.md.
- Artifact sizes + sha256 — measured this pass on `circuits/build/*` (reproduced in §2).
- ptau name + phase-2 = single local contribution — REPORT_DEPTH16.md §B.
- Golden vectors (addrToField≡dest_field; Poseidon parity; sparse reproduction; c1c0 vs c0c1) — re-run this pass against the deployed account `CANA5QYV…` and verifier `CCKBPVP7…`; exact outputs reproduced verbatim in §3–§5.
- Cost decode 34,149,591 = 8.537% — REPORT_DEPTH16.md §F.
- Live-account commitment/root match — `covenant-CA5PGJ65.keystore.json` + the on-chain success `f4dae3cb…` (REPORT_CREATE_FLOW.md §F).

**Could not source / flagged honestly:**
- **A committed phase-2 setup script** — none in the repo; the zkey/vkey artifacts (with hashes, §2) are the committed evidence, and §6 reproduces the *proof + verify*, not the setup. A reviewer cannot re-derive the keys without re-running a (single-contributor) phase-2.
- **The constraint sub-breakdown** (4,736/4,666 and 544/280) is taken from the build-time snarkjs r1cs info recorded in the reports, not re-derived in this pass.
- **A real iOS/Android proving measurement** — out of scope here (covered, and flagged as device-dependent, in REPORT_POLISH.md).
