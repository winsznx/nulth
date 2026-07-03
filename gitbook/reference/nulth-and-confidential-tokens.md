# Nulth + Confidential Tokens

Stellar's **Confidential Tokens** and Nulth solve *different* privacy problems. They compose.

## The two layers

| Layer | What it hides | What stays visible |
|---|---|---|
| **Confidential Tokens** | balances + transfer **amounts** | sender / recipient addresses |
| **Nulth** | the **authorization policy** — caps, allowlists, rules | the payment (amount + destination) |

> **Confidential Tokens hide the amounts. Nulth hides the rules.**

A normal Nulth account hides *why* a payment was allowed but not *how much* moved. A Confidential Token hides *how much* moved but not the *rules* behind it. Put them together and you get both.

## What composition looks like

A Nulth account whose pinned asset is a Confidential Token would authorize spends the same way — a ZK proof that the payment obeys a hidden policy — while the amount itself is confidential. The result:

- **hidden amount** (Confidential Token),
- **hidden policy** — cap, allowlist (Nulth),
- **provable compliance** to an auditor (Nulth disclosure proofs),
- addresses public, as today.

That is the shape institutional settlement actually wants: confidential values, confidential controls, and selective, verifiable disclosure to a regulator.

## Status — honest

This is a **composition on the roadmap, not a shipped feature.** Nulth today pins canonical testnet USDC. Confidential Tokens are themselves a testnet developer preview. When both are mainnet-ready, pinning a Confidential Token is a configuration of the same primitive, not a redesign — Nulth's authorization model is asset-agnostic. See the [roadmap](../roadmap.md).
