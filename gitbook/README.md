---
description: A Stellar account whose signature is a zero-knowledge proof. Private controls for public money.
---

# Overview

**Nulth is a proof-authorized account for Stellar.** It has no spending key. Money moves only when it proves, in zero knowledge, that the payment obeys a policy the chain has never seen — a spend cap and an allowlist that are enforced on-chain but never published.

> **Private controls for public money.**

## The one-glance version

On a normal account, a private key is the authority: sign, and funds move. Keys get phished, extracted, and drained — and if you *do* put spending rules on-chain (multisig thresholds, allowlists, limits), you broadcast your entire control structure to the world as public bytes.

Nulth removes both problems at once. The account's authorizer is a **Groth16 zero-knowledge proof**, verified natively in Soroban's `__check_auth`. There is no Ed25519 spending key to steal. And the policy the proof attests to — the cap, the allowlist — never touches the ledger; only a single Poseidon commitment and one Merkle root do. The chain enforces rules it cannot read.

```
Normal account      key  ─────────────▶  funds move        (steal the key → drain)
Nulth account       ZK proof of policy ─▶ funds move        (no key exists; proof is the signature)
```

## What makes Nulth different

- **Keyless.** The account holds no Ed25519 spending key. There is nothing to phish, extract, or leak. The admin key is *governance* (rotate the policy, freeze the account) — it cannot authorize a payment.
- **Hidden policy.** The spend cap and the (up to 65,536-entry) allowlist are committed but never published. An observer with the full mempool, the verification key, and all chain state still cannot recover the cap or any unexercised allowlist member.
- **Proof-as-signature.** The ZK proof lives in the authorization layer (`__check_auth`), not in a shielded pool bolted onto payments. This is the distinction: the proof *is* the account's signature.

**Nulth hides the rules, not the payments.** The amount and destination of every transfer are public, exactly like any Stellar payment. What stays private is the *policy* that authorized it.

## Where Nulth sits in Stellar's privacy stack

Nulth composes with the rest of the stack rather than competing with it:

| Layer | What it hides |
|---|---|
| Confidential Tokens | balances + transfer amounts |
| Privacy pools | parties + amounts inside a pool |
| **Nulth** | **the authorization policy — caps, allowlists, rules, permissions** |

> **Confidential Tokens hide the amounts. Nulth hides the rules.** A Nulth account spending a Confidential Token gets hidden amounts *and* a hidden policy — provable to an auditor, published to no one.

## Who it's for

- **Treasuries & stablecoin operators** — enforce spend caps and vendor allowlists on-chain without publishing your vendor network or limits to competitors.
- **AI-native payments** — hand an autonomous agent an account it can spend from but *cannot drain*, even if the agent is fully prompt-injected: it cannot construct a proof for a payment outside policy.
- **Compliance & RWA** — prove to an auditor that every payment stayed within a regulatory limit (`cap ≤ regulatory_max`) without revealing the cap; the same allowlist machinery can gate who is eligible to hold a tokenized asset, privately.

## Under the hood

- **Stellar Protocol 26**, Soroban smart account implementing `CustomAccountInterface`.
- **Native BN254 Groth16** verification inside `__check_auth`.
- **DEPTH-16 Poseidon-Merkle allowlist** — up to **65,536** private entries.
- **Constant verify cost: 8.537%** of a Stellar transaction's compute budget (34,149,591 instructions), independent of allowlist size.
- **In-browser proving** — the cap, salt, and allowlist never leave the device; the proof is generated client-side in under a second.

## Live status

Nulth runs today on **Stellar testnet** with real, proof-authorized USDC payments — anyone can create their own account, fund it, and spend under a private policy. Mainnet deployment is **intentionally held until external review**: this is a new authorization surface, so it waits on an audit. That's mature caution, not missing work.

## Start here

- **[Quickstart](getting-started/quickstart.md)** — create an account and make your first proof-authorized payment.
- **[Core concepts](getting-started/concepts.md)** — the mental model: proof-as-signature, hidden policy, the roles.
- **[How Nulth works](how-it-works/account-and-check-auth.md)** — the account, the circuit, proving, governance, disclosure.
- **[Security model](security/security-model.md)** — threat model, trust boundaries, and what is and isn't private.
