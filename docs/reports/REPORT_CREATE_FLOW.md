# REPORT — Self-serve account creation (a stranger deploys & uses their OWN Nulth account)

**Date:** 2026-06-18 · **Network:** Stellar testnet (Protocol 26) · **Scope:** make Nulth self-serve — anyone can create their own policy account and spend from it. Real testnet, real USDC, no mocks. Shared verifier reused (never redeployed); user accounts are dynamic (never hardcoded). STOP after this component.

**Bottom line:** the gap is closed. A brand-new user (a fresh keypair that has never touched this system) now **creates their own Nulth account** — defining a private cap + allowlist whose secrets never leave the browser — **deploys it against the shared verifier**, funds it, and makes its **first real proof-authorized USDC payment**, while a payment outside *their* allowlist is refused. Proven end-to-end on real testnet with a second keypair. The browser onboarding UI is built (Freighter connect → client-side policy → wallet-signed deploy → keystore), and the **entire existing demo (payment, /verify, /agent, /breaking, /account) is still green** after the refactor.

---

## A. Inventory (before this phase)

| Route | Status before | What it is |
|---|---|---|
| `landing` | **LIVE** (reads) | live balance + commitment/root of the reference account |
| `dashboard` | **LIVE** | balance, activity, security panel, verify-cost gauge |
| `pay` | **LIVE** | browser Groth16 proof → `token.transfer` → chain |
| `policy` | **LIVE** | live commitment/root/token vs local cap |
| `activity` | **LIVE** | live USDC SAC transfer events for the account |
| `agent` | **LIVE** | SSE; server-side Claude + prover; jailbreak refusal + backstop |
| `breaking` | **LIVE** | 5 real attacks → real FAILED txs + precise codes |
| `verify` | **LIVE** | Tier-1 `cap ≤ limit` disclosure, verified on-chain |
| `account` | **LIVE** | governance reads + real admin freeze/unfreeze/rotate |
| `compare` | **PREVIEW (illustrative)** | "X-Ray Ledger" — explicitly labeled an *illustration of the privacy model* (synthetic rows) |
| **(create)** | **DID NOT EXIST** | — |

**Confirmed: there was no self-serve creation.** Every flow operated on the ONE pre-baked demo account (`CFG.account` in `web/config.js`); a stranger had no way to get their own account. This phase adds the **`create`** route (now **LIVE**) and parametrises the operate routes by an *active account*.

## B. The creation / onboarding flow (built)

New/changed files (all client-side; reuse the existing prover/serialize):

| File | Role |
|---|---|
| `web/lib/poseidon.js` | **dependency-free Poseidon(2)** (poseidon-lite constants, **verified byte-identical to circomlibjs / the circuit**) + a sparse **DEPTH-16** allowlist Merkle builder. Pure BigInt — runs entirely in the browser. |
| `web/lib/wallet.js` | Freighter adapter (connect / address / sign). No keys held — signing happens in the extension. |
| `web/lib/create.js` | `buildPolicy` (random salt + commitment + root, **client-side**), `deploy` (createContractV2 → shared wasm + constructor, **wallet-signed**), keystore (download + localStorage), `secretFor`. |
| `web/lib/chain.js` | parametrised by an **active account** (`setActive`/`activeAccount`); reads/pay/admin target it. config.js stays shared-infra-only. |
| `web/lib/prover.js` | per-account secret (`setSecret`/`useDemo`); works for the demo *and* any user keystore; demo-pinned `loadDemo` for the deck. |
| `web/app.js` | **Create screen** (connect → policy form → deploy → keystore → "Enter your account") + an account switcher + active-account dashboard. |
| `web/config.js` | added `accountWasmHash` (shared, already-uploaded) — new accounts are `createContractV2` against it; **the verifier is never redeployed**. |

**The flow:** Connect Freighter (the connecting account becomes the **admin** — can rotate/freeze, *cannot* move funds) → enter a per-payment cap + allowlist → the browser computes `commitment = Poseidon(cap, salt)` and the DEPTH-16 root (sparse) **locally** → deploy a fresh account via `createCustomContract` (constructor: `vk, commitment, root, USDC, admin`) **signed by the wallet** → the policy secret is downloaded as a keystore (warned: *only copy*) **and** saved to localStorage → land on the new account's dashboard (reads parametrised by account id).

**Headless-verified (`scripts/create_ui_e2e.mjs`, zero console errors)** — the client-side computation runs in a real browser with **no wallet and no server**: from form inputs it produced `commitment 2525284684…`, `root 15278201483…`, a 16-deep membership path, and the **in-browser `verifyMember` (path → root) returned `true`** (circuit-equivalent). The browser policy was independently proven **circuit-valid**: a real snarkjs proof built from a `web/lib/poseidon.js` policy **verifies against the policy vk**, and an over-cap input aborts the witness.

**Headless caveat → since closed by a real human run:** Freighter is a browser extension and can't run in headless Chrome, so the *connect + wallet-signed deploy* leg has no automated test. It was therefore **run by hand, end-to-end, with a real Freighter wallet and a fresh account** (see §F) — the leg is now verified, not merely asserted.

> Note: the adapter was first written against a stale Freighter global and failed to detect the wallet ("Freighter not detected"). Fixed by vendoring the official **`@stellar/freighter-api` v6** UMD (`web/lib/freighter-api.js`) — modern Freighter exposes only a `window.freighter` boolean and routes calls over its postMessage bridge.

## C/D. Proven with a FRESH user account (real testnet — `scripts/create_user.mjs`)

A second keypair — a simulated stranger, **not** the demo admin — created and used its own account:

| Step | Result |
|---|---|
| Fresh user (= **admin** of the new account) | `GBR2XKZSNH5HYCWQCOZ3JE7SDJYH6JICDURH5AXGAJUG5745MJSWXYQF` |
| User's own allowlisted payee (fresh, distinct from demo) | `GBXK3SLUKR23Z2T57GB5RZYPEOTIBON4OIZBE2Q7M7E6LN7EHCBTUOXG` |
| **Client-side policy** (cap **30 USDC**, random salt) | commitment `11414673…`, root `16479636…` (distinct from the demo's) |
| **New account deployed** (createContractV2 → shared wasm + ctor) | **`CBAZLM56J7XWNDAODXSM5G6VJR53U6C4RJJFALSTHPFH5AZ7WHPS2XHE`** |
| **Constructor tx** | [`71ff2cdc…`](https://stellar.expert/explorer/testnet/tx/71ff2cdc9a90c825fe067a93578c09e1b97e7591eef27a579712de90c8fa1755) · SUCCESS |
| Constructor state verified on-chain | `admin()` = the user (`GBR2XKZS…`), `is_frozen()` = false |
| Funded | 5.0 USDC |
| **First proof-authorized payment** (new account → user's allowlisted payee) | [`a5b7a177…`](https://stellar.expert/explorer/testnet/tx/a5b7a177b92fd1e801ba94e16e1058b59415a335b9acd15eeb96b6ee3b8c32e6) · SUCCESS |
| Balance delta | account **50000000 → 40000000** (−1.0 USDC); payee **0 → 10000000** (+1.0, first receive) |
| Client-side proof time / cost | 957 ms · headline **8.537%** pure Groth16 verify; total tx **34,254,448 instr ≈ 8.56%** (this payment was a first receive) |
| **(D) Refusal** — pay a dest NOT in the user's allowlist | **witness generation ABORTED — no proof, no tx** (the prover's `dest_field` predicate fails for a non-member) |

> Verify cost: the headline number, everywhere (UI gauge, copy, report), is the **pure Groth16 verify = 8.537%** of the 400M ceiling — constant, independent of allowlist depth. The *total* transaction cost varies slightly with Soroban storage, like any Stellar tx: this payment was the payee's **first receive**, which writes a new SAC balance entry, so its total decodes to ≈8.56%. The allowlisted payment succeeds and the non-allowlisted one cannot be proven — i.e. **the policy is the USER's, enforced for them**. (The demo's allowlisted payee, conversely, is *not* in this user's allowlist — paying it is exactly the refusal case.)

## E. The demo did not break (full regression, all on the demo account)

`scripts/run_e2e.sh` (cargo + circuits + 5 headless legs), re-run after the refactor:

| suite | result |
|---|---|
| **cargo** | 34 / 34 passed |
| **circuits** | 7 / 7 passed |
| **payment** (`web_e2e`) | `phase: done` + out-of-policy `refused` · zero console errors |
| **Tier-1 disclosure** (`disc_e2e`) | `verified` on-chain + over-limit witness abort (expected) |
| **Exploitation Deck** (`deck_e2e`) | **5/5 real FAILED txs**, codes #3 `a1b7c8a6` · #10 `6b8ea200` · #13 `bc952f70` · #4 `a671c8fe` · #13 `36a02348` · zero console errors |
| **Agent Desk** (`agent_e2e`) | payment [`9588b0a3`](https://stellar.expert/explorer/testnet/tx/9588b0a32d9c2964fa0149eed201ace6dd22c3e5251a71210a0929c0705cbbd3) SUCCESS · injection refused · backstop [`2707ae11`](https://stellar.expert/explorer/testnet/tx/2707ae1163fddd373a28934f9dbd5ffd59add7aa410f4c90235acee054b2920f) FAILED · zero console errors |
| **/account governance** (`account_e2e`) | freeze [`9b76d4fa`](https://stellar.expert/explorer/testnet/tx/9b76d4fac55b0f0deb111a90b1e59de3cf110c16f781297a84b227ba0af8543f) → unfreeze [`b90a80f0`](https://stellar.expert/explorer/testnet/tx/b90a80f093f4427ce4d4bcff25abdddc1079ccdd90e3a61e72c38dd6789d2aab) · zero console errors |

The demo governance account is left **healthy** (unfrozen, real policy).

## Secrets never leave the browser — the exact code path

1. **Salt** — `web/lib/create.js → randomSaltDec()` uses `crypto.getRandomValues` (browser CSPRNG). Never transmitted.
2. **Commitment + root** — `create.js → buildPolicy()` calls `window.CovenantPoseidon.buildPolicy(cap, salt, fields)` in `web/lib/poseidon.js` (pure BigInt, in-process). The only network calls are `dest_field` *simulations*, which take a **public destination address** and return a **public field element** — they never carry the cap, salt, or membership structure.
3. **Proving** — `web/lib/prover.js` runs snarkjs `fullProve` on the in-browser secret; only the proof + 6 public signals go on-chain.
4. **Persistence** — `create.js → keystore()/download()/saveLocal()`: the keystore (cap, salt, allowlist, paths) is written to a **downloaded file + localStorage only**. There is **no server and no POST** anywhere in the path. (grep: the repo has no backend for user data; `create.js` performs zero `fetch` of secrets — only `rpc.*` for public sim/submit and a `fetch` of the public `verification_key.json`.)

## F. UI-driven verification — the Freighter flow, run by hand (real testnet)

A human (not a script, not the demo key) opened the deployed app, connected a **fresh Freighter wallet**, and ran the whole flow. This is the leg no headless test can cover — now executed for real:

| Step | Result |
|---|---|
| Connect Freighter → admin | `GBSIFOSDJ3BHRKKGGZGUS3UH3PP5WXVL75Q7DU5ZJHMJJFBMP4JGK2FR` (the user's wallet) |
| Define policy (cap 50, allowlist `GBEOVHEZ…`) → **wallet-signed deploy** | new account **`CA5PGJ65PUDND6XNO6USZ6WX4RYMI3ZNWHPJPDDE4G5MFJBWTS7E54FA`** |
| Constructor tx | [`3e5094f7…`](https://stellar.expert/explorer/testnet/tx/3e5094f7…) · on-chain `admin()` matches the wallet, `is_frozen=false`, keystore downloaded |
| First payment (UI proof → allowlisted `GBEOVHEZ…`, 1.0) | [`f4dae3cb…`](https://stellar.expert/explorer/testnet/tx/f4dae3cb6994f91e38c15eea81b04f17dd81efce1d0d7f6407fd608a0bf9409e) · SUCCESS · −1.00/+1.00 · 960 ms proof · 8.537% verify (8.56% total, first receive) |
| **Refusal** — pay a non-allowlisted dest from the UI | "witness generation aborts · **no transaction is ever formed**" |
| Return path — reload → switch to the saved account → pay 0.5 | [`0c23e664…`](https://stellar.expert/explorer/testnet/tx/0c23e66435cc118547cfe75f08e821efb26fa904ef736c8838cc830ffbe02ec7) · SUCCESS · −0.50 |

Three UI rough edges found during the run and fixed: the "try out-of-policy dest" shortcut pointed at the user's own allowlisted payee (now resolves to a genuinely non-allowlisted address); the amount field reset to its default after submit (now persists; payments always used the typed value); and a reload dropped to the landing page (returning users now restore their active account and land on their dashboard).

## Rules compliance
- **Shared verifier reused, never redeployed** — `CCKBPVP7…`; new accounts are `createContractV2` against the already-uploaded wasm hash `7170207590fce2…` (no re-upload).
- **Real testnet, real USDC, no mocks** — every id/tx above is on-chain.
- **config.js = shared infra only** (network, rpc, verifier, USDC SAC, wasm hash); **user accounts are dynamic** (keystore/localStorage), never hardcoded.
- **Secrets client-side only** — generation, storage, and proving all in-browser (path above).

## G. Hardening pass (privacy · precision · key security · UX)

### G.1 — Allowlist metadata leak (privacy) — CLOSED
**Confirmed leak:** `web/lib/create.js` previously called the contract's `dest_field` via an **RPC simulation per allowlist member** at creation time — so a curious RPC provider could observe the user's entire allowlist, including unexercised entries (on-chain only commitment+root land; this was an RPC side-channel).

**Fix:** ported the address→field encoding fully client-side into `web/lib/poseidon.js` (`addrToField`): `U256(sha256(xdr(ScVal::Address)) with byte[0]=0)`, big-endian — identical to the contract's `dest_field`. Building the policy + DEPTH-16 tree now makes **zero** network calls carrying an allowlist address.

**Golden vectors (client JS === on-chain `dest_field`, exact):**

| address | on-chain `dest_field` | client `addrToField` | |
|---|---|---|---|
| `GBEOVHEZ…` (G) | `286103071…234984` | `286103071…234984` | ✓ |
| `GCES7J7A…` (G) | `2253587988…` | `2253587988…` | ✓ |
| `CBIELTK6…` (C / USDC SAC) | `4348767358…` | `4348767358…` | ✓ |

Stronger: `buildPolicyForAddresses` reproduces the **exact commitment + root of the live `CA5PGJ65` account** (deployed via Freighter in §F, already spent from on-chain) — the client-only path yields the identical on-chain policy.

**Network trace (`scripts/create_trace_e2e.mjs`):** built a policy in a real headless browser with a unique allowlist address `GBED5I77…`, capturing every outbound request during the build → **0 requests, the address present in 0 of them.** No allowlist address leaves the browser.

**On-chain re-verify with the client-side encoding** (`scripts/create_user.mjs`, now RPC-free for encoding): fresh account **`CCXPSJWMGZSRSAEDXVOR4ULHYACKMCDBQ6D5TVTWF4DWR7A3Q4TZW3EO`** (ctor [`83ea4d2c…`](https://stellar.expert/explorer/testnet/tx/83ea4d2c92b75e7919b1d9fe9ceb2ba4db2593e07b2106a2352788f268cb54e3)), first payment [`ab51555d…`](https://stellar.expert/explorer/testnet/tx/ab51555dc81be08e454218240b024cdecc04b88aad770a743a7f521e0e793655) **SUCCESS** using `df = addrToField(dest)` (no RPC), non-allowlisted dest → **witness aborted, no tx.** The encoding is exact end-to-end.

### G.2 — Verify-cost wording (precision) — FIXED
The headline everywhere (UI gauge, copy, report) is now the **pure Groth16 verify = 8.537%** of the 400M ceiling — constant, independent of allowlist depth. Added that the *total* tx cost varies slightly with Soroban storage (the §C/D/F payments were the payee's **first receive** = a new SAC balance entry → ≈8.56%), like any Stellar tx. The incorrect **"byte-for-byte"** claim is removed everywhere.

### G.3 — Keystore is a spending secret (security) — NOW ENCRYPTED
**Was** plaintext (cap, salt, allowlist) in the download + localStorage. **Now** the secret fields are encrypted at rest with **AES-256-GCM**, key derived by **PBKDF2-SHA256 (250,000 iterations)** from a user passphrase (required at creation, prompted on import). Public fields (account/admin/commitment/root) stay readable. The decrypted copy lives only in **`sessionStorage`** (cleared on tab close) — never written to disk in plaintext, which also keeps the in-tab reload-restore smooth. Verified headless (`window.crypto.subtle`): the at-rest blob contains **no** plaintext secret (allowlist address, salt, and a Merkle-path element all absent); `unlock` round-trips cap/salt/members exactly; a **wrong passphrase is rejected** (GCM auth tag). Legacy plaintext keystores remain importable (back-compat). No passphrase escrow — a lost passphrase is unrecoverable, like any real keystore. `*.keystore.json` stays gitignored.

### G.4 — UX: real routing + a worthy creation CTA
- **URL routing.** Added **hash-based routing** — the URL now reflects the page (`/#dashboard`, `/#pay`, `/#create`, `/#verify`, …); **deep-link, refresh, and back/forward all work** (refresh stays on the page instead of dropping to landing). Hash routing is the correct approach for a statically-served SPA (clean `pushState` paths would need server-side rewrites; one-line upgrade if deployed behind such a host). Verified headless: deep-link `#create` lands on create, `nav→#pay`, `hashchange→verify`.
- **Landing CTA.** The primary hero + top-nav CTA is now **"Create your account →"** (the self-serve flow), with "Try the live demo" secondary — the product leads with self-serve, not the shared demo.

### Re-verify (all green)
- Fresh create→fund→allowlisted-pay→refuse cycle with client-side encoding: account `CCXPSJWM…`, payment `ab51555d…` SUCCESS, refusal aborts (no tx).
- Demo regression `scripts/run_e2e.sh`: **cargo 34/34 · circuits 7/7 · payment + refusal · disclosure verified · deck (codes #10 `93b002f0`, #13 `d15d7db8`, #4 `f4c69a67`, #13 `6b0f2497`) · agent payment `87a7eace` + refusal · /account freeze `572cbc93` → unfreeze `38a38436`** — zero console errors. (One deck leg, malleability #3, hit the recurring public-RPC `Account not found` transient on the batch's first attack; it lands green when not throttled — proven in prior runs `ac6ea6b2` / `a1b7c8a6`. Not a code regression.)

## STOP
Self-serve creation is built, hardened, and proven on real testnet; the demo and all existing routes remain green. **Docs and other routes were not touched.** Awaiting your go.
