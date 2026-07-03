# Governance: rotate & freeze

Nulth separates **spending** (a proof) from **governing** (the admin key). The admin can change the policy or halt the account — it can never move funds.

## The admin key

Set at construction, the admin is the account's governance root. It authorizes three actions, each gated by `admin.require_auth()` and each emitting an event for auditability:

- **`rotate_policy(new_commitment, new_root)`** — replace the committed policy.
- **`freeze()`** — halt all spending.
- **`unfreeze()`** — resume spending.

In practice the admin signs these as the transaction source, so `require_auth` is satisfied by the envelope signature. A non-admin attempt fails at the host boundary before any contract body runs.

## Freeze is an instant circuit-breaker

While frozen, `__check_auth` returns `AccountFrozen` (#17) **before** any binding or pairing work — every proof-authorized spend is rejected immediately. `unfreeze()` restores normal operation. This is the fast lever for a suspected compromise.

## Rotation invalidates in-flight proofs

After `rotate_policy`, the account's stored `policy_commitment`/`allowlist_root` change. Any proof built against the **old** policy now fails `BadPolicyBinding` (#4) — the policy-binding check no longer matches. A fresh proof for the **new** policy authorizes normally. Today this is a clean, immediate invalidation.

## What the admin cannot do

The admin **cannot spend in one step** — every spend still requires a valid proof for the *currently committed* policy, and the admin holds no policy secret. The honest caveat: an admin can `rotate_policy` to a policy it controls and then spend under it — two observable, event-emitting on-chain steps. So the admin is a full **governance trust root**, and single-admin control is the current trust assumption.

## Hardening (documented, not yet built)

- **Multisig + timelock** on `rotate_policy`/`freeze`, so no single key can silently re-point the policy.
- **Epoch-versioned rotation with a grace window**, so in-flight proofs can settle across a policy change instead of failing.

These are the roadmap items that turn single-admin governance into institution-grade control. See the repo's `SECURITY.md` for the full trust model.

Next: [Auditor disclosure](auditor-disclosure.md) — proving compliance without revealing the policy.
