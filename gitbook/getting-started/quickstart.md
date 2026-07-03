# Quickstart

Create your own proof-authorized account and make a payment that only a zero-knowledge proof can authorize. Everything here runs on **Stellar testnet** — no real funds at risk.

## Before you start

- **Freighter** browser extension, switched to **Testnet**. The wallet you connect becomes your account's **admin** (governance) — it is never turned into a spending key.
- A couple of minutes.

## 1 · Open the app

Go to [nulth.xyz](https://nulth.xyz) and launch the demo. In the left sidebar, choose **Create account**.

## 2 · Connect your wallet

Click **Connect Freighter** and approve the connection. The connecting account becomes the **admin** of the account you're about to create: it can later rotate the policy or freeze the account, but it can **never** move funds.

## 3 · Define your policy — it stays in your browser

Set:

- a **per-payment cap** (for example, 50 USDC), and
- an **allowlist** of one or more destination addresses.

When you deploy, your browser generates a random **salt** and computes the **Poseidon commitment** `Poseidon(cap, salt)` and the **DEPTH-16 Merkle root** over your allowlist — entirely locally. The cap, the salt, and the allowlist entries **never leave your device**; only the commitment and the root are written on-chain.

## 4 · Deploy

Click **Create**. Freighter asks you to sign the deploy transaction. Under the hood this instantiates *your own* account via `createContractV2` against Nulth's **shared account wasm** and **shared BN254 verifier** — you are not redeploying the verifier, you are creating an account whose stored policy is *your* commitment and root, with *your* wallet as admin.

A **keystore** downloads and is saved (encrypted with a passphrase) in your browser. It is the only copy of your policy secret — keep it somewhere safe. See [Proving](../how-it-works/proving.md) for how the keystore is protected.

## 5 · Fund it

Send **testnet USDC** to your new account address (the dashboard shows the address and its live balance). Any account holding testnet USDC can fund it.

## 6 · Make a proof-authorized payment

Open **Send payment**, choose an **allowlisted destination** and an amount **within your cap**, then **Generate proof & pay**. Your browser builds a Groth16 proof in about a second — that proof *is* the signature on the `token.transfer`. Watch the payment settle on-chain, with the transaction hash linked to the explorer.

## 7 · Try to break it

Change the destination to one that is **not** in your allowlist and pay again. The prover cannot build a proof — the circuit is unsatisfiable for an out-of-policy payment — so **no transaction is ever formed**. That is the core guarantee: an account that cannot be drained outside the rules it committed to.

## Where to next

- **[Core concepts](concepts.md)** — the mental model behind what you just did.
- **[Give an AI agent a spend-safe account](../guides/agent-spending-account.md)** — the same guarantee, applied to autonomous agents.
- **[Security model](../security/security-model.md)** — exactly what is and isn't private, and the trust boundaries.
