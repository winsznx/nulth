# Prove compliance to an auditor

A Nulth account can prove its spending policy stays within a limit — without revealing the policy. This is the auditor / correspondent-bank flow.

## The scenario

An auditor (or a correspondent bank, or a compliance desk) needs assurance that this treasury's per-payment cap stays within a regulatory limit — say, an AML transaction ceiling. They must **not** see the cap itself.

## Steps

1. Open **Auditor & Verify** in the app.
2. Set the **regulatory limit** the auditor requires.
3. **Prove** — your browser generates a disclosure proof that `cap ≤ regulatory_max`, bound to your account's on-chain `policy_commitment`.
4. The proof is verified **on-chain** against the shared BN254 verifier. The auditor sees a single verified bit: *within the limit* — and nothing about the cap.

## What the auditor learns (and doesn't)

- **Learns:** the account's real, committed cap is ≤ the stated limit — verifiably, because the proof opens the same `policy_commitment` that's stored on-chain.
- **Does not learn:** the cap value, the salt, or anything about the allowlist.

If the cap exceeds the limit, **no proof exists** — the account cannot falsely claim compliance.

## Trust note

The `regulatory_max` is supplied by the auditing side (e.g. published by an anchor or KYC provider) — an oracle-trust assumption, stated openly. See [Auditor disclosure](../how-it-works/auditor-disclosure.md) for the circuit and cost, and the [roadmap](../roadmap.md) for set-containment disclosures (proving your allowlist ⊆ an authority's screened set).
