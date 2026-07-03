# REPORT — Nulth Phase 1 (Production-harden `__check_auth` + close replay)

**Date:** 2026-06-14 · **Network:** Stellar testnet (Protocol 26) · **SDK:** soroban-sdk 26.1.0 · **Scope:** P1 only — no governance (P2).

**Bottom line:** every unstated invariant the P0 review found is now an explicit, tested check. The minimal account is replaced by a hardened one — exactly-one-context, token pinning, `from == self`, an in-contract range check, atomic `__constructor` init, and **replay closed by binding Soroban's `signature_payload` into the proof + the host's native nonce consumption** (empirically confirmed, no hand-rolled nullifier). A valid proof still authorizes a real USDC payment; the hardened verify cost is re-baselined and decoded from the tx envelope. The distinct error-code matrix runs under `cargo test` with committed fixtures. **No mocks; every claim carries a tx hash, a decoded instruction count, a sim diagnostic, or a build log.**

---

## 0. The fixes → evidence (each P0 finding is now a tested control)

| # | Fix | How enforced (covenant_account.rs) | Proven by |
|---|---|---|---|
| **#1** | **Exactly one validated context** (no empty→blanket approval, no multi→N-fold spend) | `auth_contexts.len()==0 → NoContext`; `>1 → TooManyContexts`; single context fully validated | cargo `test_empty_context_rejected` (#15), `test_two_contexts_rejected` (#16); valid payment uses exactly 1 ctx |
| **#2** | **Token pinning** | `c.contract != stored token → BadTokenBinding` | cargo `test_token_binding` (#10) |
| **#4** | **`from == self`** | `args[0] != env.current_contract_address() → BadFromBinding` | cargo `test_from_binding` (#11) |
| **#11** | **In-contract range** | `amount >= 2^100 → AmountTooLarge` (shared with circuit `Num2Bits(100)`) | cargo `test_amount_too_large` (#12) |
| **#5** | **Init front-run closed** | `__constructor` (atomic at deploy, no uninit window) + `vk.ic.len()!=7 → MalformedVk` | deploy+constructor tx `72e7fd10…`; cargo `test_malformed_vk…` (#14) |
| **#6/#8** | **Invocation binding (replay)** | circuit adds **constrained** `sigpayload_hi/lo` (`Num2Bits(128)`); `__check_auth` splits the live `signature_payload: Hash<32>` into the same halves, `!= → BadSigPayload` | valid payment (off-chain payload matched host); cargo `test_sigpayload_binding` (#13); replay (b) below |
| **#12** | **dest_field pinned + round-tripped** | `sha256(xdr(addr))` top byte zeroed (248-bit) | §5 round-trip (G + C) |

---

## 1. Replay — empirically confirmed (not assumed); host-nonce path SHIPPED

The PRD §8 said to verify the host consumes the auth-entry nonce for a *custom* account, and fall back to a bounded nullifier only if it doesn't. **It does — so the host-native path ships, no fallback nullifier, no storage-DoS surface.**

| Test | Result | Evidence |
|---|---|---|
| **(a) Replay the SAME signed auth entry** (nonce `1000002`) | **REJECTED by the host** — `Error(Auth, ExistingValue)` (the `(address, nonce)` pair was consumed by the first apply) | resubmitted `build/last_auth.xdr` → sim rejected |
| **(b) Lift the valid proof, pair with a FRESH nonce** | **REJECTED** — `Error(Auth, InvalidAction)`, underlying `AccError::BadSigPayload (#13)`: the new nonce changes `signature_payload`, whose halves no longer match the proof's `sigpayload_hi/lo` | `pay_p1.mjs MODE=fresh_nonce` sim |

**Design note (more precise than the original spec):** the lifted-proof case returns **BadSigPayload (#13)**, not `BadProof`. The explicit `signature_payload` binding catches the mismatch *before* the pairing is ever run — a cheaper, more specific rejection. The proof itself is valid; it is simply non-transferable to a different invocation.

**Shipped replay path:** host-native `(address, nonce)` consumption **+** `signature_payload` binding. No per-nonce contract storage, no TTL, no rent-DoS (the P0 nullifier concern is designed out).

---

## 2. The valid hardened-path payment (proof is the only authorizer)

The account holds USDC and has **no key**. A Groth16 proof, bound to this exact invocation, is the sole authorizer.

- **Deploy + `__constructor`** (vk + commitment + root + token, atomic): account tx [`72e7fd10…`](https://stellar.expert/explorer/testnet/tx/72e7fd10eea9cc7b3ed7b695169aea8ad9b9b1ccb0bbcc69504923b9bc952e7d) (wasm upload [`433437fd…`](https://stellar.expert/explorer/testnet/tx/433437fdd28745788cf6fd916021e7081bd6bc8c0b2cdbabd04719fcba52ed82)).
- **Fund** (agent → account, 5 USDC): [`17de1d84…`](https://stellar.expert/explorer/testnet/tx/17de1d8437223875fe5ce1335ba304f639e25124dc61bb9693c37b74ac00147d) — account USDC `0 → 50000000`.
- **Proof-authorized payment** (account → payee, **1.0 USDC**, proves at pay-time binding the live `signature_payload`): [`f69630e1…`](https://stellar.expert/explorer/testnet/tx/f69630e19ae6ccffd2a86247ecd69dcb5e9c181f9210dfc4d5102a5e88b796cd) — **SUCCESS**.

| Account | USDC before | USDC after | Δ |
|---|---|---|---|
| Nulth account `CCSGJ…WYY` | `50000000` (5.0) | `40000000` (4.0) | **−1.0 USDC** |
| Payee `GBEOVHEZ…UU4BS` | `210474000` | `220474000` | **+1.0 USDC** |

The payment succeeding is itself proof that the **off-chain `signature_payload` computation matched the host's exactly** (else `BadSigPayload` would have fired) and that all hardened checks passed.

---

## 3. Negative-control matrix

**Host behavior discovered (reported honestly):** Soroban surfaces *every* failed custom-account `__check_auth` as **`Error(Auth, InvalidAction)`** at the calling contract's `require_auth` boundary — it does **not** propagate the inner `AccError` code to the transaction diagnostic. So **on-chain proves rejection; the distinct codes are proven by `cargo test`** calling `__check_auth` directly. (Bonus: the chain never reveals *which* check rejected an attacker.)

**On-chain (real sim diagnostics):**

| Attack | On-chain result |
|---|---|
| Replay same auth-entry nonce | `Error(Auth, ExistingValue)` (host) |
| Lifted proof + fresh nonce | `Error(Auth, InvalidAction)` ← `BadSigPayload` |
| Proof vs wrong policy commitment | `Error(Auth, InvalidAction)` ← `BadPolicyBinding` |
| Swap a↔c (valid points, wrong proof) | `Error(Auth, InvalidAction)` ← `BadProof` |
| 1-bit flip in proof.a | `Error(Auth, InvalidAction)` ← Crypto `InvalidInput` (panics inside `__check_auth`) |
| Over-cap / non-allowlisted | **witness generation ABORTS** at `policy.circom:61` (`LessEqThan === 1`) — a proof cannot even be formed |

**`cargo test` (committed fixtures, no proving stack — the distinct-code matrix):**

| Test | Expected | Test | Expected |
|---|---|---|---|
| `test_valid_proof_authorized` | `Ok` | `test_empty_context_rejected` | `NoContext` #15 |
| `test_two_contexts_rejected` | `TooManyContexts` #16 | `test_token_binding` | `BadTokenBinding` #10 |
| `test_from_binding` | `BadFromBinding` #11 | `test_amount_too_large` | `AmountTooLarge` #12 |
| `test_negative_amount` | `NegativeAmount` #9 | `test_amount_binding` | `BadAmountBinding` #5 |
| `test_dest_binding` | `BadDestBinding` #6 | `test_old_policy_binding` | `BadPolicyBinding` #4 |
| `test_sigpayload_binding` | `BadSigPayload` #13 | `test_bad_signal_count` | `BadSignalCount` #8 |
| `test_bad_proof_swapped_ac` | `BadProof` #3 | `test_malformed_vk…` | `MalformedVk` #14 (panic) |

**Result: `test result: ok. 14 passed; 0 failed` (finished in 0.18s).** Run with `cargo test -p covenant-account`; fixtures committed at `contracts/covenant_account/src/fixture_data.rs` (generated by `scripts/gen_fixture.mjs`).

---

## 4. Re-baselined cost (hardened path, decoded — not cited)

| Metric | Value | Source |
|---|---|---|
| **Hardened-path instructions** | **34,149,591** | decoded from tx `f69630e1…` envelope (`sorobanData.resources().instructions()`) |
| Per-tx ceiling | 400,000,000 | live `ContractComputeV0` |
| **% of ceiling** | **8.537 %** | 34,149,591 / 400,000,000 |
| (P0 USDC minimal, ref) | 31,613,639 (7.903 %) | REPORT_P0 |

**Δ = +2,535,952 (+0.634 %)** vs P0 — from the +2 public signals (two extra `g1_mul`+`g1_add` in `vk_x`), the `signature_payload` split, and the new binding checks. **~91.5 % headroom.** This is the figure to quote in the UI/README. There is **no per-nonce storage write** (host-native replay), so the cost is binding-checks + the slightly larger circuit, not a nullifier write.

---

## 5. dest_field round-trip (SDK leaf == on-chain) + domain

| Address type | Address | on-chain `dest_field` | off-chain (SDK) |
|---|---|---|---|
| **G** (account) | payee `GBEOVHEZ…UU4BS` | `286103…234984` | **identical** |
| **C** (contract) | USDC SAC `CBIELTK6…DAMA` | `434876…661005` | **identical** |

Mapping = `sha256(xdr(ScVal::Address))` with the top byte zeroed → **248-bit domain** (collision-resistant at 2^248; the 8-bit reduction is documented). **Supported: G and C addresses** (the SDK `nativeToScVal(addr,{type:'address'})` XDR matches the contract's `Address::to_xdr` exactly). Muxed (M) addresses are out of scope and not used in allowlists.

---

## 6. New contract IDs (P1, fresh circuit → fresh vk → redeploy, as expected)

| Contract | ID | Deploy tx |
|---|---|---|
| **Verifier** (`covenant_verifier.wasm`) | `CCELWU6U3LXLROC55MKMJXC643MVHI4AJT5AHZ6QGSLMYLSBW4CENTSF` | [`5f003ad5…`](https://stellar.expert/explorer/testnet/tx/5f003ad508bef02657c6a33df0904a9322b8b9955ac5f5a5a07f32d39e09a5d1) |
| **Nulth account** (`covenant_account.wasm`, 9553 B; exports `__constructor`/`dest_field`/`__check_auth`) | `CCSGJMSA7RIA4HOAK2PNB5HBS23V44V72JVWEWWEHNO24PNYA44JGWYY` | [`72e7fd10…`](https://stellar.expert/explorer/testnet/tx/72e7fd10eea9cc7b3ed7b695169aea8ad9b9b1ccb0bbcc69504923b9bc952e7d) |

Circuit: **3,162 constraints** (was 2,904; +258 for the two `Num2Bits(128)` invocation-binding checks), 6 public inputs, fresh Hermez-ptau trusted setup → new vk (`ic.len()==7`).

---

## 7. Final error codes (covenant_account.rs)

`1 NotInit · 2 AlreadyInit · 3 BadProof · 4 BadPolicyBinding · 5 BadAmountBinding · 6 BadDestBinding · 7 BadContext · 8 BadSignalCount · 9 NegativeAmount · 10 BadTokenBinding · 11 BadFromBinding · 12 AmountTooLarge · 13 BadSigPayload · 14 MalformedVk · 15 NoContext · 16 TooManyContexts`

`__check_auth` order: load state → `pub_signals.len()==6` (`BadSignalCount`) → policy binding (`BadPolicyBinding`) → **sigpayload binding** (`BadSigPayload`) → exactly-one-context (`NoContext`/`TooManyContexts`) → token pin (`BadTokenBinding`) → from==self (`BadFromBinding`) → amount sign/range (`NegativeAmount`/`AmountTooLarge`) → amount/dest binding (`BadAmountBinding`/`BadDestBinding`) → Groth16 verify (`BadProof`) → `Ok`.

---

## 8. Honest notes

- **Full-invocation binding is stronger than per-arg binding.** `signature_payload` covers the entire invocation (token, from, to, amount) + nonce + expiration + network id. So on-chain, tampering *any* arg → payload mismatch → `BadSigPayload`. The per-arg checks (`BadAmountBinding`, `BadDestBinding`, `BadTokenBinding`, `BadFromBinding`) are defense-in-depth, proven independently by the cargo fixtures (which decouple the Context from the payload). This is more rigorous, not less.
- **Adversarial pre-deploy review** (REPORT_P0 method) ran before deploy: contract compiles clean on 26.1.0; `split_payload` correct; all 8 fixes enforced. Its one finding (F2: raw-U256 binding vs mod-r pairing) is **conservatively safe** — the raw comparison is the *stricter* check and all binding targets are canonical `< r`; documented, not a vulnerability.
- **No mocks anywhere.** Witness aborts, sim diagnostics, host rejections, and the successful payment are all real.

---

## 9. STOP

P1 is complete. **Governance (P2) and all later phases are NOT started, per instruction.** PRD §6 updated to the finalized hardened `__check_auth` + error codes. Awaiting go for P2.
