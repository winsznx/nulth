# REPORT — Auditor & Verify wired (Tier-1 ZK disclosure, live on-chain)

**Date:** 2026-06-17 · **Network:** Stellar testnet (Protocol 26) · **Scope:** wire the `/verify` (Auditor & Verify) route to a **real Tier-1 ZK disclosure** (PRD §11): prove the hidden cap is ≤ a public `regulatory_max` — without revealing the cap — and **verify it on-chain** on the deployed BN254 verifier. Other preview routes (Agent, Exploitation Deck) unchanged.

**Bottom line:** a disclosure proof is generated **in the browser (173 ms)** and **verified on-chain** by the deployed verifier (`verify_proof → true`); when the claimed limit is below the hidden cap the circuit is unsatisfiable and the operator **cannot produce a proof** (truthful refusal, nothing revealed). New circuit, **no new contract** — it reuses the deployed generic BN254 verifier with a new vk. No mocks; every value is a real proof or a live read.

---

## The circuit — `circuits/disclosure.circom` (Tier-1)

Exactly the PRD §11 spec: `Poseidon(cap,salt) === policy_commitment ∧ cap ≤ regulatory_max`.

| | |
|---|---|
| Public inputs | `[policy_commitment, regulatory_max]` |
| Private inputs | `[cap, salt]` |
| Constraints | **824** (544 non-linear + 280 linear) — "a few hundred", as predicted |
| vk | `nPublic=2`, `IC.len=3` |
| zkey | **382 KB** · wasm 1.7 MB (tiny — fast to download + prove client-side) |

The commitment opening binds the proof to **this treasury's real cap** (the same `policy_commitment` the account stores on-chain), so the auditor learns only the true/false bit `cap ≤ regulatory_max` — never the cap.

## Verifies on the EXISTING deployed verifier (no new contract)

`verify_proof(vk, proof, pub_signals)` is generic over the vk + number of public signals. The disclosure proof verifies on the **already-deployed** BN254 verifier [`CCKBPVP7…NDREG`](https://stellar.expert/explorer/testnet/contract/CCKBPVP7MZJOQYU44RK5MG4PA2YKV4UQ7CJMPK3OIHNFHLG5PEMNDREG) by passing the disclosure circuit's vk — no redeploy needed.

## On-chain de-risk (node)

| check | result |
|---|---|
| compliant (cap 100 ≤ 500 USDC) off-chain verify | `true` |
| compliant — **on-chain `verify_proof`** (sim) | **`true`** · 28,467,320 instr |
| compliant — **settled on-chain verification tx** | [`5158ae9d…0c559`](https://stellar.expert/explorer/testnet/tx/5158ae9da4f73ec73c2e1278a46a354888470cb76af0219169bb1b20e280c559) · **SUCCESS** |
| non-compliant (cap 100 > 5 USDC) | **witness abort** at the `LessEqThan` constraint — no proof can be produced |

## Live in the browser (`/verify`)

Verified headless (`scripts/disc_e2e.mjs`), **zero app errors**:

| case | result |
|---|---|
| limit **500 ≥ cap 100** | **verified** · in-browser proof **173 ms** · on-chain `verify_proof → true` · 28,467,320 instr · bound to the live commitment `20326128…` (`0x2cf02e…4e86e56`) |
| limit **50 < cap 100** | **cannotprove** · witness aborts (snarkjs `LessEqThan` fail) · surfaced as *"No proof exists — the hidden cap exceeds this limit … Nothing about the cap is revealed."* |

Flow: set the limit → **prove in the browser** (snarkjs over the disclosure circuit, secret `cap`/`salt` never leave the device) → **verify on-chain** (read-only sim executes the deployed verifier's real wasm). The scale visual reflects the real verdict; the public `policy_commitment` is read **live from the account** so the proof is bound to the real treasury.

**UI now matches the deployed reality:** the `Auditor & Verify` route no longer carries a `PREVIEW` badge; its panel shows `On-chain verify_proof: true`, the in-browser proof time, the verify cost (instr), and the bound commitment. The "regulatory_max is published by a Stellar anchor / KYC provider (oracle-trust)" assumption is stated in the UI, per §11.

## No mock / placeholder data

Every value on the screen is real: the proof is generated client-side, the verdict comes from the **on-chain** `verify_proof`, the commitment is read live from the account, the cap stays on the device. The refusal is the genuine witness abort, not a JS gate.

## How to run

```bash
# disclosure artifacts (built by the circuit setup; *.zkey is gitignored, regenerate if absent):
#   web/prover/disclosure.wasm · disclosure_final.zkey · disclosure_vk.json
python3 -m http.server -d web 8080
#   http://localhost:8080/  → Auditor & Verify → drag the limit → "Prove cap ≤ limit · verify on-chain"
```

Disclosure verification is read-only (a simulation that executes the deployed verifier), so it needs **no operator key** — it works in read-only mode too.

## Files touched

```
circuits/disclosure.circom                 # NEW Tier-1 circuit
circuits/build/disclosure_*                 # r1cs, wasm, zkey, vk
web/prover/disclosure.{wasm,final.zkey}     # served artifacts (zkey gitignored)
web/prover/disclosure_vk.json               # public vk (for on-chain verify_proof)
web/config.js                               # discWasm/discZkey/discVk
web/lib/serialize.js                        # + vkScVal / proofScVal / pubVecScVal
web/lib/prover.js                           # + proveDisclosure (client-side)
web/lib/chain.js                            # + verifyDisclosure (on-chain verify)
web/app.js                                  # /verify wired live; PREVIEW badge removed
scripts/disclosure_test.mjs, disc_e2e.mjs   # node de-risk + headless e2e
```

## STOP

`/verify` (Tier-1 auditor disclosure) is wired and live on-chain. Remaining previews: the Agent terminal and Exploitation Deck — wired next on your go.
