# Nulth — ARCHITECTURE

> Doc 1 of the Nulth documentation set (the spine). Companion docs referenced in §8 are
> forthcoming. Every value here is pulled from the repository; see **§9 Provenance** for the
> source of each number and for anything that could not be sourced.
>
> Network: Stellar **testnet**, Protocol 26 · `soroban-sdk` 26.1.0 · circuit DEPTH-16.

---

## 1. Thesis

Nulth is the first Stellar account whose **signature is a zero-knowledge proof**. The ZK lives in **`__check_auth`** — the account's authorization predicate — **not** in a shielded token pool; the account has **no Ed25519 spending key**. A payment settles only if it proves, in zero knowledge, that it obeys a per-account policy **the chain has never seen** (a per-payment cap + a destination allowlist), with the proof verified **natively in-contract** via BN254 Groth16. The headline: *the chain enforces rules it cannot read.*

## 2. The privacy boundary (exact — load-bearing)

| | What | On-chain form |
|---|---|---|
| **HIDDEN** (never on-chain) | the per-payment **cap value**; the **unexercised allowlist** (members not yet paid to); the **rules-as-rules** (the policy structure `cap ∧ membership`) | only a Poseidon **commitment** `= Poseidon(cap, salt)` and a Poseidon-Merkle **allowlist_root** over 65,536 leaves are stored |
| **PUBLIC** (on-chain, like any Stellar tx) | the **executed payment's amount + destination** (the `token.transfer(from, to, amount)` args), the proof, and its 6 public signals | a normal SAC `transfer` + a Soroban auth entry carrying the proof |

**The point:** an executed Nulth payment is exactly as public as any Stellar payment — amount and recipient are visible. What is private is the **policy** that authorized it. The chain enforced `amount ≤ cap` and `dest ∈ allowlist` **without ever seeing the cap value or the allowlist in cleartext**.

> Precise note on the 6 public signals (`circuits/policy.circom:85`): `[amount, dest_field, policy_commitment, allowlist_root, sigpayload_hi, sigpayload_lo]`. The **amount** and **`dest_field`** (a hash of the destination) are public — consistent with the transfer itself being public. The **cap** and the **allowlist members** are *private* circuit inputs (`cap, salt, path[16], index_bits[16]`, `circuits/policy.circom:48–51`) and never appear in the proof's public signals or on-chain.

## 3. Components + data flow

```
  ┌─────────────────────────── BROWSER (client) ───────────────────────────┐
  │  policy secret: cap · salt · allowlist (NEVER leaves the browser)        │
  │        │                                                                 │
  │        ▼                                                                 │
  │  Web Worker prover  ──(snarkjs / Groth16 / BN254)──►  proof + 6 public   │
  │  web/lib/prover-worker.js                              signals (ProofSig)│
  └────────┬────────────────────────────────────────────────────────────────┘
           │  proof becomes the AUTH SIGNATURE of a Soroban authorization
           │  entry on a token.transfer(from=account, to, amount)
           ▼
  ┌─── relayer / fee-payer ───┐   submits the tx (pays XLM fees only;
  │  (NOT a prover; cannot     │   cannot authorize a spend)
  │   authorize a spend)       │
  └────────┬───────────────────┘
           ▼
  ┌──────────────────────── Stellar / Soroban host ─────────────────────────┐
  │  CovenantAccount.__check_auth(payload, ProofSig, contexts):              │
  │    bindings (policy · sigpayload · context · token · from · amount ·     │
  │    dest)  +  native BN254 Groth16 pairing check                          │
  │       │ Ok                                  │ Err(AccError #1–18)        │
  │       ▼                                      ▼                           │
  │  USDC SAC transfer executes            tx fails; 0 bytes state modified  │
  └──────────────────────────────────────────────────────────────────────────┘
```

- **Client-side prover** (`web/lib/prover.js` + `web/lib/prover-worker.js`): the cap, salt and allowlist are generated and held in the browser; proving runs **off the main thread in a Web Worker** (with an inline fallback if Workers are unavailable). Only the proof and its 6 public signals leave the device.
- **The "signature":** the proof + public signals are packed as a `ProofSig { a, b, c, pub_signals }` (`contracts/covenant_account/src/lib.rs:72–79`) and attached as the signature of the account's Soroban authorization entry on a `token.transfer`.
- **`__check_auth`** runs the bindings and the native pairing check (§4). On `Ok`, the SAC transfer executes; on any failure the transaction fails and **no state is modified**.
- **Backend, named honestly:** there is **no production backend prover**. The reference deployment uses (a) an **operator fee-payer key** purely to **submit/relay** transactions (it pays XLM fees — in production this is a gasless relayer/wallet, PRD §14); and (b) **only for the `/agent` route**, a **self-hosted server-side operator instance** (`scripts/agent_server.mjs`) that holds a policy secret and proves server-side — disclosed as an *operator*, not a shared prover service. Chain reads (balance/policy/activity) go through **Stellar RPC** (a read/indexer layer), not a custom backend. No third party ever holds a spending key, because none exists.

## 4. `__check_auth` — state machine, happy path, every failure state

**Atomic construction (no uninit window).** `__constructor(vk, policy_commitment, allowlist_root, token, admin)` (`lib.rs:109–127`) sets `VK · POL · ROOT · TOKEN · ADMIN`, sets `FROZEN=false`, and emits an `init` event — all in the deploy transaction. It rejects a malformed verification key at construction: `vk.ic.len() != N_PUBLIC + 1` (i.e. `!= 7`) → **`MalformedVk` (#14)**.

**Happy path / gate order** (`lib.rs:233–335`) — a payment authorizes iff *every* gate passes, in this order:

0. load `VK/POL/ROOT/TOKEN` (absent ⇒ `NotInit #1`)
1. **frozen gate, before any binding/pairing work** — `FROZEN` ⇒ `AccountFrozen #17`
2. signal count must be 6 ⇒ else `BadSignalCount #8`
3. **policy binding** — `sig.policy_commitment == POL && sig.allowlist_root == ROOT` ⇒ else `BadPolicyBinding #4`
4. **sigpayload binding** — the two 128-bit halves of *this* invocation's `signature_payload` match `sig.sigpayload_hi/lo` ⇒ else `BadSigPayload #13`
5. **exactly one context** — 0 ⇒ `NoContext #15`; >1 ⇒ `TooManyContexts #16`
6. context is a `transfer` call ⇒ else `BadContext #7`
7. **token pinning** — the call targets the stored `TOKEN` ⇒ else `BadTokenBinding #10`
8. **`from == self`** (no confused deputy) ⇒ else `BadFromBinding #11`
9. **amount range, in-contract** — `amount < 0` ⇒ `NegativeAmount #9`; `amount ≥ 2^100` ⇒ `AmountTooLarge #12` (range is re-checked in-contract, not trusted to the circuit alone)
10. **amount binding** — `U256(amount) == sig.amount` ⇒ else `BadAmountBinding #5`
11. **dest binding** — `addr_to_field(to) == sig.dest_field` ⇒ else `BadDestBinding #6`
12. **native Groth16 pairing** verifies against the stored VK ⇒ else `BadProof #3` → otherwise **`Ok(())`**

**Full error surface** (`#[contracterror] enum AccError`, `lib.rs:38–59`):

| # | Code | Triggered when |
|---|---|---|
| 1 | `NotInit` | instance storage missing (pre-construction) |
| 2 | `AlreadyInit` | **reserved** — defined but never returned (0 refs in `lib.rs`): the Soroban constructor is single-shot (host-enforced), so a re-init never reaches contract code |
| 3 | `BadProof` | Groth16 pairing check fails (e.g. malleated/forged proof) |
| 4 | `BadPolicyBinding` | proof's commitment/root ≠ the account's committed policy (substitution / rotated-away) |
| 5 | `BadAmountBinding` | transfer amount ≠ the proven amount |
| 6 | `BadDestBinding` | transfer destination ≠ the proven `dest_field` (redirect) |
| 7 | `BadContext` | context is not a well-formed `transfer(from,to,amount)` |
| 8 | `BadSignalCount` | `pub_signals.len() != 6` |
| 9 | `NegativeAmount` | `amount < 0` |
| 10 | `BadTokenBinding` | context targets a token ≠ the pinned SAC |
| 11 | `BadFromBinding` | `transfer.from != self` |
| 12 | `AmountTooLarge` | `amount ≥ 2^100` (shared range bound with the circuit) |
| 13 | `BadSigPayload` | proof not bound to this invocation's `signature_payload` (replay / lifted proof) |
| 14 | `MalformedVk` | VK has `ic.len() != 7` at construction |
| 15 | `NoContext` | empty context set (would be a blanket approval) |
| 16 | `TooManyContexts` | more than one context (would be an N-fold spend) |
| 17 | `AccountFrozen` | admin has frozen the account (gate #1, before pairing) |
| 18 | `Unauthorized` | **reserved** — non-admin governance calls are rejected by `admin.require_auth()` (host-enforced) before any body runs, so this code is never returned in practice (`lib.rs:56–58`) |

Live, the host collapses every `__check_auth` failure to `Error(Auth, InvalidAction)` to an outside observer (no attacker oracle); the precise `#N` is read from simulation. (See ADVERSARIAL_TESTING.md.)

## 5. Replay design (bounded, correct — no hand-rolled nullifier)

Replay is closed by **two composed properties** (`lib.rs:17–18, 267–271`):

1. **`signature_payload` binding (in-proof).** The circuit takes `sigpayload_hi/lo` as public inputs — the two 128-bit halves of the host's `signature_payload` for this auth entry, i.e. `sha256(xdr(HashIdPreimage::SorobanAuthorization{ networkId, nonce, signatureExpirationLedger, invocation }))`. Gate #4 checks these halves equal the *actual* payload of the invocation being authorized. A proof is therefore **non-transferable** and bound to exactly one `(account, nonce, invocation)`.
2. **Host-native nonce consumption.** Soroban's auth framework consumes each `(address, nonce)` **once, on a successful** apply. There is **no hand-rolled nullifier storage** in the contract.

Consequences:
- **Cannot replay** a settled proof: its `(address, nonce)` is already consumed by the host (`Error(Auth, ExistingValue)`).
- **Cannot lift** a proof onto a different invocation/nonce: the `signature_payload` no longer matches → `BadSigPayload #13`.
- **Cannot double-spend.**
- A **failed** transaction does **not** consume the nonce (it reverts), so the same intent is **retryable**.

Because replay is closed without a per-nonce storage write, the verify cost (§6) carries **no nullifier-write overhead** — it is constant.

## 6. Cost (measured, decoded — not estimated)

**Pure Groth16 verify = 34,149,591 instructions = 8.537% of the 400,000,000-instruction ceiling.** This is **constant — independent of allowlist depth**: it is a function of the **6 public inputs and the pairing**, not of the Merkle tree size. It is **byte-identical at DEPTH-4 and DEPTH-16 (Δ = 0)**, decoded from a real proof-authorized payment transaction envelope via `sorobanData.resources().instructions()` (REPORT_DEPTH16.md §F; mirrored in `web/config.js` as `costInstr: '34,149,591'`, `costPct: '8.537'`).

**Total transaction cost varies slightly with Soroban storage**, like any Stellar transaction: e.g. a payee's **first receive** writes a new SAC balance entry, pushing a measured live payment to **≈34,254,340 instr / ≈8.56%** (observed in the create→pay cycles, REPORT_CREATE_FLOW.md / REPORT_POLISH.md). The **8.537%** figure is the **verify cost**; the small delta to a live total is SAC transfer storage/IO, not proof verification.

In-browser proving (the client-side step, not the on-chain verify): **~0.7–0.9 s, ~50 MB peak JS heap** on desktop (REPORT_POLISH.md; ~865 ms originally measured in REPORT_DEPTH16.md §H).

## 7. Deployment facts (real testnet)

| Component | Value | Source |
|---|---|---|
| Governance account (the deployed `CovenantAccount`) | `CANA5QYVHNON7AV752ZRATFW2T5BMS3MU5DDPJMU5UGSR3KSH45LOGZE` | `web/config.js`, `build/deployed_p2.json` |
| Shared BN254 verifier (generic Groth16) | `CCKBPVP7MZJOQYU44RK5MG4PA2YKV4UQ7CJMPK3OIHNFHLG5PEMNDREG` | `web/config.js` |
| USDC SAC (pinned token) | `CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA` | `web/config.js` |
| USDC issuer (Circle Stellar-testnet USDC) | `GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5` | `web/config.js` |
| Account WASM hash (new accounts = `createContractV2` against this) | `7170207590fce2398ba94ffdbc96282444e02897112f05c73c63af93ba847411` | `web/config.js`, `build/deployed_p2.json` |
| Governance admin (disclosed; cannot move funds) | `GDSY6EO672YWIL5VPQJ2O4IIHFTXIMR763R7SMSMBRDQKNGTHNAJWVBU` | `web/config.js`, `build/deployed_p2.json` |
| Constructor deploy tx | `7349075a28e89c8784a12c5c76fcbc35ccd3e0355a7bf937eb2a8461d62fa093` | `build/deployed_p2.json` |
| WASM upload tx | `8cd5edd45bfa8d493deaf580a917a4d4a1aab04ee92dd6243ad35f5b4b8fe9bd` | `build/deployed_p2.json` |

**Circuit parameters** (`circuits/policy.circom`):

| Parameter | Value | Source |
|---|---|---|
| Template / depth | `PaymentPolicy(16)` → **DEPTH-16** | `policy.circom:85` |
| Allowlist capacity | **65,536** leaves (2^16) | `policy.circom` DEPTH=16; `web/config.js slots: '65,536'` |
| Public inputs | **6** → `[amount, dest, policy_commitment, allowlist_root, sigpayload_hi, sigpayload_lo]` | `policy.circom:85`; `lib.rs:98 N_PUBLIC=6` |
| VK `ic` length | **7** (`ic[0]` + one per public input) | `lib.rs:97` |
| Constraints | **9,402** (4,736 non-linear + 4,666 linear) | REPORT_DEPTH16.md §A |
| Trusted setup | Hermez `powersOfTau28_hez_final_15` (2^15) | REPORT_DEPTH16.md §B |
| Amount range | `Num2Bits(100)` → amount < 2^100 (matched in-contract, `lib.rs:100`) | `policy.circom:54`, `lib.rs:100` |

**Test surface:** `cargo test -p covenant-account` → **34 / 34** (`web/config.js tests`, REPORT_GOVERNANCE.md); circuit golden/abort tests → **7 / 7** (`scripts/test_circuits.mjs`); **5** headless real-testnet e2e drivers (`web_e2e`, `disc_e2e`, `deck_e2e`, `agent_e2e`, `account_e2e`).

## 8. Not covered here — see (this documentation set)

This file is the spine; it is deliberately not a monolith.

- **PROTOCOL.md** — the keyless-account primitive and the Soroban `CustomAccountInterface` standard; the `ProofSig` "signature" format and the snarkjs→BN254 serialization.
- **[SECURITY.md](../SECURITY.md)** (canonical threat model) — adversaries and trust boundaries, including the **admin trust root**: the admin can rotate the committed policy and freeze/unfreeze, and **cannot spend in one step** (every spend needs a valid proof for the committed policy) but **can** rotate the committed policy to one it controls and then spend (two observable, event-emitting steps) — a full governance trust root; multisig + timelock + epoch-grace rotation are the documented hardening.
- **CIRCUIT_VERIFICATION.md** — the address→field encoding and golden vectors (client-side `addrToField` ≡ on-chain `dest_field`), trusted-setup provenance, and proof/verify reproduction.
- **ADVERSARIAL_TESTING.md** — the attack matrix (malleability #3, redirect/lift #13, old-policy #4, wrong-token #10, frozen #17, …) with real FAILED testnet txs and the per-mode `AccError` decode.

## 9. Provenance — where each value came from (and what could not be sourced)

Sourced from the repository (cited inline above):
- **Error codes 1–18** — `contracts/covenant_account/src/lib.rs:38–59` (verbatim enum). Reachability verified by grep: every code is returned at ≥1 site **except** `AlreadyInit` (#2) and `Unauthorized` (#18), which are **reserved (0 refs)** — #2 because the constructor is host-enforced single-shot, #18 because non-admin governance calls are rejected by `admin.require_auth()` before any body runs.
- **`__check_auth` gate order + bindings** — `lib.rs:233–335`; atomic constructor — `lib.rs:109–127`.
- **Replay design** — `lib.rs:17–18` (module doc) + `lib.rs:262–271` (policy + sigpayload binding).
- **Contract IDs, admin, WASM hash, USDC SAC/issuer, deploy txs** — `web/config.js` and `build/deployed_p2.json` (identical values cross-checked).
- **Circuit params** (DEPTH-16, 65,536, 6 public inputs, `ic`=7, range 2^100) — `circuits/policy.circom:48–85` + `lib.rs:97–100`.
- **Constraint count (9,402 = 4,736 + 4,666), ptau 2^15, ~865 ms browser prove** — REPORT_DEPTH16.md §A/§B/§H.
- **Verify cost 34,149,591 = 8.537% (constant, Δ=0 across depth)** — REPORT_DEPTH16.md §F + `web/config.js`.
- **Live total ≈34,254,340 / ≈8.56% on a first receive** — REPORT_CREATE_FLOW.md / REPORT_POLISH.md (measured this session).
- **Desktop proving ~0.7–0.9 s, ~50 MB heap** — REPORT_POLISH.md.
- **Test counts** — `cargo` 34 (REPORT_GOVERNANCE.md / `web/config.js`), circuit 7 (`scripts/test_circuits.mjs`), 5 e2e drivers (`scripts/*_e2e.mjs`).
- **soroban-sdk 26.1.0** — `contracts/covenant_account/Cargo.toml`. **Protocol 26 / testnet** — `web/config.js` (`networkPassphrase`) + report headers.

**Could not source / intentionally omitted (not invented here):**
- A **mainnet** deployment — none exists; mainnet is held for post-audit (the UI Mainnet tab is disabled). No mainnet IDs are stated.
- A **real iOS Safari / Android Chrome** proving measurement — not measurable in the build environment (no physical device; the desktop numbers above are the only first-party measurement). Flagged in REPORT_POLISH.md as requiring on-device confirmation.
- **Per-leaf proving-memory at the 2^16 tree build** in-browser — account *creation* uses a sparse builder (O(N·16)); the 264 MB figure for a full 65,536-leaf build is a **Node** measurement (REPORT_DEPTH16.md §C), not a browser number, and is not claimed as a browser cost.
