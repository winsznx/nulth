# REPORT — Nulth DEPTH-16 (production allowlist + proving feasibility)

**Date:** 2026-06-14 · **Network:** Stellar testnet (Protocol 26) · **SDK:** soroban-sdk 26.1.0 · **Scope:** circuit DEPTH-4 → DEPTH-16 + proving measurement. No frontend, no P2.

**Bottom line:** the policy circuit is now **DEPTH-16 — up to 65,536 private payees** — built and proven against a **real 65,536-leaf Poseidon-Merkle tree**, redeployed, and exercised with a real proof-authorized USDC payment. The key prediction holds **on-chain, decoded**: the verify cost is **unchanged (34,149,591 instr = 8.537%, delta 0)** — Groth16 verification depends only on the 6 public inputs + the pairing, not circuit size. The hardening is depth-independent: **cargo 14/14 still green**. And the load-bearing §14 unknown is answered: a DEPTH-16 proof generates **client-side in a real browser in 865 ms** (Node 781 ms avg). **Zero-terminal in-browser proving is VIABLE.** No mocks — every number is measured or decoded.

---

## A. Circuit → DEPTH-16

| | DEPTH-4 (P1) | **DEPTH-16 (now)** |
|---|---|---|
| Allowlist capacity | 16 | **65,536** |
| Constraints | 3,162 | **9,402** (4,736 non-linear + 4,666 linear) |
| Public inputs | 6 | **6 (unchanged)** |
| Private inputs | 10 | 34 (`path[16]` + `index_bits[16]` + cap + salt) |

Only the Merkle depth changed (`PaymentPolicy(16)`); the 6 public signals, the `sigpayload_hi/lo` invocation binding, and the cap/commitment logic are byte-for-byte identical. ptau `powersOfTau28_hez_final_15` (2^15 = 32,768) covers 9,402 constraints.

## B. Trusted setup

Fresh Hermez-ptau phase-2 contribution → new zkey + vkey. **vkey unchanged in shape: `nPublic=6`, `IC.len=7`** (this is *why* the verify cost is invariant).

| Artifact | DEPTH-4 | **DEPTH-16** |
|---|---|---|
| `policy_final.zkey` | 1.34 MB | **4.51 MB** (gates the browser download) |
| `policy.wasm` (witness) | 1.77 MB | **1.80 MB** |
| Browser one-time download | — | **≈ 6.3 MB** (zkey + wasm), cacheable |

## C. Real DEPTH-16 allowlist

A genuine **65,536-leaf Poseidon-Merkle tree** (payee's `dest_field` at index 0, 65,535 distinct other leaves) — no sparse shortcut, no mock root. Built in **8.82 s** (one-time, 264 MB peak) in Node via circomlibjs Poseidon. Real root `12693890…864263`; real 16-level membership path persisted to `build/policy_secret.json` (so pay/fixture/timing reuse it rather than rebuild). The membership proof verifies inside the circuit (`mm.root === allowlist_root`).

## D. Re-deployed (new vk + new DEPTH-16 root)

| Contract | ID | Deploy tx |
|---|---|---|
| **Verifier** | `CCKBPVP7MZJOQYU44RK5MG4PA2YKV4UQ7CJMPK3OIHNFHLG5PEMNDREG` | [`cc720d51…`](https://stellar.expert/explorer/testnet/tx/cc720d5152875421c7ff6601a0ab5eb631e5a279b49abc12afc2b92ca3ba518e) |
| **Nulth account** (via `__constructor`) | `CBKMYVDFRY6MT4C4EGU36VQ57UZDZIBWQI7UPGZRRMWWPBCKFZZ32ISF` | [`a435536f…`](https://stellar.expert/explorer/testnet/tx/a435536f6255541cad5338537b51d6900c83a1c163063906b96598368b244089) |

`__constructor` args: DEPTH-16 vk + commitment `20326128…` (unchanged) + **root `12693890…` (new)** + USDC SAC token. The `ic.len()==7` check passed at construction (proof the vk is well-formed).

## E. Valid DEPTH-16 proof-authorized USDC payment

- **Fund** (agent → account, 5 USDC): [`8019f44e…`](https://stellar.expert/explorer/testnet/tx/8019f44e77642b1c3fa2434b9e4f6185dbc878f4db99b0caded4afdf8420dad3) — account `0 → 50000000`.
- **Payment** (account → payee, **1.0 USDC**, real depth-16 membership proof, proves at pay-time binding the live `signature_payload`): [`8d204b9b…`](https://stellar.expert/explorer/testnet/tx/8d204b9be2ff0d42ecdd50b8bc0e2f89155e8696e7e3576371adfa7a4f4c84a7) — **SUCCESS**.

| Account | before | after | Δ |
|---|---|---|---|
| Nulth account `CBKMY…ISF` | `50000000` (5.0) | `40000000` (4.0) | **−1.0 USDC** |
| Payee `GBEOVHEZ…UU4BS` | `230474000` | `240474000` | **+1.0 USDC** |

All P1 hardened checks + the sigpayload binding held at DEPTH-16 (the payment succeeding proves the 16-level path verified and the off-chain payload matched the host).

## F. Verify cost — UNCHANGED (the key fact, confirmed on-chain not assumed)

| | instructions | % of 400M ceiling |
|---|---|---|
| P1 DEPTH-4 | 34,149,591 | 8.537 % |
| **DEPTH-16** | **34,149,591** | **8.537 %** |
| **Δ** | **0** | **0** |

Decoded from the payment tx envelope (`sorobanData.resources().instructions()`). **Identical to the byte** — confirming Groth16 verify cost is a function of the (fixed) 6 public inputs + the pairing, independent of the 3× larger circuit. The allowlist can grow to 65,536 payees with **zero on-chain cost increase**.

## G. Hardening is depth-independent

`cargo test -p covenant-account` → **`test result: ok. 14 passed; 0 failed`** at DEPTH-16. Fixtures regenerated for the new circuit/vk/root (`scripts/gen_fixture.mjs` → `contracts/covenant_account/src/fixture_data.rs`). The full distinct-error matrix (NoContext, TooManyContexts, BadTokenBinding, BadFromBinding, AmountTooLarge, BadAmountBinding, BadDestBinding, BadPolicyBinding, BadSigPayload, BadSignalCount, BadProof, MalformedVk + valid) holds unchanged — the contract is depth-agnostic.

## H. Proving feasibility — MEASURED (real, not simulated)

**Node** (`scripts/measure_node.mjs`, `groth16.fullProve`, 3 iterations, real input):

| iter | fullProve |
|---|---|
| 1 (cold) | 922 ms |
| 2 | 747 ms |
| 3 | 674 ms |

→ **avg 781 ms, best 674 ms**, verify=true, process peak RSS **638 MB** (Node runtime + curve tables + zkey buffer).

**Browser** — REAL headless Chrome **149.0.7827.114**, driven via the DevTools Protocol (`scripts/run_browser.mjs`, no puppeteer; harness = `web/prover/`):

| metric | value |
|---|---|
| **client-side proving time** | **865 ms** |
| verify (in-browser) | **true** |
| JS heap at proof time | ~49 MB (`performance.memory.usedJSHeapSize`) |
| JS heap post-GC (CDP) | 7 MB |
| one-time artifact download | 4.5 MB zkey + 1.8 MB wasm |

Private inputs (cap, salt, allowlist path) never leave the browser; snarkjs runs the 9,402-constraint circuit and emits the `ProofSig` entirely client-side. The harness is the clean seed of the §14 prover, not a throwaway. **Reproduce:** `node scripts/run_browser.mjs` (headless), or `python3 -m http.server -d web/prover 8765` then open `http://localhost:8765/` and click *Generate proof*.

### Verdict — VIABLE for the zero-terminal demo
- **Time:** sub-second in a real browser (865 ms) — comfortably inside the "a few seconds" target, with margin even on slower machines.
- **Memory:** ~49 MB JS heap — fine for any modern browser/laptop.
- **Download:** ~6.3 MB one-time, cacheable — acceptable.

**No server-side proving fallback is required.** (If a low-end device ever struggles, the standard mitigations apply — run in a Web Worker with a progress bar, or precompute — but the measured numbers don't call for it.)

---

## Summary

DEPTH-16 is the production circuit going forward. The allowlist scales to 65,536 payees with **no on-chain cost change** (8.537%, decoded), the hardening is intact (cargo 14/14), and **client-side proving is real and fast (865 ms in-browser)** — the architecture-defining unknown before the frontend is resolved GREEN.

**Artifacts:** circuit `circuits/policy.circom` (DEPTH-16) · `circuits/build/{policy_final.zkey, policy_js/policy.wasm, verification_key.json}` · browser harness `web/prover/` · drivers `scripts/{setup_p1,pay_p1,gen_fixture,measure_node,run_browser}.mjs`.

## STOP

This step is complete. **The frontend and governance (P2) are NOT started, per instruction.** Awaiting your go.
