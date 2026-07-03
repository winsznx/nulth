# Create & fund an account

This guide creates a Nulth account with your own private policy and funds it for spending. Testnet throughout.

## 1 · Connect the admin wallet

In the app, open **Create account** and **Connect Freighter** (on Testnet). This account becomes the **admin** — governance only, never a spending key. Use a wallet you control long-term; rotating the admin later is a governance action you'll want to keep.

## 2 · Choose the policy

- **Per-payment cap** — the maximum any single payment may be. Held privately; only its Poseidon commitment goes on-chain.
- **Allowlist** — the destinations this account may pay. Add as many as you need (up to 65,536). Only the Merkle root goes on-chain; the addresses stay in your browser.

Pick the allowlist deliberately — a destination that isn't in it can never receive a payment from this account, by construction.

## 3 · Deploy and save the keystore

**Create** triggers a Freighter-signed `createContractV2` that instantiates your account against the shared account wasm + verifier. When it settles you get:

- your **account address** (a `C…` contract ID), and
- an **encrypted keystore** download.

> The keystore is the **only copy** of your policy secret (cap, salt, allowlist paths). It's encrypted under your passphrase (AES-256-GCM). Store it safely and remember the passphrase — there is no recovery. See [Proving](../how-it-works/proving.md).

## 4 · Fund with testnet USDC

The dashboard shows your account address and live USDC balance. Send testnet USDC to it from any holder. The balance updates on-chain; you're ready to spend.

## Returning later

Reload the app and either pick your account from the switcher (it persists in local storage) or **import your keystore file** and unlock it with your passphrase. Then continue to [Send a payment](send-a-payment.md).
