# REPORT — P2 Governance (admin rotation + freeze), live on a new deployment

**Date:** 2026-06-17 · **Network:** Stellar testnet (Protocol 26) · **SDK:** soroban-sdk 26.1.0 · **Scope:** add admin-authorized **policy rotation** + **freeze/unfreeze** to `__check_auth`, redeploy, re-point the whole app, wire the `/account` admin route, grow the governance tests. Real testnet, no mocks. STOP before docs/mainnet.

**Bottom line:** the Nulth account now has a **disclosed governance admin** that can **rotate the committed policy** and **freeze/unfreeze** the account — and provably **cannot move funds** (spending is still authorized *only* by a valid ZK proof for the committed policy). The contract was redeployed with the admin set atomically in the constructor; the **frontend was re-pointed to the new account ID (one source of truth)**, the `/account` route went live with **real admin-signed on-chain txs**, and the **entire prior surface still works against the new deployment** (payment, Tier-1 disclosure, agent + jailbreak + backstop, all 5 deck attacks). Tests: **cargo 34 (was 28) + circuit 7 + a 5-driver e2e suite**, all green.

---

## A. Governance contract (`covenant_account/src/lib.rs`)

| Change | Detail |
|---|---|
| Storage | added `ADMIN: Address`, `FROZEN: bool` to instance storage |
| `__constructor` | now `(vk, policy_commitment, allowlist_root, token, admin)` — admin + `frozen=false` set **atomically at deploy** (no uninit/front-run window). Emits an `init` event. |
| `rotate_policy(new_commitment, new_root)` | `admin.require_auth()`; updates the committed policy. In-flight proofs against the OLD policy then fail `BadPolicyBinding`. Emits `rotate`. |
| `freeze()` / `unfreeze()` | `admin.require_auth()`; toggles `FROZEN`. Emit `freeze` / `unfreeze`. |
| `__check_auth` | **early frozen gate** — returns `AccountFrozen` *before* any binding/pairing work. |
| read views | `is_frozen() -> bool`, `admin() -> Address` for the admin surface |
| new error codes | **17 `AccountFrozen`**, **18 `Unauthorized`** (reserved — non-admin calls are rejected by `admin.require_auth()`, host-enforced, before any body runs) |
| events | `init` / `rotate` / `freeze` / `unfreeze` for auditability (the restore tx below shows the decoded `rotate` event on-chain) |

**The admin cannot move funds.** It is *not* a spending key — there is no spending key. A `transfer` is authorized only through `__check_auth`, which requires a valid Groth16 proof for the **committed** policy. The admin can change *which* policy is committed, or halt spending entirely, but it can never itself produce a spend.

**Disclosed trust root + hardening paths (documented, not built — per instruction):**
- **Single admin** is the governance trust root. Hardening: **M-of-N multisig + a timelock** on `rotate_policy`/`freeze` (REPORT_P0 §2 #9).
- Rotation uses **simple invalidation** (old proofs fail immediately). Hardening: **epoch-versioned commitments with a previous-epoch grace window** so in-flight proofs settle across a rotation (REPORT_P0 §2 #10).

## B. Redeploy + re-point (the account ID changed — nothing broke)

New governance account, deployed via `__constructor` with the **same commitment/root** (so the existing `policy_secret` still proves) and a real admin key. Verifier unchanged (generic).

| Contract | ID / value | Tx |
|---|---|---|
| **Nulth governance account** | `CANA5QYVHNON7AV752ZRATFW2T5BMS3MU5DDPJMU5UGSR3KSH45LOGZE` | constructor deploy [`7349075a…`](https://stellar.expert/explorer/testnet/tx/7349075a28e89c8784a12c5c76fcbc35ccd3e0355a7bf937eb2a8461d62fa093) · wasm upload [`8cd5edd4…`](https://stellar.expert/explorer/testnet/tx/8cd5edd45bfa8d493deaf580a917a4d4a1aab04ee92dd6243ad35f5b4b8fe9bd) |
| **Admin (governance key)** | `GDSY6EO672YWIL5VPQJ2O4IIHFTXIMR763R7SMSMBRDQKNGTHNAJWVBU` | set in constructor; verified `admin()`/`is_frozen()` reads |
| **Verifier (unchanged)** | `CCKBPVP7MZJOQYU44RK5MG4PA2YKV4UQ7CJMPK3OIHNFHLG5PEMNDREG` | — |
| wasm hash | `7170207590fce2398ba94ffdbc96282444e02897112f05c73c63af93ba847411` | 8 exported fns incl. `rotate_policy`/`freeze`/`unfreeze`/`is_frozen`/`admin` |

- **Constructor state verified on-chain:** `is_frozen()` → `false`, `admin()` → `GDSY6EO6…`.
- **Re-funded:** 5.0 USDC transferred from the operator to the new account.
- **One source of truth:** `web/config.js` (`account` + new `admin` field) is the canonical address block; `chain.js`, `attacks.js`, `app.js` and the browser e2e all read it. The node de-risk scripts (`agent_server.mjs`, `attack_probe/submit.mjs`, `check_auth_direct.mjs`), `web/README.md`, and the PRD live-address table were updated too. **`grep` confirms no operational file references the old account ID** — the only remaining occurrences are dated historical reports (`REPORT_DEPTH16.md`) and the `supersedes_account_id` field in `build/deployed_p2.json`.
- Old account `CBKMYVDFRY…ISF` is superseded (left with its residual balance; not referenced by any live path).

## C. Governance proven on-chain (real txs — the safety net for the redeploy)

All against the new account, real testnet. Rejections are landed as real **FAILED** txs (`require_auth` failures fail simulation, so they're submitted past sim with a borrowed footprint — the deck's proven technique). The account is left **unfrozen, on its real policy**.

| Governance assertion | result | tx |
|---|---|---|
| **non-admin freeze → rejected** | real **FAILED** (agent-key's envelope signature does not satisfy `admin.require_auth`) | [`308d140c…`](https://stellar.expert/explorer/testnet/tx/308d140ccda52c061978b8b1b197cce52e9aee37dd9d2b71742236d185b442ae) |
| **admin freeze → SUCCESS** | account frozen | [`bea27046…`](https://stellar.expert/explorer/testnet/tx/bea27046f8453a13ef8d6069a266ecc62ecc1bdc0f67a6bb14d3339741973774) |
| **frozen → proof-spend rejected** | `__check_auth` **#17 `AccountFrozen`** (read from sim), real **FAILED** | [`071294a4…`](https://stellar.expert/explorer/testnet/tx/071294a4d785c10c5222c813b6bc6789ac7b64511864145748a6da0636fce785) |
| **admin unfreeze → SUCCESS** | spending re-enabled | [`8d9113b4…`](https://stellar.expert/explorer/testnet/tx/8d9113b4ac5dcf7d101bbd3ec974f10a065677553193078e50c88dbe58d2072d) |
| **rotate → new (bogus) commitment → SUCCESS** | committed policy changed | [`d785986c…`](https://stellar.expert/explorer/testnet/tx/d785986ca8e7e1f066ba6fb3c8b472bfc620d5f60ea99c6853b4f866f73f72ab) |
| **old proof after rotation → rejected** | `__check_auth` **#4 `BadPolicyBinding`** (read from sim), real **FAILED** | [`3411ef29…`](https://stellar.expert/explorer/testnet/tx/3411ef29de8e62f81f4578562a69618d649d13500a8726928748f115663e708f) |
| **rotate → real commitment (restore) → SUCCESS** | policy restored; decoded `rotate` event = real commitment/root | [`5183874a…`](https://stellar.expert/explorer/testnet/tx/5183874a3c0bf1e6da2f2cac8cb25440cf58c79ec8041ab42020b84a50545d78) |
| **fresh proof for the (re-)committed policy → SUCCESS** | real **1.0 USDC** moved | [`c20d1e33…`](https://stellar.expert/explorer/testnet/tx/c20d1e339a2004d8794d99ae32032dbb3a9df0faeba9aca750d3b0fb8c45bc19) |

This is exactly the required arc: **rotate away → the old proof fails `BadPolicyBinding` → rotate back → a fresh proof for the new policy succeeds**, and **freeze → a proof-spend fails `AccountFrozen` → unfreeze → spending works**, with **non-admin governance rejected**. Driver: `scripts/gov_proof.mjs` + `scripts/gov_rotate_cycle.mjs` (self-restoring: the rotate-back runs in a guaranteed `finally` with retries, so the account is never left bricked).

*(Honest note: the first `gov_proof.mjs` run hit a transient TLS error from the public RPC mid-sequence, after rotating to the bogus policy. The account was immediately restored via an admin CLI `rotate_policy` ([`fdc6bcb1…`](https://stellar.expert/explorer/testnet/tx/fdc6bcb1a36a610f1ce3eeba8665d003038ffa618b4047ecdb1658fe3a46f3f0), whose CLI output decoded the on-chain `rotate` event), and the clean rotate cycle above was then captured by the self-restoring script. No state was left inconsistent.)*

## D. `/account` route live (the last preview, now wired)

The admin surface (`App.account` + `chain.js` `adminFreeze`/`adminUnfreeze`/`adminRotate`) shows the **live frozen status, admin key, and policy**, and performs **real admin-signed on-chain txs**. The admin signs as the transaction source, so `admin.require_auth()` is satisfied by the envelope signature (SOURCE_ACCOUNT credentials). The UI states plainly that the admin **cannot move funds**, and is read-only if no admin key is configured. PREVIEW badge removed (the screen is new + live; nothing fabricated).

Verified headless against the new deployment (`scripts/account_e2e.mjs`, **zero console errors**):

| beat | result |
|---|---|
| live reads | `frozen=false`, on-chain `admin` shown, local admin **key matches**, "cannot move funds" copy present |
| **UI freeze** (admin-signed) | **SUCCESS** [`5b0da265…`](https://stellar.expert/explorer/testnet/tx/5b0da265d7d23560d29c0a7fcc23ae147d68aa6523e5202bd2f2d4f63983f53b) · live `frozen → true` |
| **UI unfreeze** (admin-signed) | **SUCCESS** [`c4e44a91…`](https://stellar.expert/explorer/testnet/tx/c4e44a91ba937d07ac369007039e1ac6b07134bcb2ad2bbb5ab077594133abaf) · live `frozen → false` |

The admin seed lives only in the gitignored `web/secrets.local.js` (a new `admin` field, documented in `secrets.example.js`) — same client-side pattern as the operator fee-payer, disclosed as governance-only.

## E. Full e2e re-run against the NEW deployment (nothing broke)

Every prior route re-verified on `CANA5QYV…`, headless, real testnet:

| route | result |
|---|---|
| **Payment** (browser proof → USDC transfer) | **SUCCESS** [`24ce435e…`](https://stellar.expert/explorer/testnet/tx/24ce435e822caa5961913ca1a98491d413bf18309857164b10c42e3ab0650677) (−1 USDC); out-of-policy dest → **refused** (witness abort, no tx) |
| **Tier-1 disclosure** | proof **verified on-chain** (28,467,320 instr); over-limit → witness abort (expected snarkjs assert) |
| **Exploitation Deck (5/5)** | real **FAILED** txs w/ precise codes: malleability **#3** [`ac6ea6b2`](https://stellar.expert/explorer/testnet/tx/ac6ea6b2a34333d4978b81f519f3c1db0733d58703273d286d1e3595a14e0468) · wrong-token **#10** [`68606eb7`](https://stellar.expert/explorer/testnet/tx/68606eb798e02083300046415c19dbbe6771306258e4ac5806735ea29bc07eb4) · redirect **#13** [`b20217b0`](https://stellar.expert/explorer/testnet/tx/b20217b0f18452d174ff2a16447e19c759442c7d4c562ad27628f4f19294a8fb) · old-policy **#4** [`fbc14d7b`](https://stellar.expert/explorer/testnet/tx/fbc14d7b4d3742dc4ef278f31e1a024fcde1986181313fcdff10cbc88207b839) · nonce-lift **#13** [`2e7cd8f8`](https://stellar.expert/explorer/testnet/tx/2e7cd8f859c59b206b889ac9267338c55bb78083eb232c342593c814ec9f6efe) |
| **Agent Desk** (real Claude + jailbreak) | service payment **SUCCESS** [`53e651ef`](https://stellar.expert/explorer/testnet/tx/53e651ef2fbd46d79dcbd77217bf2914fb8980555291dbb8f961bec94d1bfe05); injection **refused** (LLM + prover guardrail, no tx); backstop **FAILED** [`20e90309`](https://stellar.expert/explorer/testnet/tx/20e903094a3abf0f49f1e01e2f54c5fea9af86e88cb3ff8b2b34cf801bb307dd) |
| **/account governance** | freeze/unfreeze SUCCESS (§D) |

**RPC flakiness, disclosed honestly:** the public Soroban testnet RPC intermittently returns `Account not found` for a heavily-used source mid-burst — it hit one (different) deck leg on each of two runs, and one TLS `bad record mac` mid-gov-sequence. These are network artifacts, **not** contract behavior: every attack lands the correct code/FAILED tx when its leg isn't throttled, and all 5 codes are confirmed. `run_e2e.sh` paces the legs (`sleep`, override with `E2E_PAUSE`) to minimize it.

## F. Tests (cargo 34 + circuit 7 + 5-driver e2e suite)

| suite | count | what |
|---|---|---|
| **cargo** | **34** (was 28) | +6 governance: `rotate_then_old_proof_fails` (#4 after rotation), `rotate_to_matching_policy_succeeds` (proof for the newly-committed policy authorizes), `freeze_blocks_valid_proof` (#17), `unfreeze_restores_spend`, `non_admin_rotate_rejected`, `non_admin_freeze_rejected` (both `should_panic` — `admin.require_auth` unsatisfiable). `cargo test` → **34 passed**. |
| **circuit** | **7** | disclosure ×4 + policy ×3 (unchanged) |
| **e2e** | **5 drivers** | `web_e2e` (payment + refusal), `disc_e2e` (disclosure), `deck_e2e` (5 attacks), `agent_e2e` (agent + jailbreak + backstop), **`account_e2e` (new — real admin freeze/unfreeze)** — all green, zero console errors. Suite: `scripts/run_e2e.sh`. |

## No mocks / fabricated values
Every value is a real on-chain read, a real proof, or a real tx hash. The governance txs are admin-signed and confirmed; the rejections are real FAILED txs with codes read from real simulations; the admin demonstrably cannot move funds (only proofs do, §C).

## STOP
P2 governance is complete and verified live; the app is re-pointed to the new account with the `/account` route live; the full suite is green against the new deployment. The **docs/writeup phase and mainnet are NOT started**, per instruction. Awaiting your go.
