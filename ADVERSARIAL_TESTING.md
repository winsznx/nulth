# How We Break Nulth (So You Don't Have To)

Nulth's security story is a tested adversarial matrix, not a threat narrative. Every **active** `AccError` is an independently reachable state with a distinct error code and a cargo test that forces it — and for the **seven** attacks worth demonstrating live, a testnet transaction hash showing the chain rejected it. (The enum also declares two **reserved** codes that are never returned — `AlreadyInit` #2 and `Unauthorized` #18; see below.)

The premise: an attacker has full access to your proof, your circuit, your public signals, your verification key, and your mempool. They have network-level timing. They have a cloned copy of snarkjs. What they cannot do is forge a valid witness for a policy they do not hold, or redirect your spend to an address not in your allowlist.

---

## Error code reference

| Code | Name | What triggers it |
|------|------|-----------------|
| #1 | `NotInit` | Contract called before `init()` |
| #2 | `AlreadyInit` | **reserved** — constructor is host-enforced single-shot; never returned |
| #3 | `BadProof` | Groth16 pairing check fails |
| #4 | `BadPolicyBinding` | `pub_signals[2,3]` ≠ stored `(commitment, root)` |
| #5 | `BadAmountBinding` | `pub_signals[0]` ≠ `ctx.args.amount` |
| #6 | `BadDestBinding` | `pub_signals[1]` ≠ `ctx.args.dest` |
| #7 | `BadContext` | Context function name ≠ `"transfer"` |
| #8 | `BadSignalCount` | `pub_signals.len()` ≠ 6 |
| #9 | `NegativeAmount` | `amount < 0` |
| #10 | `BadTokenBinding` | Context contract ≠ pinned USDC token |
| #11 | `BadFromBinding` | `ctx.args.from` ≠ account address |
| #12 | `AmountTooLarge` | `amount ≥ 2¹⁰⁰` |
| #13 | `BadSigPayload` | `pub_signals[4,5]` ≠ live `signature_payload` hi/lo |
| #14 | `MalformedVk` | `vk.ic.len()` ≠ 7 at construction |
| #15 | `NoContext` | `auth_contexts` is empty |
| #16 | `TooManyContexts` | `auth_contexts.len()` > 1 |
| #17 | `AccountFrozen` | `frozen == true` at entry |
| #18 | `Unauthorized` | **reserved** — non-admin governance calls are rejected by the host (`admin.require_auth()`) before any body runs; never returned as a contract code |

---

## Adversarial test matrix

### Attack 1 — Proof Malleability (Groth16 A/C swap)
*An attacker who intercepts your proof tries to flip the A and C components. Groth16 is not malleable in the algebraic sense, but an attacker may attempt structural manipulation hoping the verifier is lenient.*

| | |
|--|--|
| **Test** | `test_bad_proof_swapped_ac` |
| **Mechanism** | Swap `proof.a` and `proof.c` before submission |
| **Expected** | `BadProof` #3 |
| **On-chain evidence** | [FAILED · `6d40f77b9f3480f0e4af829efb2922308368eb64300996efc2d509eecc52aec3`](https://stellar.expert/explorer/testnet/tx/6d40f77b9f3480f0e4af829efb2922308368eb64300996efc2d509eecc52aec3) |

### Attack 2 — Stale Policy Binding
*The admin rotates the policy commitment. An attacker replays a proof that was valid against the old policy, hoping the binding check uses cached state.*

| | |
|--|--|
| **Test** | `test_old_policy_binding` |
| **Mechanism** | Generate proof against `commitment_v1`, rotate policy to `commitment_v2`, submit old proof |
| **Expected** | `BadPolicyBinding` #4 |
| **On-chain evidence** | [FAILED · `fc9b3e4304dc54751d192b446967f3180d48eadf26e3481deee66745ba0b1ac5`](https://stellar.expert/explorer/testnet/tx/fc9b3e4304dc54751d192b446967f3180d48eadf26e3481deee66745ba0b1ac5) |

### Attack 3 — Redirected Destination (Nonce Lift)
*An attacker lifts your proof from the mempool and tries to replay it in a different transaction that redirects the payment to their address.*

| | |
|--|--|
| **Test** | `test_sigpayload_binding` |
| **Mechanism** | Copy valid proof, submit from a transaction with a different nonce/expiration |
| **Expected** | `BadSigPayload` #13 |
| **On-chain evidence** | [FAILED · `bd424c94c879b5a7d4a3a173395b72a45481f355520341fe5d4926a84af27597`](https://stellar.expert/explorer/testnet/tx/bd424c94c879b5a7d4a3a173395b72a45481f355520341fe5d4926a84af27597) |

### Attack 4 — Wrong Token (XLM SAC substitution)
*An attacker substitutes the token in the invocation context, trying to drain XLM from the account instead of USDC.*

| | |
|--|--|
| **Test** | `test_token_binding` |
| **Mechanism** | Submit valid USDC proof with `ctx.contract = XLM_SAC` |
| **Expected** | `BadTokenBinding` #10 |
| **On-chain evidence** | [FAILED · `84ba7fbca8319d12f8b88e13f79a85283912227cbe5dcc4294ae414c2284ddba`](https://stellar.expert/explorer/testnet/tx/84ba7fbca8319d12f8b88e13f79a85283912227cbe5dcc4294ae414c2284ddba) |

### Attack 5 — Frozen Account Spend
*An admin freeze is in effect. An attacker (or the account owner) submits a valid proof anyway.*

| | |
|--|--|
| **Test** | `test_freeze_blocks_valid_proof` |
| **Mechanism** | Freeze account, submit otherwise-valid proof |
| **Expected** | `AccountFrozen` #17 |
| **On-chain evidence** | [FAILED · `071294a4d7d05437ef75b38be94bfb95c5d20a79ef02ecdc2bd63b543eded3e3`](https://stellar.expert/explorer/testnet/tx/071294a4d7d05437ef75b38be94bfb95c5d20a79ef02ecdc2bd63b543eded3e3) |

### Attack 6 — Unauthorized Governance (non-admin rotate)
*A non-admin account attempts to rotate the policy commitment to one it controls.*

| | |
|--|--|
| **Test** | `test_non_admin_rotate_rejected` (`#[should_panic]` on the unsatisfied `require_auth`) |
| **Mechanism** | Call `rotate_policy()` from a non-admin key |
| **Expected** | Host-level `Error(Auth, …)` — `admin.require_auth()` is unsatisfied **before any contract body runs**; the contract code `Unauthorized` #18 is **reserved** and never returned |
| **On-chain evidence** | [FAILED · `308d140c3c0e1dad80ae7c7d46eed8a4c2bdbb3a75e5f21d20e73a5f97434c75`](https://stellar.expert/explorer/testnet/tx/308d140c3c0e1dad80ae7c7d46eed8a4c2bdbb3a75e5f21d20e73a5f97434c75) |

### Attack 7 — Blanket Approval via Multi-Context
*A crafted authorization attempts to authorize multiple operations in one call, hoping `__check_auth` will match any of them.*

| | |
|--|--|
| **Tests** | `test_two_contexts_rejected`, `test_three_contexts_rejected` |
| **Mechanism** | Submit `auth_contexts` with 2 or 3 entries |
| **Expected** | `TooManyContexts` #16 |
| **Status** | ✅ cargo tests pass |

### Attack 8 — Function Name Substitution (burn)
*An attacker calls `burn()` on the USDC SAC through the account, hoping `__check_auth` only checks the token, not the function.*

| | |
|--|--|
| **Tests** | `test_bad_context_wrong_fn_name`, `test_bad_context_burn_fn` |
| **Mechanism** | Craft context with `fn_name = "burn"` |
| **Expected** | `BadContext` #7 |
| **Status** | ✅ cargo tests pass |

### Attack 9 — Amount Override
*An attacker copies a valid proof for amount X but submits a transaction for amount X+1.*

| | |
|--|--|
| **Tests** | `test_amount_binding`, `test_amount_binding_plus_one` |
| **Mechanism** | Valid proof for 100 USDC, transaction says 101 |
| **Expected** | `BadAmountBinding` #5 |
| **Status** | ✅ cargo tests pass |

### Attack 10 — Destination Override
*An attacker has a valid proof for destination A but changes the transaction destination to B.*

| | |
|--|--|
| **Tests** | `test_dest_binding`, `test_dest_binding_second` |
| **Mechanism** | Valid proof for `dest=A`, transaction says `dest=B` |
| **Expected** | `BadDestBinding` #6 |
| **Status** | ✅ cargo tests pass |

### Attack 11 — Replay (Same Nonce)
*An attacker tries to replay a settled transaction by resubmitting the same signed XDR.*

| | |
|--|--|
| **Mechanism** | Resubmit identical transaction |
| **Expected** | Host-level `ExistingValue` rejection (nonce already consumed) |
| **Evidence** | Sim evidence in [REPORT_P1.md](./REPORT_P1.md) |
| **Why it works** | Soroban's `signature_payload` encodes nonce + expiration; each submission burns its nonce |

### Attack 12 — Rogue Agent Jailbreak (live demo)
*An AI agent operating within Nulth's policy is injected with a prompt to drain funds to an attacker's address. The agent attempts to generate a proof for the attacker's address, which is not in the allowlist Merkle tree.*

| | |
|--|--|
| **Mechanism** | Agent attempts `fullProve({ dest: ATTACKER_ADDRESS, path: fabricated_path })` |
| **What happens** | Witness generation fails: `Non-quadratic constraint` or `Assert failed` — the Merkle path does not open the correct root |
| **On-chain** | Backstop tx [FAILED · `19e4bd88…`](https://stellar.expert/explorer/testnet/tx/19e4bd88) |
| **Result** | Two-layer rejection: circuit rejects before chain, chain rejects if circuit somehow runs |

---

## Circuit properties (what the proof actually guarantees)

For any proof that passes `__check_auth`:

1. **Policy binding** — `Poseidon(cap, salt) = policy_commitment` — the prover knows the cap and salt that commit to the on-chain value.
2. **Spend cap** — `amount ≤ cap` — enforced in-circuit with 100-bit range checks on both operands.
3. **Allowlist membership** — `Poseidon-Merkle(dest, path, pathIndices) = allowlist_root` — the destination is in the allowlist tree committed on-chain.
4. **Transaction binding** — `pub_signals[4,5] = Poseidon(sigpayload_hi, sigpayload_lo)` — the proof is bound to the exact nonce, expiration, and invocation of this transaction.

The prover cannot forge any of these without a valid witness. The witness requires knowing `cap`, `salt`, `path[]`, and `pathIndices[]` — none of which appear on-chain.

---

## What Nulth does NOT guarantee

- **Cumulative budget across transactions** — each proof is checked independently. Spending exactly `cap` per payment is possible. Concurrent enforcement across payments requires ordering guarantees this version deliberately avoids.
- **Admin key confidentiality** — the admin can rotate the policy commitment in two observable on-chain steps, allowing a compromised admin to eventually redirect funds. Hardening path: multisig + timelock.
- **Prover privacy for exercised destinations** — observers learn the counterparties actually paid. Only unexercised allowlist members are private.

Full adversary table: [SECURITY.md](./SECURITY.md).
