# Security model

This is the product-level summary. The canonical, exhaustive threat model lives in the repository's `SECURITY.md`; this page is aligned with it.

## What Nulth protects

- **No key to steal.** The account has no Ed25519 spending key. Key theft — the most common failure mode of on-chain accounts — is not in the threat surface.
- **Rules stay private.** The cap, salt, and unexercised allowlist never touch the ledger. An adversary with the full mempool, the verification key, and all chain state cannot recover them.
- **Payments can't be forged, redirected, replayed, or lifted.** The proof is bound to the exact amount, destination, and invocation; every deviation maps to a distinct, tested rejection (see [The account & `__check_auth`](../how-it-works/account-and-check-auth.md)).

## What's public

Nulth **hides the rules, not the payments.** Amount and destination are public like any Stellar payment; so are the policy commitment, the allowlist root, and the proof. An observer learns the counterparties actually paid and a *lower bound* on the cap — nothing more.

## Trust boundaries (stated plainly)

- **Admin = governance trust root.** The admin can freeze the account or rotate the policy, each observable and event-emitting. It **cannot spend in one step** — but it can rotate to a policy it controls and then spend (two on-chain steps). Single-admin is the current assumption; **multisig + timelock** is the documented hardening ([Governance](../how-it-works/governance.md)).
- **Policy secret = bounded exposure.** Whoever proves holds the policy secret. If it leaks, an attacker can make *policy-compliant* payments only — allowlisted destinations, under cap. Loss is bounded to your policy, not unbounded; the admin can `freeze()` immediately.
- **Trusted setup.** Groth16 uses the public Hermez phase-1 ceremony + a phase-2 contribution. Production hardening is a multi-party phase-2 ([Circuit verification](../how-it-works/policy-and-circuit.md#trusted-setup)).
- **Disclosure oracle.** `regulatory_max` is supplied by the auditing party — an explicit oracle-trust assumption.

## Mainnet posture

Nulth is fully exercised on **testnet** with real proof-authorized USDC. **Mainnet is intentionally held until an external audit** — this is a new authorization surface, and shipping it to mainnet unaudited would contradict the caution the design is built on. This is a deliberate choice, not unfinished work.

## Adversarial evidence

Every reachable error is a tested negative control, and the live attacks land as **real FAILED transactions on-chain** with their precise error codes. See the repo's `ADVERSARIAL_TESTING.md` for the full matrix with transaction hashes, and the in-app **Exploitation Deck** to fire the attacks yourself.
