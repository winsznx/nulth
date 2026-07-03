# Nulth — Security Model & Threat Model

> **Canonical threat document.** This is the single source of truth for Nulth's
> adversaries, trust roots, privacy boundary, cryptographic assumptions, and stated limits.
> The README and the `docs/` constellation link here; `docs/THREAT_MODEL.md` is a pointer to
> this file.
>
> **Honesty contract:** every guarantee is stated **exactly as strong as it is proven** and cites
> its on-chain evidence; every limit is stated **plainly**; anything **recommended but not built** is
> labeled as such. Network: Stellar **testnet** only — no mainnet, no formal audit (§13).

## Summary

Nulth's authorization surface is a Groth16 ZK proof. The account has **no Ed25519 spending key**.
A payment executes only if the prover can produce a witness satisfying four simultaneous constraints:
**policy binding, spend cap, allowlist membership, and transaction binding**. This document states what
the proof guarantees, what it does not, and where the real trust roots are.

---

## 1. What the ZK proof guarantees

For any payment that clears `__check_auth`:

| Property | Circuit constraint | What it means |
|----------|--------------------|----------------|
| Policy binding | `Poseidon(cap, salt) = policy_commitment` | The prover knows the cap and salt that produced the on-chain commitment |
| Spend cap | `amount ≤ cap` with 100-bit range checks | No single payment can exceed the policy cap |
| Allowlist membership | Poseidon-Merkle path opens to `allowlist_root` | The destination address is in the committed 65,536-slot allowlist |
| Transaction binding | `pub_signals[4,5]` = split of live `signature_payload` | The proof is bound to this exact nonce, expiration, and invocation |

All four must hold simultaneously. A forged witness requires knowing `(cap, salt, path[], pathIndices[])`
— all private, none touching the chain.

---

## 2. `__check_auth` gate order

Every invocation passes **11** sequential guards (after loading `vk`, `policy_commitment`,
`allowlist_root`, `token`). Earlier guards return cheap, specific error codes; the Groth16 pairing check
runs last. The full step-by-step enumeration is in **[docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) §4**.

```
1.  frozen == true         → AccountFrozen        #17
2.  pub_signals.len() == 6 → BadSignalCount        #8
3.  signals[2,3] == stored → BadPolicyBinding      #4
4.  signals[4,5] == payload→ BadSigPayload         #13
5.  |auth_contexts| == 1   → NoContext #15 / TooManyContexts #16
6.  fn_name == "transfer"  → BadContext            #7
7.  ctx.contract == token  → BadTokenBinding       #10
8.  ctx.args.from == self  → BadFromBinding        #11
9.  0 < amount < 2¹⁰⁰     → NegativeAmount #9 / AmountTooLarge #12
10. signals[0,1] == args   → BadAmountBinding #5 / BadDestBinding #6
11. Groth16 verify         → BadProof              #3
```

The enum declares 18 variants, but **two are reserved and never returned**: `AlreadyInit` (#2) — the
constructor is host-enforced single-shot — and `Unauthorized` (#18) — non-admin governance calls are
rejected by the host (`admin.require_auth()`) before any body runs (§9). **16 codes are active.**

---

## 3. Adversaries and outcomes

An outside observer sees every failed `__check_auth` identically as `Error(Auth, InvalidAction)` (§9);
the precise `AccError #N` below is read from **simulation**, where the caller already controls the inputs.

| Adversary | Capability | Outcome | Evidence |
|-----------|-----------|---------|----------|
| **Thief without the policy secret** | No spending key exists; wants to move funds | No satisfying witness can be produced → proving aborts → **no transaction forms** | "no proof ⇒ no tx" |
| **Proof copier** | Lifts proof from mempool, resubmits on a fresh nonce | `BadSigPayload` #13 — proof is bound to the original `signature_payload` | FAILED `bd424c94…` |
| **Replay attacker** | Resubmits a settled transaction (same auth entry) | Host-level `Error(Auth, ExistingValue)` — nonce consumed on first settlement | `scripts/replay_same.mjs` (§7) |
| **Amount manipulator** | Intercepts XDR, changes `amount` | `BadAmountBinding` #5 — `pub_signals[0]` committed at prove time | `test_amount_binding` |
| **Destination redirector** | Changes `dest` in the invocation context | `BadDestBinding` #6 — `pub_signals[1]` committed at prove time | `test_dest_binding`; redirect FAILED `8cc47419…` |
| **Token substituter** | Replaces USDC SAC with XLM SAC | `BadTokenBinding` #10 — token pinned at `init()`, checked at gate 7 | FAILED `84ba7fbc…` |
| **Function substituter** | Calls `burn()` instead of `transfer()` | `BadContext` #7 — `fn_name` check at gate 6 fires **before** the token gate | `test_bad_context_burn_fn` |
| **Multi-context attacker** | Submits 2+ auth contexts for blanket approval | `TooManyContexts` #16 — exactly-one-context gate | `test_two_contexts_rejected` |
| **Stale-policy replayer** | Holds old proof, admin rotates policy | `BadPolicyBinding` #4 — stored commitment no longer matches | deck FAILED `fc9b3e43…`; governance FAILED `3411ef29…` |
| **Malformed-VK attacker** | Provides `vk` with wrong `ic` length at init | `MalformedVk` #14 — caught at construction, before storage | `test_malformed_vk_rejected_at_construction` |
| **Rogue / prompt-injected AI agent** | Injected to drain to a non-allowlisted address | Witness generation fails (address not in the allowlist tree); backstop: chain rejects a hand-crafted proof | agent SUCCESS `f23be708…`; backstop FAILED `19e4bd88…` |
| **Compromised browser session** (holds the policy secret) | Has `(cap, salt, allowlist[], path[])` | Can drain **up to `cap` per payment, only to allowlisted destinations** — cannot exceed the cap or the allowlist | by construction |
| **Malicious RPC / relayer** | Relays or refuses to relay; serves reads | **Censorship / availability only** — cannot forge a spend and cannot learn the allowlist (client-side encoding, §4) | §4 network trace |
| **Malicious / compromised admin** | Holds the admin key | Cannot spend in one step, **but can `rotate_policy` then spend in two observable steps** — the primary trust boundary (§5) | §5 |

---

## 4. Privacy guarantee — exact

**HIDDEN** (never on-chain): the per-payment **cap value**, the **unexercised allowlist** (members not
yet paid), and the **rules-as-rules** (the policy structure). On-chain, the policy is only a Poseidon
**commitment** `Poseidon(cap, salt)` plus a Poseidon-Merkle **`allowlist_root`** (65,536 leaves) — neither
reveals anything about the cap or the members.

**PUBLIC** (on-chain, like any Stellar payment): the **executed payment's amount and destination** (the
`token.transfer` args), the proof, and its 6 public signals (which include `amount` and `dest_field`).

**RPC side-channel — closed.** Converting an allowlist address to its field element
(`addr → dest_field`) is performed **fully client-side** (no `dest_field` RPC simulation at policy-build
time), so **no allowlist address leaves the browser**. Even a curious RPC provider learns nothing about
the allowlist — it sees only the public commitment + root. **Evidence:** a network trace built a policy in
a real headless browser with a unique allowlist address and observed **0 network requests during the build,
the address present in 0 of them** (`scripts/create_trace_e2e.mjs`, REPORT_TRUTH_FIXES.md §GAP 1).

**Stated limits of the privacy:** (a) at *pay* time, the destination being paid is public anyway — it is
the transfer recipient; the privacy protects the *unexercised* allowlist and the cap, not the fact of a
payment you make. (b) A policy **rotation** is observable: `rotate_policy` emits an event and the stored
`policy_commitment`/`allowlist_root` change, so an observer learns the policy *changed* — never its
*content*.

---

## 5. Trust roots

### The prover (account owner)
Holds `(cap, salt, allowlist[], path[])`. These never touch a server. The policy secret is **encrypted at
rest** — AES-256-GCM with a key derived via PBKDF2-SHA256 (250,000 iterations) — and stored as **ciphertext**
in a downloaded keystore file **and** in `localStorage`; the **decrypted** copy lives only in `sessionStorage`
for the tab session (cleared on close). The prover computes the proof in a Web Worker; the proof is the only
artifact that leaves the browser. A compromised browser session can drain the account **up to `cap` per
payment, only to allowlisted destinations** — it cannot exceed the cap or the allowlist.

### The admin key — the primary trust root
The admin can call `rotate_policy(new_commitment, new_root)` and then supply a proof for the new policy.
This is **two observable, event-emitting on-chain steps** — it cannot be done silently. The admin can also
`freeze()` to halt spending and `unfreeze()` to restore it.

- The admin **cannot spend in one step** — every spend requires a valid proof for the *currently committed*
  policy, and the admin holds no policy secret by default. A non-admin (and an admin acting alone, without a
  proof) **cannot** move funds directly.
- **But** the admin **can** rotate the committed policy to one whose secret it controls, then produce a valid
  proof for that policy and spend. **A malicious or compromised admin can therefore drain the account in two
  on-chain-visible steps.** Treat the admin key as a full governance trust root.
- `freeze` is a **denial/safety lever** — it cannot steal, but it can deny. Evidence: freeze SUCCESS
  `bea27046…`, frozen-spend FAILED #17 `071294a4…`, unfreeze SUCCESS `8d9113b4…` (REPORT_GOVERNANCE.md).

**Hardening — documented, NOT built:** an M-of-N multisig admin, a timelock on `rotate_policy`/`freeze`, and
epoch-versioned rotation with a previous-epoch grace window. The documented end-state replaces the admin key
with a Passkey-Kit biometric account (no seed phrase) plus a timelock. Until those ship, the single-key admin
is a full governance trust root.

### The disclosure authority (Tier-1)
The disclosure proof (§11) shows `cap ≤ regulatory_max` bound to the account's real commitment, but the
*legitimacy of the limit itself* is asserted by an external authority (a Stellar anchor / KYC provider). In
this submission the limit is **self-provided** (§12); the oracle-trust assumption is stated in the UI and
REPORT_VERIFY_TIER1.md.

### The BN254 verifier contract
Deployed immutably. Nulth calls `bn254_groth16_verify(vk, proof, pub_signals)` as a **Protocol 26 host
function**, not Nulth code. If the host implementation has a bug, the proof check is compromised.

### The trusted setup (Groth16) — see §8.

---

## 6. Replay + revert-nonce (a bounded, correct property)

Two composed mechanisms (ARCHITECTURE §5):

1. **`signature_payload` binding (in-proof).** The proof binds the two 128-bit halves of *this* invocation's
   host `signature_payload`. `__check_auth` rejects a mismatch with `BadSigPayload #13` (`test_sigpayload_binding`).
2. **Host-native `(address, nonce)` consumption.** Soroban consumes the pair once, on a successful apply — no
   hand-rolled nullifier in the contract.

Resulting property (bounded and correct, not a hole):

- A **settled** proof **cannot be replayed**: the host rejects the consumed pair with
  `Error(Auth, ExistingValue)` (re-submitting `build/last_auth.xdr` → rejected, `scripts/replay_same.mjs`).
- A **failed** transaction **reverts the nonce** (standard Soroban) — the same authorized payment is
  retryable, but succeeds only once.
- A proof **cannot be lifted** into a different invocation/nonce → `BadSigPayload #13` (`bd424c94…`).

**Recommended — NOT built:** a dedicated cargo test asserting the full revert-nonce cycle (fail → retry →
succeed once → settled-entry replay rejected). Today `#13` is cargo-proven and the `(address, nonce)`
consumption is the standard Soroban host property, shown via `replay_same.mjs` — **not** a Nulth cargo unit
test. We do not claim such a cargo test exists.

---

## 7. What is mocked / self-hosted (explicit)

- **Agent service-payment path:** a self-hosted, allowlisted "service-payment" path — **NOT** the strict x402
  wire protocol (disclosed). The agent LLM is a real Claude (via the `claude` CLI) running server-side as an
  operator instance that holds a policy secret; a demo fee-payer submits the txs (REPORT_AGENT_DECK.md).
- **`regulatory_max` authority:** **self-provided** for the demo (no real anchor/KYC oracle is integrated); the
  oracle-trust assumption is stated (§5).
- **Relayer / fee-payer:** a demo operator key submits transactions and pays XLM fees (in production, a gasless
  relayer/wallet). It is not a prover and cannot authorize a spend.

**Core is real:** proof generation, the on-chain native Groth16 enforcement in `__check_auth`, the USDC
settlements, and every rejection are real on the testnet (cited throughout).

---

## 8. Cryptographic assumptions + post-quantum

- **Groth16 requires a trusted setup — honest provenance.** Phase-1 is the public **Hermez
  `powersOfTau28_hez_final_15`** powers-of-tau ceremony (multi-party, public transcript). Phase-2 is a
  **single, fresh, local contribution** that produced the deployed zkey/vkey (REPORT_DEPTH16.md §B).
  **This is a dev/hackathon setup: phase-2 has a single contributor.** A party that retained the phase-2 toxic
  waste could forge a proof for *arbitrary* public signals — i.e. **a phase-2 compromise is a soundness break
  (forgeability / theft).** A production deployment **requires a proper multi-party phase-2 ceremony** (or a
  transparent-setup proof system). Stated plainly: the deployed circuits use a **dev trusted setup** — it is
  **not** "the same posture as production ZK globally."
- **Not post-quantum.** Groth16 over BN254 is **not** post-quantum secure (a property shared with other Groth16
  ZK on Stellar). A PQ-secure verifier (hash-based / STARK) is **future work, not built.**
- **What still holds under a setup compromise:** a forged proof must *also* carry public signals matching the
  committed `commitment/root`, the actual transfer's `amount/dest`, and this invocation's `signature_payload` —
  the in-contract bindings are independent of proof soundness. This does not rescue soundness, but it means the
  *binding* defenses in §3 are not themselves contingent on the setup.

---

## 9. Host opacity as a feature (no attacker oracle)

Every failed `__check_auth` surfaces to an outside observer **identically** as `Error(Auth, InvalidAction)`.
An attacker **cannot tell which check failed** — there is no oracle distinguishing `BadProof` from
`BadDestBinding` from `AccountFrozen`. The precise `AccError #N` is visible **only in simulation**, where the
caller already controls the inputs.

**Consistency note (code #18).** A **non-admin** `rotate_policy`/`freeze` rejection is a **host-level**
`Error(Auth, …)` — the admin's `require_auth()` is unsatisfied **before any contract body runs** — **not** a
contract `Unauthorized #18`. `#18` is **reserved and never returned** (consistent with ARCHITECTURE §4); it
documents intent, while the actual enforcement is the Soroban auth framework. Evidence: non-admin rotate FAILED
`308d140c…` (host auth failure, not a contract error code).

---

## 10. What Nulth does NOT guarantee

**Cumulative spend cap** — each proof is checked independently. A prover can make multiple payments each at
`amount = cap`. Cumulative enforcement across payments requires on-chain state tracking with concurrent-write
guarantees — a deliberate design scope boundary.

**Prover anonymity** — the source account is `from == self` (the CovenantAccount address). Observers know which
account paid, and to whom. Only the *policy details* (cap value, unexercised allowlist members) are private.

**Admin-less operation** — the admin role cannot be removed; it can only be transferred or hardened (multisig,
timelock). A treasury with no admin has no freeze or rotate capability.

**Confidential amounts** — payment amounts are public on the Stellar ledger. Nulth hides the *policy*, not
the amounts. For confidential amounts (the literal inverse problem), see **[docs/PROTOCOL.md](./docs/PROTOCOL.md) §5**
(privacy pools).

**Allowlist update privacy** — `rotate_policy` is observable and emits an event. An observer knows the allowlist
was updated; they do not learn the new contents.

---

## 11. Tier-1 auditor disclosure

**Circuit:** `disclosure.circom` — 824 constraints. Public inputs: `[policy_commitment, regulatory_max]`.

**Statement:** Proves `cap ≤ regulatory_max` **without revealing `cap`**. A correspondent bank sees
`(policy_commitment, regulatory_max, proof)` and learns only that the cap is within AML limits.

**Setup:** a separate phase-2 contribution reusing the Hermez ptau; independent of `policy.circom`. Same
dev-setup caveat as §8.

**On-chain cost:** **28,467,320 instructions (~7.1% of the 400M compute ceiling)** when verified on-chain —
decoded from the `verify_proof` simulation (REPORT_VERIFY_TIER1.md; REPORT_GOVERNANCE.md), bound to the live
commitment. Browser proving ≈173 ms.

**Binary-search attack (privacy limit of disclosure).** An adversary who can obtain *multiple* disclosure proofs
at *different* `regulatory_max` values could binary-search toward the true `cap`. Mitigated by: (a) only proving
against fixed, pre-agreed AML thresholds, not attacker-chosen variable values; (b) AML tier step sizes are
typically much larger than any operationally meaningful cap granularity. This is the reason `regulatory_max` is a
**fixed authority-set limit**, not a free parameter.

---

## 12. Non-goals / out of scope

- **Amount / recipient privacy** — *not* a Nulth goal. The executed transfer is public; hiding amounts/linkage
  is a privacy pool's job (PROTOCOL.md §5). Nulth hides the **policy**.
- **Formal audit** — **not done.** This is **testnet only**; mainnet was deliberately **held pending audit** (the
  UI Mainnet tab is disabled with that note). No mainnet deployment is claimed.
- **Hardening modules** — multisig + timelock admin, epoch-grace rotation, a multi-party phase-2 ceremony, and a
  PQ verifier are **documented, not built.**
- **Availability vs a malicious admin or relayer** — not guaranteed: a malicious admin can `freeze` (deny
  spending) and a malicious relayer/RPC can refuse to submit/serve. Neither can **steal**.

---

## 13. Known limitations and hardening roadmap

| Limitation | Hardening | Status |
|------------|-----------|--------|
| Admin is a single key | Passkey-Kit biometric account as admin | Documented, not built |
| No timelock on `rotate_policy` | Add a timelock-contract delay | Documented, not built |
| No cumulative budget enforcement | On-chain payment counter with ordered nonces | Designed, not built |
| Tier-2 allowlist subset proof | ZK subset containment (Merkle intersection) | Step-4 recon, not built |
| Single-contributor phase-2 setup | Multi-party phase-2 ceremony (or transparent setup) | Documented, not built |
| Not post-quantum | Hash-based / STARK verifier | Future work, not built |
| Mobile proving | Web Worker prover on the unchanged 65,536-leaf tree, inline fallback + honest "desktop recommended" message on failure; on-device timing unmeasured | **Built (not disabled)** |

---

## 14. References & provenance

- **[ADVERSARIAL_TESTING.md](./ADVERSARIAL_TESTING.md)** — "How We Break Nulth": the full attack matrix with
  per-mode `AccError` decode and on-chain tx hashes.
- **[docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md)** — mechanics: gate order, error codes, replay, cost decode,
  deployment IDs.
- **[docs/PROTOCOL.md](./docs/PROTOCOL.md)** — the ZK-authorization primitive, the proposed standard, the
  disclosure extension, positioning.
- **[docs/CIRCUIT_VERIFICATION.md](./docs/CIRCUIT_VERIFICATION.md)** — golden vectors + trusted-setup detail (§8).

**Provenance — defenses cite real evidence:**
- Deck FAILED txs `6d40f77b` (#3), `bd424c94` (#13), `8cc47419` (#13), `fc9b3e43` (#4), `84ba7fbc` (#10) — REPORT_AGENT_DECK.md.
- Agent jailbreak: payment `f23be708`, backstop `19e4bd88` — REPORT_AGENT_DECK.md.
- Governance: non-admin `308d140c`, freeze `bea27046`, frozen-spend #17 `071294a4`, unfreeze `8d9113b4`, rotated-old-proof #4 `3411ef29` — REPORT_GOVERNANCE.md.
- Replay: host `Error(Auth, ExistingValue)` via `scripts/replay_same.mjs`; `#13` cargo `test_sigpayload_binding`; `#6` cargo `test_dest_binding` — REPORT_P1.md.
- RPC side-channel trace: `scripts/create_trace_e2e.mjs` — REPORT_TRUTH_FIXES.md.
- Trusted-setup provenance: Hermez ptau phase-1 + single local phase-2 — REPORT_DEPTH16.md §B.
- Tier-1 disclosure verify cost `28,467,320` instr — REPORT_VERIFY_TIER1.md, REPORT_GOVERNANCE.md.
