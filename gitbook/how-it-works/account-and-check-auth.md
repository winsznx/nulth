# The account & `__check_auth`

A Nulth account is a Soroban contract implementing `CustomAccountInterface`. Its authorization entry point, `__check_auth`, is where a zero-knowledge proof replaces a signature.

## Construction

An account is created with its policy and governance fixed atomically at deploy — there is no uninitialized window to front-run:

```
__constructor(vk, policy_commitment, allowlist_root, token, admin)
```

- `vk` — the Groth16 verification key (its shape is checked: `ic.len == 7`, else `MalformedVk`).
- `policy_commitment`, `allowlist_root` — the public commitments to your private policy.
- `token` — the pinned asset (testnet USDC).
- `admin` — the governance key. `frozen` is initialized to `false`.

## The authorization signature

The "signature" the account verifies is a `ProofSig`:

```
ProofSig { a: BytesN<64>, b: BytesN<128>, c: BytesN<64>, pub_signals: Vec<U256> }
```

`a`/`b`/`c` are the Groth16 proof points (BN254; G1 as `be(x)‖be(y)`, G2 EIP-197 c1-first). `pub_signals` is the six public inputs, in circuit declaration order:

```
[ amount, dest_field, policy_commitment, allowlist_root, sigpayload_hi, sigpayload_lo ]
```

## The gate order

`__check_auth(signature_payload, sig, auth_contexts)` runs a fixed sequence of checks. Each maps to a distinct error code, and every one is a tested negative control (see [ADVERSARIAL_TESTING](https://github.com/) in the repo):

1. **Frozen?** if the account is frozen → `AccountFrozen` (#17) — rejected before any expensive work.
2. **Signal count** must be exactly 6 → else `BadSignalCount` (#8).
3. **Policy binding** — `pub_signals` commitment and root must equal the account's stored `policy_commitment` / `allowlist_root` → else `BadPolicyBinding` (#4). *(This is what makes a proof against a rotated-away policy fail.)*
4. **Transaction binding** — the proof's `sigpayload_hi/lo` must equal the two halves of *this* invocation's `signature_payload` → else `BadSigPayload` (#13). *(Non-transferable, non-replayable.)*
5. **Exactly one context** — empty → `NoContext` (#15); more than one → `TooManyContexts` (#16). *(No blanket or N-fold approvals.)*
6. **The context is the pinned transfer** — function must be `transfer` → else `BadContext` (#7); target contract must be the pinned `token` → else `BadTokenBinding` (#10).
7. **From is self** — `transfer.from` must be this account → else `BadFromBinding` (#11). *(No confused-deputy spends.)*
8. **Amount is sane** — `amount ≥ 0` → else `NegativeAmount` (#9); `amount < 2¹⁰⁰` → else `AmountTooLarge` (#12).
9. **Amount & destination match the proof** — `amount` equals the signal, and `dest_field(to)` equals the signal → else `BadAmountBinding` (#5) / `BadDestBinding` (#6). *(No redirect or amount swap after proving.)*
10. **The proof verifies** — native BN254 Groth16 pairing check → else `BadProof` (#3).

Only if all ten pass does the `token.transfer` execute.

## Error codes

| # | Code | Meaning |
|---|---|---|
| 1 | `NotInit` | storage missing (pre-construction) |
| 2 | `AlreadyInit` | reserved (host-enforced single-shot constructor) |
| 3 | `BadProof` | Groth16 pairing failed |
| 4 | `BadPolicyBinding` | commitment/root ≠ stored (e.g. rotated policy) |
| 5 | `BadAmountBinding` | transfer amount ≠ proven amount |
| 6 | `BadDestBinding` | destination ≠ proven destination |
| 7 | `BadContext` | not a single `transfer` context |
| 8 | `BadSignalCount` | `pub_signals` length ≠ 6 |
| 9 | `NegativeAmount` | amount < 0 |
| 10 | `BadTokenBinding` | wrong token contract |
| 11 | `BadFromBinding` | `from` ≠ this account |
| 12 | `AmountTooLarge` | amount ≥ 2¹⁰⁰ (shared circuit range) |
| 13 | `BadSigPayload` | proof not bound to this invocation |
| 14 | `MalformedVk` | verification key wrong shape |
| 15 | `NoContext` | empty authorization context |
| 16 | `TooManyContexts` | more than one context |
| 17 | `AccountFrozen` | admin has frozen the account |
| 18 | `Unauthorized` | reserved (non-admin governance is rejected at the host `require_auth` boundary) |

16 of the 18 codes are active; #2 and #18 are host-enforced and reserved.

Next: [Policy & circuit](policy-and-circuit.md) — what the proof actually attests to.
