# Core concepts

Five ideas explain all of Nulth.

## 1 · The account has no spending key

A Nulth account is a Soroban smart account (it implements `CustomAccountInterface`). Its `__check_auth` entry point accepts exactly one form of authorization: a valid **Groth16 zero-knowledge proof**. There is no Ed25519 key that can move funds — so there is nothing to phish, extract, or leak.

## 2 · The policy is private, its commitment is public

Your **policy** is a per-payment **cap** and an **allowlist** of destinations. It is reduced to two values that live on-chain:

- `policy_commitment = Poseidon(cap, salt)` — a commitment to the cap, revealing nothing about it.
- `allowlist_root` — the root of a DEPTH-16 Poseidon-Merkle tree over the allowlist (up to 65,536 entries).

The cap value, the salt, and every allowlist entry stay off-chain. See [Policy & circuit](../how-it-works/policy-and-circuit.md).

## 3 · The proof is the signature

To spend, the spender proves — in zero knowledge — that the payment obeys the committed policy:

> the amount is ≤ the committed cap, the destination is a member of the committed allowlist, and this proof is bound to *this* transaction (so it can't be lifted or replayed).

The proof is verified natively (BN254 Groth16) inside `__check_auth`. Verify → the transfer executes. Fail → nothing moves. The proof plays the role a signature plays on a normal account. See [The account & `__check_auth`](../how-it-works/account-and-check-auth.md).

## 4 · What's public vs. private

| Public (on-chain, like any Stellar payment) | Private (never leaves the device) |
|---|---|
| payment amount + destination | the cap value |
| `policy_commitment`, `allowlist_root` | the salt |
| the proof + its 6 public signals | every *unexercised* allowlist member |

**Nulth hides the rules, not the payments.** An observer with the full mempool, the verification key, and all chain state learns only the counterparties actually paid and a lower bound on the cap — never the cap itself or who else could have been paid.

## 5 · Four roles

- **Spender** — holds the policy secret and generates proofs. Can be a person, a service, or an AI agent.
- **Admin** — the governance key. Can **rotate** the committed policy or **freeze** the account. **Cannot authorize a payment.** See [Governance](../how-it-works/governance.md).
- **Auditor** — receives selective-disclosure proofs (e.g. *cap ≤ regulatory limit*) without ever seeing the policy. See [Auditor disclosure](../how-it-works/auditor-disclosure.md).
- **Relayer / fee-payer** — submits the transaction and pays the XLM fee. **Cannot authorize a spend** — the proof does that.

## Why it can't be drained

- A **stolen admin key** can freeze or rotate the policy — governance actions, observable and event-emitting — but cannot spend in a single step.
- A **compromised policy secret** can only spend *within* the policy it commits to: allowlisted destinations, under the cap.
- A **jailbroken agent** cannot fabricate a proof for an out-of-policy payment. The circuit is unsatisfiable, so the proof — and therefore the transaction — never exists.
