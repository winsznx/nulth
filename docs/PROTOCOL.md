# Nulth — PROTOCOL

> Doc 2 of the Nulth documentation set. This file is about Nulth as a **reusable primitive**
> and a **proposed pattern**, plus the forward roadmap. It references **ARCHITECTURE.md** for all
> internals/mechanics and does not re-explain them.
>
> **Honesty contract:** things claimed as *built* are cited to the repository; everything
> forward-looking is labeled **ROADMAP** or **PROPOSAL** and is **not** part of this submission.
> No funding, valuation, or market-size claims — this is a protocol document, not a pitch.

---

## 1. The primitive

**A Soroban custom account whose authorizer is a zero-knowledge proof of policy compliance.**

This abstraction is separable from Nulth-the-app. The general pattern: for any spending policy `P` expressible as an arithmetic circuit over *(public payment facts, hidden policy state)*, the account can gate `__check_auth` on a proof that the payment satisfies `P` —

1. the account stores only a **commitment** to the policy on-chain;
2. a spend carries a **Groth16 proof** that the *public* payment facts (amount, destination) satisfy `P` under the *hidden* committed policy;
3. `__check_auth` verifies the proof natively (BN254) and **binds** it to the actual transfer and to this invocation (ARCHITECTURE §4–5).

**Nulth is one instantiation** of the primitive, with `P = (amount ≤ cap) ∧ (dest ∈ allowlist)`, where the allowlist is a Poseidon-Merkle tree (DEPTH-16, 65,536 leaves) and the cap is committed via `Poseidon(cap, salt)` (real: `contracts/covenant_account/src/lib.rs`, `circuits/policy.circom`). The primitive itself is **policy-agnostic**: a different circuit + committed public inputs yields a different policy-account — velocity limits, time-windows, multi-party thresholds, balance floors, etc. *(Those alternatives are illustrative of the abstraction; only the cap-∧-allowlist instantiation is built here.)*

## 2. The interface a compatible implementation satisfies — a PROPOSED pattern

> **This is a proposal, not an adopted standard.** No SEP/CAP is being claimed or ratified. It
> documents what a *different* team would implement to build a compatible policy-account, drawn
> from Nulth's reference implementation.

A compatible policy-account:

- **Signature = a proof.** Implements `CustomAccountInterface` with `type Signature = ProofSig { a, b, c, pub_signals }` — the Groth16 proof and its public signals *are* the authorization signature (`lib.rs:72–79`). There is no Ed25519 spending key.
- **Public-signal vector** carrying three binding groups:
  - **policy commitment(s)** — Nulth uses `policy_commitment` (cap commitment) + `allowlist_root`;
  - **payment facts** — `amount` + `dest_field` (a hash of the destination);
  - **replay binding** — the host `signature_payload` split into field-sized halves (`sigpayload_hi`, `sigpayload_lo`).
  Nulth's instantiation is the 6 signals `[amount, dest_field, policy_commitment, allowlist_root, sigpayload_hi, sigpayload_lo]` (`circuits/policy.circom:85`).
- **Commitment binding** — the proof's commitment public inputs MUST equal the account's stored commitment(s) (anti-substitution → `BadPolicyBinding`).
- **Payment binding** — the proof's payment public inputs MUST equal the actual `transfer` args (anti-redirect → `BadAmountBinding` / `BadDestBinding`).
- **Replay binding** — a public input MUST equal *this* invocation's `signature_payload` (non-transferable, one-shot → `BadSigPayload`; ARCHITECTURE §5).
- **Context discipline** — exactly one context, the call is `transfer` on the **pinned** token, `from == self` (ARCHITECTURE §4).
- **Optional governance module** — `admin` + `rotate_policy(new_commitment, new_root)` + `freeze` / `unfreeze` (Nulth ships this; `lib.rs`). *Optional:* a policy-account may be immutable (no admin) instead.

To build one: write a circuit for your policy, deploy or **reuse a generic BN254 Groth16 verifier**, and implement `__check_auth` with the bindings above. Nulth is a working **reference implementation** — account `CANA5QYVHNON7AV752ZRATFW2T5BMS3MU5DDPJMU5UGSR3KSH45LOGZE`, shared verifier `CCKBPVP7MZJOQYU44RK5MG4PA2YKV4UQ7CJMPK3OIHNFHLG5PEMNDREG` (`web/config.js`).

## 3. The disclosure extension (Tier-1)

A **second circuit** proves a *property* of the hidden policy to an auditor without revealing it: **`cap ≤ regulatory_max`**, plus a commitment opening that binds the proof to the account's *real* committed cap. Public inputs `[policy_commitment, regulatory_max]`; private `[cap, salt]`; the circuit asserts `Poseidon(cap, salt) === policy_commitment ∧ cap ≤ regulatory_max` (`circuits/disclosure.circom`). 824 constraints; the auditor learns only the boolean `cap ≤ regulatory_max`, never the cap.

Crucially, it is **verified on-chain by the SAME deployed generic BN254 verifier via a vk swap** — `verify_proof(vk, proof, pub_signals)` is generic over the vk and the number of public signals, so the disclosure proof (`nPublic=2`, `IC.len=3`) verifies on the already-deployed verifier `CCKBPVP7…` with **no new contract** (REPORT_VERIFY_TIER1.md; `web/lib/chain.js verifyDisclosure` calls `C.verifier`). Real: an in-browser disclosure proof (173 ms) returns `verify_proof → true` on-chain; below-cap limits make the circuit unsatisfiable (truthful refusal). This **generalizes**: any provable property of the committed policy is a disclosure circuit reusing the same verifier. See **CIRCUIT_VERIFICATION.md** for circuit/vector details.

## 4. Use-cases — one substrate, two markets

> **Honest framing:** Nulth *fits* these; these are working demonstrations on testnet, **not**
> deployed customers. No market-size claims.

- **(a) Confidential institutional treasury.** A treasury hides *who it may pay* (the vendor allowlist) and *how much per payment* (the cap) — the **policy** is private — while it settles in **public USDC**. The app demonstrates this end-to-end on testnet: a 65,536-slot private allowlist + a hidden per-payment cap, with real proof-authorized USDC transfers and a Tier-1 cap disclosure to an "auditor" (REPORT_DEPTH16.md, REPORT_VERIFY_TIER1.md).
- **(b) Un-jailbreakable agent wallets.** An autonomous agent can move fast but is **mathematically constrained** from acting outside policy: if prompt-injected to drain to a non-allowlisted address, *no valid proof exists* — witness generation aborts and **no transaction is ever formed** (plus an on-chain backstop the chain rejects). Demonstrated by the `/agent` route (a real LLM agent + the client-side prover guardrail + the on-chain rejection; REPORT_AGENT_DECK.md). The agent's service-payment path is a **self-hosted, allowlisted operator path — not the strict x402 wire protocol** (disclosed).

Both are the **same `__check_auth` substrate**; only the operator differs (a human treasury vs an autonomous agent).

## 5. Positioning vs adjacent work (complementary, not competing)

At the category level, **privacy pools / shielded-pool designs** (e.g. the line of work including Nethermind's SPP) provide **transaction-privacy** — they hide payment **amounts** and sender/receiver **linkage**. **Nulth provides authorization-privacy** — it hides the spending **policy** (the cap value + the allowlist), while the executed transfer stays public.

These are **different points in the design space and are complementary**: a treasury wanting *both* confidential amounts *and* a private policy could compose a privacy pool (for the value transfer) with a Nulth-style policy authorizer (for the spend rule). Nulth's distinct cell is **ZK in the authorization layer (`__check_auth`)**, not the value-transfer layer. *(This is a respectful comparison of design goals, not a claim about any specific system's internals.)*

## 6. Why it fits Stellar / Soroban specifically (a genuine property of the design)

- **Enforced at spend time, in the account itself.** Policy lives in `__check_auth` — no separate enforcement contract, no shielded pool to join or exit.
- **No shielded note-set.** There is no anonymity set to maintain and no deposit/withdraw lifecycle.
- **No contract-level per-spend state — the nullifier is designed out.** The Nulth *contract* writes **no per-spend state**: there is no nullifier/note set. Replay is instead closed by the **host's native `(address, nonce)` consumption** — the standard Soroban auth mechanism, which manages **temporary, TTL-bounded** ledger entries itself — plus the in-proof `signature_payload` binding (ARCHITECTURE §5). That host-managed nonce set is *not* a Nulth-maintained structure that grows with usage. Consequence on Stellar/Soroban: there is **no contract-level note/nullifier set to scan**, so Nulth introduces **no event-history indexer and no archival-RPC dependency**; the contract's own footprint is just **standard instance storage** (`VK · POL · ROOT · TOKEN · ADMIN · FROZEN`) under normal TTL.
- **Constant verify cost — a separate property.** Groth16 verification is a function of the **6 public inputs and a fixed pairing**, **independent of the allowlist/circuit size** (ARCHITECTURE §6). This is a property of Groth16 itself, distinct from the storage point above — it is *not* a consequence of writing nothing per spend.

Net: a policy-account is cheap to run on Stellar — standard RPC, standard TTL, no contract-level per-spend writes, and a constant Groth16 verify cost.

## 7. Roadmap — direction, NOT shipped

> Everything in this section is **future / not built / not part of this submission.** The hackathon
> deliverable is the standalone **policy-account contract + circuits + app**, judged on its own merit.

- **Primitive → reference policy-account wallet (ROADMAP).** A user-facing wallet in which "accounts" are policy-accounts. Today's seed of this is the app's **self-serve create flow** (creating and using your own policy-account *is* built — REPORT_CREATE_FLOW.md); a full wallet is roadmap.
- **→ an open pattern / SDK for Soroban (ROADMAP).** Package the `__check_auth` bindings, a circuit scaffold, and the snarkjs→BN254 serialization (built and proven in this repo) as a reusable library so any team can ship a compatible policy-account.

**PROPOSAL (illustrative interface sketch — not implemented):**

```rust
// PROPOSAL — NOT shipped in this submission. Sketch of a reusable policy-account interface.
trait PolicyAccount {
    // atomic init: verification key, policy commitment(s), pinned token, optional admin
    fn __constructor(vk: VerificationKey, commitments: Commitments, token: Address, admin: Option<Address>);
    // the authorizer: verify the proof + bind commitment(s), payment facts, and signature_payload
    fn __check_auth(payload: Hash, sig: ProofSig, contexts: Vec<Context>) -> Result<(), Error>;
    // optional governance module (omit for an immutable policy-account)
    fn rotate_policy(new_commitments: Commitments);
    fn freeze();
    fn unfreeze();
}
// + a circuit template:  public[payment facts, commitment(s), sigpayload halves]  private[policy witness]
// + a generic BN254 Groth16 verifier (reusable across policies and disclosure circuits; Nulth's is live)
```

None of the SDK or the full wallet is shipped here; the bindings, circuits, serialization, and disclosure-via-vk-swap that the SDK *would* package are the parts that are already real (cited above).

## 8. See —

- **ARCHITECTURE.md** — the internals/mechanics (data flow, the `__check_auth` state machine + error codes, replay, cost decode, deployment facts).
- **[SECURITY.md](../SECURITY.md)** (canonical threat model) — adversaries, trust boundaries, and the **admin trust root** (the admin cannot spend in one step but can rotate-then-spend), plus stated limits.
- **CIRCUIT_VERIFICATION.md** — the address→field golden vectors, trusted-setup provenance, and proof/verify reproduction.

## 9. Provenance — built (cited) vs roadmap (labeled), and what wasn't sourced

**Built / real (cited):**
- The primitive + Nulth's instantiation — `contracts/covenant_account/src/lib.rs`, `circuits/policy.circom`.
- The interface bindings (signal vector, commitment/payment/sigpayload binding, one-context, token-pin, governance module) — `lib.rs` (cross-referenced to ARCHITECTURE §4–5).
- Reference deployment ids — account `CANA5QYV…`, shared verifier `CCKBPVP7…` — `web/config.js`, `build/deployed_p2.json`.
- Tier-1 disclosure (circuit, 824 constraints, public `[policy_commitment, regulatory_max]`, on-chain verify via vk swap on the **same** verifier, 173 ms browser proof) — `circuits/disclosure.circom`, `web/lib/chain.js`, REPORT_VERIFY_TIER1.md.
- Use-case demonstrations — treasury (REPORT_DEPTH16.md), agent jailbreak (REPORT_AGENT_DECK.md), self-serve create (REPORT_CREATE_FLOW.md).
- Stellar-fit properties (no nullifier write, constant verify, instance-storage-only footprint) — derived from ARCHITECTURE §5–6 (`lib.rs` replay design).

**Roadmap / proposal (labeled, NOT shipped):** the "compatible-implementation interface" as an *adopted standard* (it is a **proposal**); the reference **wallet**; the open **SDK** and the interface/circuit sketch in §7.

**Could not source / intentionally not claimed:**
- Specifics of any third-party privacy-pool system (incl. SPP) beyond the category-level property (hides amounts/linkage) — **not fabricated**; the comparison is kept at the design-goal level.
- The alternative policies in §1 (velocity, time-window, multi-party, …) — **illustrative of the abstraction, not built.**
- Any funding/valuation/market figures — **deliberately none** (out of scope for a protocol doc).
