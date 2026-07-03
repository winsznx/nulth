# Auditor disclosure

The same machinery that hides a policy can also **prove properties about it** to a third party — without revealing it. This is how a Nulth account satisfies an auditor.

## Prove `cap ≤ regulatory_max`

A correspondent bank or compliance desk needs to know a treasury's spending policy stays within an AML/transaction limit — but has no right to see the limit itself. Nulth's disclosure circuit proves exactly that:

| | Signals |
|---|---|
| **Public** | `policy_commitment`, `regulatory_max` |
| **Private** | `cap`, `salt` |

It enforces:

1. **Commitment opening** — `Poseidon(cap, salt) == policy_commitment`, so the proof is about *this account's real cap*, not an arbitrary number; and
2. **Bound** — `cap ≤ regulatory_max`.

The auditor learns a single bit — *the cap is within the limit* — and nothing more. If the cap exceeds the limit, no proof can be produced.

## Verified on the same verifier

The disclosure proof is checked by the **same shared BN254 Groth16 verifier** the account uses, at ≈ **28.5M instructions** (~7% of the transaction budget). Nothing new is deployed to disclose.

## Trust note

`regulatory_max` is supplied by the auditing party (for example, published by a Stellar anchor or KYC provider) — an oracle-trust assumption, stated plainly. The proof binds to the account's on-chain `policy_commitment`, so the auditor knows it is verifying *this* treasury's committed cap, not a value the operator invented for the occasion.

## Beyond Tier-1

The shipped disclosure is the cap bound. The natural extension is **set-containment** — proving the account's allowlist is a subset of an authority's screened set (sanctions / eligibility) without revealing either set. That is a harder circuit and is on the roadmap; the cap disclosure works today.

Next: guides — [create & fund an account](../guides/create-and-fund.md), or the [security model](../security/security-model.md).
