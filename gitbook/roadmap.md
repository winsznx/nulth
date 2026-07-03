# Roadmap

Nulth today is a working, testnet-live proof-authorized account with self-serve creation, governance, and auditor disclosure. What follows is honest phasing — what's shipped, what's next, and what's deliberately not built yet.

## Shipped (testnet)

- Proof-authorized account: ZK proof as the sole spend authorization, native BN254 Groth16 in `__check_auth`.
- Private policy: per-payment cap + DEPTH-16 allowlist (65,536 slots); client-side proving; encrypted keystore.
- Self-serve creation via a wallet (createContractV2 against shared wasm + verifier).
- Governance: admin rotate / freeze / unfreeze.
- Tier-1 auditor disclosure: prove `cap ≤ regulatory_max` without revealing the cap.
- Adversarial suite: every error code a tested negative control, live attacks as on-chain FAILED transactions.

## Next

- **Governance hardening** — multisig + timelock on `rotate_policy`/`freeze`; epoch-versioned rotation with a grace window so in-flight proofs settle across a policy change.
- **External audit → mainnet.** Mainnet is gated on review; the audit is the path.
- **Nulth SDK** — a clean library for wallets, agents, and payment apps to create accounts, build policies, prove, and submit.
- **Set-containment disclosure (Tier-2)** — prove the allowlist ⊆ an authority's screened set (sanctions / eligibility) without revealing either set.

## Products

- **Nulth Treasury** — the account and console for companies, funds, and stablecoin operators.
- **Nulth Agent Firewall** — spend-safe accounts and permissions for autonomous agents.
- **Confidential Tokens composition** — pin a Confidential Token as the asset: hidden amounts *and* hidden policy, provable to a regulator ([details](reference/nulth-and-confidential-tokens.md)).
- **RWA holder eligibility** — the private-allowlist machinery applied to *who may hold* a tokenized asset, keeping the eligibility set confidential.

## Not building (on purpose)

- Hiding payment amounts — that's the Confidential Tokens layer; Nulth composes with it rather than duplicating it.
- New policy types or screens ahead of an audit — depth in the core primitive over surface area.
