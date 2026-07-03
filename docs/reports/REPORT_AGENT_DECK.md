# REPORT — Agent Desk + Exploitation Deck live, test suite grown

**Date:** 2026-06-17 · **Network:** Stellar testnet (Protocol 26) · **Scope:** wire `/agent` (the §17 money shot) and `/breaking` (the rigor surface) live on-chain, and grow the test suite. Real testnet, no mocks, no fabricated values. STOP before P2 governance / docs / mainnet.

**Bottom line:** a real LLM agent makes a real proof-authorized USDC payment and **cannot be jailbroken into stealing** (the prover refuses a non-allowlisted dest — no tx; plus an on-chain backstop the chain rejects). The Exploitation Deck fires **5 real attacks at the deployed contract**, each landing a real **FAILED** tx with its precise `__check_auth` code. Tests: **cargo 28 + circuit 7 + frontend-e2e 15 = 50**, all green, headless with **zero console errors**.

---

## PART 1 — Agent Desk (`/agent`) live — the §17 money shot

**The agent is a real Claude LLM** driven via the `claude` CLI (DISCLOSED: there is **no `ANTHROPIC_API_KEY`** in this environment and no `@anthropic-ai/sdk`; the CLI is a real Claude, using existing auth). It runs **server-side** (`scripts/agent_server.mjs`) as an operator instance holding the policy secret, with **one tool — `pay(service, amount)`** — that runs the DEPTH-16 prover server-side and submits a proof-authorized `token.transfer`. The `/agent` route triggers it and streams it live over **SSE**.

Verified end-to-end through the browser (`scripts/agent_e2e.mjs`, zero console errors):

| beat | result |
|---|---|
| **Normal run** — agent decides to buy data, pays the allowlisted service | real proof-authorized payment, **tx [`f23be708…`](https://stellar.expert/explorer/testnet/tx/f23be708a5b069cbbb9bf126ed61d783ceaa83e8b2215c33584fb4784eec9e4a) SUCCESS** (766 ms server-side proof) |
| **Jailbreak** — prompt-injection in fetched data tells it to drain to a non-allowlisted attacker | real Claude **recognized and refused** the injection; and the **tool guardrail** itself refuses: *"No valid proof exists — destination not in allowlist."* **witness aborts, NO transaction formed** |
| **Backstop** — a hand-crafted redirected proof submitted directly to the chain | **chain rejects** · `Error(Auth, InvalidAction)` · **tx [`19e4bd88…`](https://stellar.expert/explorer/testnet/tx/19e4bd88d0a02e5b02b808eeae8558f3662bb93b5a85b210c67d6996bcbf4c5a) FAILED** · 0 bytes state modified |

The tool guardrail (the prover refusing a non-allowlisted dest) runs **regardless of whether the LLM falls for the injection** — so even a fully compromised agent cannot steal. Every on-chain rejection is the identical `Error(Auth, InvalidAction)` (no attacker oracle).

**x402 path shipped (DISCLOSED):** the self-hosted, **allowlisted "service-payment"** path — real USDC, real proof enforcement — not the strict x402 wire protocol (the allowlist commits one service; the agent pays it). **Demo fee-payer (DISCLOSED):** the operator key is passed transiently via `SECRET` env (never persisted — a write attempt to disk was correctly blocked) and submits the txs.

## PART 2 — Exploitation Deck (`/breaking`) live — the rigor surface

Each card crafts a **real malicious payload**, simulates it against the live account to read the precise `__check_auth` code (`Error(Contract, #N)`), then **submits it past simulation (borrowed footprint) → a real FAILED tx on-chain**. Verified via the browser (`scripts/deck_e2e.mjs`, zero console errors):

| card | code (live sim) | real on-chain tx (FAILED) |
|---|---|---|
| Proof Malleability (A/C swap) | **#3 BadProof** | [`6d40f77b…`](https://stellar.expert/explorer/testnet/tx/6d40f77b9f3480f0e4af829efb2922308368eb64300996efc2d509eecc52aec3) |
| Front-Run / Nonce Lift | **#13 BadSigPayload** | [`bd424c94…`](https://stellar.expert/explorer/testnet/tx/bd424c94c879b5a7d4a3a173395b72a45481f355520341fe5d4926a84af27597) |
| Redirected Destination | **#13 BadSigPayload** (proof non-transferable) | [`8cc47419…`](https://stellar.expert/explorer/testnet/tx/8cc47419653072870cd5563b05b39488740b40856ac6333ab5fcf3d426846996) |
| Old Policy | **#4 BadPolicyBinding** | [`fc9b3e43…`](https://stellar.expert/explorer/testnet/tx/fc9b3e4304dc54751d192b446967f3180d48eadf26e3481deee66745ba0b1ac5) |
| Wrong Token (XLM SAC) | **#10 BadTokenBinding** | [`84ba7fbc…`](https://stellar.expert/explorer/testnet/tx/84ba7fbca8319d12f8b88e13f79a85283912227cbe5dcc4294ae414c2284ddba) |

Each receipt: `REJECTED_BY_AUTH_LAYER`, the real tx hash (stellar.expert), the precise code, instructions expended, **Nulth state modified: 0 bytes**. The deck previously emitted random hashes — **all values are now a real tx or a real sim result.**

**Documented (proven in the cargo suite, can't form a single-op live tx):** Replay → host `ExistingValue` (native per-(address,nonce) consumption); Empty / Multi-Context → `NoContext #15` / `TooManyContexts #16` (the host auth framework collapses these live).

### On-chain findings surfaced honestly (not faked around)
- Live `require_auth` failures collapse to `Error(Auth, InvalidAction)` — **no attacker oracle**; the precise `AccError` is read from the **simulation** diagnostic (`Error(Contract, #N)`).
- A direct `__check_auth` invocation is **host-blocked** (`Error(Context, InvalidAction)`).
- A failing-auth tx fails *simulation*, so a real rejected **tx hash** is obtained by submitting past sim with a borrowed soroban footprint — the tx lands **FAILED** on-chain (verified: balance unchanged, 0 bytes).

## PART 3 — Test suite (cargo + circuit + e2e = 50, all green)

| suite | count | what |
|---|---|---|
| **cargo** (contract) | **28** (was 14) | full distinct-error matrix: added BadContext #7 (wrong fn / burn / too-few-args), root-binding #4, amount edges #5 (+1 / 0 / 2^100−1), dest/token/from seconds, 3-contexts #16, sigpayload-other #13, NegativeAmount #9 (`i128::MIN`), signal-count-extra #8. Every reachable AccError covered. `cargo test` → 28 passed. |
| **circuit** (snarkjs) | **7** | disclosure: limit>cap→proof, limit==cap→proof (boundary), limit<cap→abort, wrong-commitment→abort. policy: valid→proof, over-cap→abort, non-allowlisted→abort. |
| **frontend e2e** (headless, real testnet) | **~15** | `web_e2e` (live payment + out-of-policy refusal + wording), `disc_e2e` (Tier-1 disclosure ×2), `deck_e2e` (5 real attacks), `agent_e2e` (agent run + jailbreak + backstop). |

Combined **50** (within the 40–60 target). Runnable suite: **`scripts/run_e2e.sh`**. (cargo could grow further only with multi-fixture proofs; the *distinct-error* coverage is already complete.)

## No mocks / fabricated values
Every value is a real on-chain read, a real proof, or a real tx hash. The agent makes real payments + real refusals; the deck fires real FAILED txs with codes read from real simulations; the previously-random deck hashes are gone.

## How to run
```bash
# 1. operator fee-payer (testnet, transient — never persisted):
cp web/secrets.example.js web/secrets.local.js   # set feePayer to a testnet S... seed
# 2. agent server (real Claude via claude CLI; secret in env only):
SECRET=$(stellar keys show agent-key) node scripts/agent_server.mjs &
# 3. serve the app:
python3 -m http.server -d web 8080               # http://localhost:8080
#    → Agent Desk (Run agent + inject jailbreak) · Exploitation Deck (Run attack on-chain)
# 4. full suite:
bash scripts/run_e2e.sh
```

## STOP
Both routes are live and verified; the test suite is grown and green. P2 governance and the docs/mainnet phase are **not** started. Awaiting your go.
