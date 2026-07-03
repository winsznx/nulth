# Nulth

**Private controls for public money.**

Nulth is a proof-authorized Stellar account: it can only spend if it proves, in zero knowledge, that the payment obeys rules the chain has never seen. Its signature *is* the proof.

`65,536 private allowlist slots · verified in 8.537% of a Stellar transaction's compute budget · live on Stellar testnet`

> **No Ed25519 spending key.** The proof *is* the spend authorization — there is no key to phish or extract. Funds move only by proving compliance with a policy the chain never sees; the spend cap and the allowlist are never published (only one Poseidon commitment + one Merkle root touch the ledger). The admin is *governance* (rotate/freeze), not payment authorization. **Nulth hides the rules, not the payments** — amount and destination are public like any Stellar payment.

> Where Nulth sits in Stellar's privacy stack: **Confidential Tokens hide the amounts; Nulth hides the rules.** They compose.  ·  Live at [nulth.xyz](https://nulth.xyz)  ·  *(formerly Covenant)*

---

## Live on-chain

### Testnet (Protocol 26)

| Contract | ID |
|---|---|
| Nulth account (keyless, ZK-authorized) | [`CANA5QYVHNON7AV752ZRATFW2T5BMS3MU5DDPJMU5UGSR3KSH45LOGZE`](https://stellar.expert/explorer/testnet/contract/CANA5QYVHNON7AV752ZRATFW2T5BMS3MU5DDPJMU5UGSR3KSH45LOGZE) |
| BN254 Groth16 verifier | [`CCKBPVP7MZJOQYU44RK5MG4PA2YKV4UQ7CJMPK3OIHNFHLG5PEMNDREG`](https://stellar.expert/explorer/testnet/contract/CCKBPVP7MZJOQYU44RK5MG4PA2YKV4UQ7CJMPK3OIHNFHLG5PEMNDREG) |
| Payment asset | canonical Circle testnet USDC (`GBBD47IF…ZLLFLA5`) |

Proof-authorized USDC payment (browser proof → USDC transfer) from this account: [`24ce435e…0677`](https://stellar.expert/explorer/testnet/tx/24ce435e822caa5961913ca1a98491d413bf18309857164b10c42e3ab0650677) — authorized **solely** by the ZK proof; an out-of-policy destination is refused (witness abort, no tx).

### Mainnet

Intentionally held until external review. Nulth is a new authorization surface, so mainnet deployment waits on an audit (the SCF Audit Bank is the path). Everything above runs today on testnet with real proof-authorized USDC — mature caution, not missing work.

---

## Run the tests now

```bash
# Contract — 34 tests, all distinct error codes
cargo test --manifest-path contracts/Cargo.toml

# Circuit — 7 tests (policy + disclosure, valid + invalid witnesses)
cd circuits && npm test

# End-to-end — 5 headless drivers against live testnet
bash scripts/run_e2e.sh
```

**Adversarial test matrix** — every reachable `AccError` is a tested negative control with a distinct code:

| Test | Attack | Expected | Code | Status |
|---|---|---|---|---|
| `test_valid_proof_authorized` | happy path | transfer executes | — | ✅ |
| `test_bad_proof_swapped_ac` | swap Groth16 A/C | `BadProof` | #3 | ✅ · [on-chain FAILED](https://stellar.expert/explorer/testnet/tx/6d40f77b9f3480f0e4af829efb2922308368eb64300996efc2d509eecc52aec3) |
| `test_old_policy_binding` | proof vs rotated policy | `BadPolicyBinding` | #4 | ✅ · [on-chain FAILED](https://stellar.expert/explorer/testnet/tx/fc9b3e4304dc54751d192b446967f3180d48eadf26e3481deee66745ba0b1ac5) |
| `test_amount_binding` | amount ≠ proof signal | `BadAmountBinding` | #5 | ✅ |
| `test_dest_binding` | redirected destination | `BadDestBinding` | #6 | ✅ |
| `test_bad_context_burn_fn` | `burn()` instead of `transfer()` | `BadContext` | #7 | ✅ |
| `test_from_binding` | from ≠ account address | `BadFromBinding` | #11 | ✅ |
| `test_amount_too_large` | amount ≥ 2¹⁰⁰ | `AmountTooLarge` | #12 | ✅ |
| `test_sigpayload_binding` | fresh-nonce proof lift | `BadSigPayload` | #13 | ✅ · [on-chain FAILED](https://stellar.expert/explorer/testnet/tx/bd424c94c879b5a7d4a3a173395b72a45481f355520341fe5d4926a84af27597) |
| `test_malformed_vk_rejected_at_construction` | `vk.ic.len ≠ 7` | `MalformedVk` | #14 | ✅ |
| `test_empty_context_rejected` | empty `auth_contexts` | `NoContext` | #15 | ✅ |
| `test_two_contexts_rejected` | multi-context blanket approval | `TooManyContexts` | #16 | ✅ |
| `test_freeze_blocks_valid_proof` | spend while frozen | `AccountFrozen` | #17 | ✅ · [on-chain FAILED](https://stellar.expert/explorer/testnet/tx/071294a4d7d05437ef75b38be94bfb95c5d20a79ef02ecdc2bd63b543eded3e3) |
| `test_non_admin_rotate_rejected` | unauthorized rotate | host `Error(Auth)` | — ¹ | ✅ · [on-chain FAILED](https://stellar.expert/explorer/testnet/tx/308d140c3c0e1dad80ae7c7d46eed8a4c2bdbb3a75e5f21d20e73a5f97434c75) |
| `test_token_binding` | wrong token (XLM SAC) | `BadTokenBinding` | #10 | ✅ · [on-chain FAILED](https://stellar.expert/explorer/testnet/tx/84ba7fbca8319d12f8b88e13f79a85283912227cbe5dcc4294ae414c2284ddba) |
| `test_negative_amount` | `i128::MIN` | `NegativeAmount` | #9 | ✅ |
| `test_bad_signal_count` | wrong `pub_signals` length | `BadSignalCount` | #8 | ✅ |
| `test_root_binding` | wrong `allowlist_root` | `BadPolicyBinding` | #4 | ✅ |
| replay (same auth entry) | resubmit settled nonce | host `ExistingValue` | — | ✅ · [sim evidence](./docs/reports/REPORT_P1.md) |

¹ Non-admin governance is rejected at the **host** boundary (`admin.require_auth()`) before any contract body runs — the contract code `Unauthorized` #18 is **reserved** and never returned. The cargo test is `#[should_panic]` on the unsatisfied `require_auth`. Likewise `AlreadyInit` #2 is reserved (host-enforced single-shot constructor); **16 of the 18 declared codes are active**.

Full matrix with tx hashes: [ADVERSARIAL_TESTING.md](./ADVERSARIAL_TESTING.md).

---

## Why this is novel

Nulth uses a ZK proof as the **sole** authorization mechanism — the proof *is* the account's signature, verified in `__check_auth`. We haven't found another Stellar account where the proof itself replaces the spending signature; others put ZK elsewhere:

- vs **privacy pools** (Moonlight, Nethermind) — hide *amounts*, rules public; Nulth hides the *rules*, amounts public. The literal inverse.
- vs **zk-voting / zkKYC** — eligibility / identity disclosure, not spend authorization.
- vs **passkey smart wallets** — same `__check_auth` slot, signature not a proof.
- vs **multisig policy accounts** (MultiClique) — on-chain policy bytes, zero ZK.

Not a token pool — funds stay standard USDC; the *authorization* is private.

---

## What we learned from RouteDock

RouteDock feedback: *"impressive… useful smart account… more substantial tests on the contract."*

Nulth makes the smart account the hero, ZK load-bearing from the first byte, and the adversarial suite the headline — not an afterthought. Every `AccError` is a tested negative control. Every on-chain rejection has a tx hash. The judges asked for tests; we answer with 34 cargo + 7 circuit + 5 e2e drivers = 46 total, each mapping an attack to its error code to its on-chain evidence.

---

## Architecture

```
OFF-CHAIN (operator / agent)                   ON-CHAIN (Soroban)
─────────────────────────────                  ──────────────────
policy = { cap, allowlist[], salt }            CovenantAccount (DEPTH-16, BN254)
                                                 storage: vk, policy_commitment,
per payment (amount, dest):                               allowlist_root, token,
  1. Web Worker: snarkjs.fullProve                        admin, frozen
     ~970 ms, DEPTH-16, in-browser            __check_auth(payload, ProofSig, ctxs):
     public: [amount, dest, commitment,          1. frozen? → AccountFrozen
              root, sigpayload_hi/lo]            2. pub_signals[2,3] == stored?
  2. proof = the "signature" on                 3. sigpayload binding
     token.transfer(from=account,…)             4. exactly one context?
  3. fee-payer relays tx (pays XLM;             5. fn_name == "transfer"?
     cannot authorize a spend)                   6. token == pinned USDC?
                                                 7. from == self?
                                                 8. 0 < amount < 2¹⁰⁰?
                                                 9. amount/dest match signals?
                                                10. Groth16 verify (native BN254)
                                                11. → Ok → USDC transfer executes
```

**Cost box** (DEPTH-16, USDC path, decoded on-chain):

| | |
|---|---|
| Verify instructions | **34,149,591** |
| % of 400M ceiling | **8.537%** |
| In-browser prove time | **~970 ms** (Web Worker, DEPTH-16, M-series Mac) |
| Policy circuit | DEPTH-16 · 9,402 constraints · 65,536 allowlist slots |
| Disclosure circuit | 824 constraints · 173 ms browser prove |
| Trusted setup | Hermez ptau phase-1 (public, multi-party) + single local phase-2 (**dev setup** — production needs multi-party phase-2) |

**Trust boundaries** — stated precisely:

An observer with full mempool + vk + chain state cannot determine the cap or any unexercised allowlist member. They learn only the counterparties actually paid and a lower bound on the cap.

The admin key is a full governance trust root: it cannot spend in one step (every spend needs a valid proof for the committed policy), but it can rotate the committed policy to one it controls and then spend — two observable, event-emitting on-chain steps. Hardening path: multisig + timelock (documented, not yet built). See [SECURITY.md](./SECURITY.md).

---

## What's next: compliance grade

**Tier-1 ZK auditor disclosure (shipped):** `cap ≤ regulatory_max` — a correspondent bank verifies the treasury bot's spending policy stays within AML limits without seeing the cap. Real ZK proof, 173 ms browser proving, verified on-chain at 28,467,320 instructions.

**Tier-2 allowlist ⊆ authority screened-set (Step-4 recon):** subset containment over Merkle sets — the harder problem. Real ZK if feasible; Tier-1 ships regardless.

**Running cumulative budget:** concurrent enforcement across payments is a distributed-systems problem, not cryptography — concurrent proofs over shared state need ordering guarantees the current design deliberately avoids.

---

## Documentation

| File | Contents |
|---|---|
| [ADVERSARIAL_TESTING.md](./ADVERSARIAL_TESTING.md) | "How We Break Nulth" — full error-code matrix + on-chain tx hashes |
| [SECURITY.md](./SECURITY.md) | **Canonical threat model** — adversaries, trust roots, privacy boundary, crypto assumptions, disclosure |
| [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) | System architecture, `__check_auth` gate order + error codes, data flow, cost decode |
| [docs/PROTOCOL.md](./docs/PROTOCOL.md) | The ZK-authorization primitive, the proposed standard, `ProofSig` format, disclosure extension |
| [docs/CIRCUIT_VERIFICATION.md](./docs/CIRCUIT_VERIFICATION.md) | Circuit specs, trusted-setup provenance, reproducible golden vectors |
| [REPORT_P1.md](./docs/reports/REPORT_P1.md) | Production hardening evidence: 16 error codes, replay closed |
| [REPORT_GOVERNANCE.md](./docs/reports/REPORT_GOVERNANCE.md) | P2: rotate_policy, freeze/unfreeze, governance tests |
| [REPORT_AGENT_DECK.md](./docs/reports/REPORT_AGENT_DECK.md) | Agent jailbreak + Exploitation Deck — 5 real on-chain attack receipts |
| [REPORT_VERIFY_TIER1.md](./docs/reports/REPORT_VERIFY_TIER1.md) | Tier-1 ZK disclosure: circuit, on-chain verify, browser demo |

---

## Credits

`stellar/soroban-examples` groth16_verifier · James Bachini's circom-on-Stellar tutorial · Hermez ptau · circomlib · circomlibjs.

## License

MIT
