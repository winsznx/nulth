# FAQ

**Is it live?**
Yes — on Stellar testnet (Protocol 26), with real proof-authorized USDC payments and self-serve account creation. Mainnet is intentionally held until an external audit.

**Does Nulth hide my payments?**
No. Amount and destination are public, like any Stellar payment. Nulth hides the *rules* that authorize the payment — the cap and the allowlist. If you need hidden amounts too, that's the Confidential Tokens layer, which Nulth [composes with](reference/nulth-and-confidential-tokens.md).

**What happens if my policy secret leaks?**
Loss is bounded to your policy: an attacker could make payments only to your **allowlisted** destinations, only **under your cap** — never to an arbitrary address, and never an unbounded drain. The admin can `freeze()` the account immediately.

**Can the admin steal the funds?**
Not in one step — the admin holds no policy secret and every spend needs a valid proof. The honest caveat: an admin can rotate the committed policy to one it controls and then spend, in two observable on-chain steps. That makes the admin a governance trust root; multisig + timelock is the documented hardening. See [Governance](how-it-works/governance.md).

**How is this different from a multisig or passkey smart wallet?**
Those still authorize with signatures over public rules (thresholds, keys). Nulth's authorizer is a ZK proof, and the rules it enforces are never published. Same `__check_auth` slot; fundamentally different authority.

**How is it different from a privacy pool?**
Privacy pools hide amounts and keep rules public. Nulth is the inverse: amounts public, rules private. It's an authorization-layer primitive, not a mixing pool.

**What does verification cost?**
A payment proof verifies in 34,149,591 instructions — **8.537%** of a Stellar transaction's compute budget — and that cost is **constant** regardless of allowlist size (it depends only on the six public inputs and the pairing). Total transaction cost varies slightly with Soroban storage (e.g. a first-time receive is a touch higher), like any Stellar transaction.

**Which assets does it support?**
Today, canonical testnet USDC (pinned per account). The authorization model is asset-agnostic; a Confidential Token is a future configuration, not a redesign.

**Do I need a wallet to try it?**
To *create* an account, yes — Freighter (testnet); the connecting wallet becomes your governance admin. Payments are authorized by the proof and relayed by a fee-payer, so spending doesn't require the wallet to sign each transfer.

**Was this built with AI?**
Yes, and it's disclosed openly in the repo's `AGENTS.md`. Every claim is backed by an on-chain transaction, a measured number, or a human-verified run — the evidence is the point, not the tooling.

**Where's the code / the deep docs?**
The repository holds the architecture, security model, circuit verification, and the adversarial matrix with transaction hashes. This GitBook is the product/developer guide; the repo is the reviewer's evidence trail.
