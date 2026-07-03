# Policy & circuit

The policy is a per-payment **cap** and an **allowlist**. The circuit is what turns "this payment obeys the policy" into a statement that can be proven in zero knowledge and checked on-chain.

## Public commitments

Two values represent your policy on-chain, and only these two:

- **`policy_commitment = Poseidon(cap, salt)`** — a hiding commitment to the cap. The salt is random per account, so the commitment reveals nothing about the cap.
- **`allowlist_root`** — the root of a **DEPTH-16 Poseidon-Merkle tree** whose leaves are the allowlisted destinations. Depth 16 gives **65,536** slots; unused slots are a constant zero leaf, so a small allowlist is cheap to build and reveals only its root.

## Destination encoding

Every address is mapped to a field element the circuit can compare:

```
dest_field(addr) = U256( sha256( xdr(ScVal::Address(addr)) ) with the top byte zeroed )
```

This is computed identically on-chain (the account's `dest_field` view) and in the browser, so proofs verify. The browser computes it **locally** — encoding an allowlist never sends those addresses to any server. (See [Proving](proving.md).)

## The policy circuit

`policy.circom` (DEPTH-16, **9,402 constraints**) proves, for one payment:

| | Signals |
|---|---|
| **Public** | `amount`, `dest_field`, `policy_commitment`, `allowlist_root`, `sigpayload_hi`, `sigpayload_lo` |
| **Private** | `cap`, `salt`, Merkle `path[16]`, `index_bits[16]` |

It enforces:

1. **Cap** — `amount ≤ cap`.
2. **Commitment opening** — `Poseidon(cap, salt) == policy_commitment` (you can't swap in a different cap).
3. **Membership** — the Merkle path proves `dest_field` is a leaf under `allowlist_root`.
4. **Range** — `amount` fits the shared 2¹⁰⁰ bound the contract also checks.
5. **Transaction binding** — `sigpayload_hi/lo` are carried as public inputs so the proof is welded to one specific invocation.

An out-of-policy payment (over cap, or a non-allowlisted destination) makes the circuit **unsatisfiable** — witness generation aborts and **no proof can be produced**. This is why a compromised spender or a jailbroken agent cannot construct a draining transaction: there is nothing to submit.

## Trusted setup

Groth16 needs a per-circuit setup. Nulth uses the public **Hermez `powersOfTau` phase-1** ceremony plus a phase-2 contribution. The verification key has `nPublic = 6`, `IC.len = 7` — which is *why* the on-chain verify cost is constant regardless of allowlist depth (it depends only on the number of public inputs and the pairing, not the circuit size). Reproducibility and provenance are documented in [CIRCUIT_VERIFICATION](https://github.com/) in the repo; production hardening is a multi-party phase-2.

Next: [Proving](proving.md) — how the proof is generated without the secret ever leaving the device.
