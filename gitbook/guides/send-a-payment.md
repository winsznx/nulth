# Send a proof-authorized payment

A payment from a Nulth account is authorized by a proof, not a signature. Here's the flow and what happens underneath.

## Steps

1. Open **Send payment**.
2. Choose a **destination** — one of your allowlisted addresses — and an **amount** at or below your cap.
3. Click **Generate proof & pay**.

The app reads the destination's `dest_field`, builds the transaction's authorization payload, and generates a Groth16 proof in your browser (~1s). The proof becomes the account's authorization on a `token.transfer`; a fee-payer relays the transaction and pays the XLM fee. When it settles you'll see the transaction hash, the balance change, and the decoded verify cost.

## What actually authorized it

The proof attests — in zero knowledge — that the amount is within your committed cap and the destination is in your committed allowlist, and it is bound to this exact transfer so it can't be lifted or replayed. `__check_auth` runs its full gate order (see [The account & `__check_auth`](../how-it-works/account-and-check-auth.md)) and only then executes the transfer.

## The refusal

Try paying a destination that isn't in your allowlist, or an amount over your cap. The circuit is unsatisfiable, so the prover **cannot produce a proof** — the app reports the refusal and **no transaction is formed**. Nothing hits the chain; there is no failed transfer to clean up, because there was never a valid authorization to submit.

This is the difference between "a payment that gets rejected" and "a payment that cannot be constructed." Nulth is the latter.

## Notes

- **Amount + destination are public** on-chain, like any Stellar payment. The cap and the rest of your allowlist stay private.
- The fee-payer can pay gas but cannot authorize a spend — see [Proving](../how-it-works/proving.md#who-submits).
