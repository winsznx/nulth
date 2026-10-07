# Provenance & attribution

A candid record of where Nulth came from, what is new, and what is borrowed — so a reviewer never has
to guess. Nothing here is load-bearing for the cryptography; it exists for honesty.

## Naming history

Nulth was previously named **Covenant** during development. The rename to **Nulth** (nulth.xyz) is
cosmetic: the on-chain primitive, circuits, and threat model are unchanged by it. Some internal
working documents (gitignored, not shipped) still carry the old name — they are kept as the development
record, not scrubbed. The public repo, contracts, frontend, and docs use **Nulth** throughout.

The one deliberate exception is a **test-only nonce** and **localStorage migration keys**: the old
`covenant.accounts.v1` / `covenant.unlocked.v1` browser keys are still *read* (never written) by
`web/lib/create.js` so a returning user's pre-rename keystore is migrated forward rather than orphaned.

## What existed before vs. built here

An earlier exploration (**RouteDock**) surfaced the reviewer feedback that motivated Nulth:
*"impressive… useful smart account… more substantial tests on the contract."* Nulth is the response —
the smart account is the product, ZK is the sole authorization surface, and the adversarial test matrix
is the headline rather than an afterthought. Git history cannot by itself prove continuous in-window
authorship; this document plus the dated reports in `docs/reports/` are the honest record of what was
built and when.

## Borrowed / adapted components (attributed)

| Component | Source | How it's used |
|---|---|---|
| Groth16 verifier structure | `stellar/soroban-examples` `groth16_verifier` (BLS12-381) | Ported to native BN254 for `contracts/verifier` and inlined in the account's `__check_auth`. Credited in the source header. |
| Circuit gadgets (Poseidon, comparators, Num2Bits) | `circomlib` | Imported directly by `circuits/policy.circom` and `circuits/disclosure.circom`. |
| Phase-1 trusted setup | Hermez `powersOfTau28_hez_final_15.ptau` (public, multi-party) | Universal SRS for the Groth16 phase-2. |
| Phase-2 contribution | **single local contributor (this project)** | **Dev setup, not a production ceremony** — see `SECURITY.md §8` / `docs/CIRCUIT_VERIFICATION.md`. A production deployment requires a multi-party phase-2 or a transparent-setup system. |

## AI-assisted development

Development was AI-assisted across implementation, tests, and documentation. The cryptographic design,
circuits, and on-chain contracts are human-reviewed and verified with real `cargo test`, circuit tests,
and real on-chain transactions. The `/agent` demo uses an LLM only as an intent translator; the ZK proof
— not the model — is the authorization. See `AGENTS.md` for the full disclosure.
