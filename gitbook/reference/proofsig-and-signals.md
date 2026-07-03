# ProofSig, public signals & error codes

Developer reference for the authorization payload a Nulth account verifies.

## `ProofSig`

The account's `Signature` type:

```rust
ProofSig {
    a: BytesN<64>,    // Groth16 A (G1)
    b: BytesN<128>,   // Groth16 B (G2)
    c: BytesN<64>,    // Groth16 C (G1)
    pub_signals: Vec<U256>,  // the 6 public inputs
}
```

## BN254 serialization

- **G1** (`BytesN<64>`) = `be(x) ‖ be(y)` — two 32-byte big-endian field elements.
- **G2** (`BytesN<128>`) = `be(x.c1) ‖ be(x.c0) ‖ be(y.c1) ‖ be(y.c0)` — c1-first (EIP-197 order).
- **`a` is the raw `pi_a`** from snarkjs; the contract negates A itself before the pairing.

The reference serialization (snarkjs → Soroban) lives in `web/lib/serialize.js` and `scripts/lib.mjs`.

## Public signals (order matters)

`pub_signals` must be exactly six `U256`, in circuit declaration order:

| # | Signal | Meaning |
|---|---|---|
| 0 | `amount` | payment amount (stroops), must equal the `transfer` amount |
| 1 | `dest_field` | encoded destination, must equal `dest_field(to)` |
| 2 | `policy_commitment` | must equal the account's stored commitment |
| 3 | `allowlist_root` | must equal the account's stored root |
| 4 | `sigpayload_hi` | high 128 bits of this invocation's payload |
| 5 | `sigpayload_lo` | low 128 bits of this invocation's payload |

## Destination encoding

```
dest_field(addr) = U256( sha256( xdr(ScVal::Address(addr)) )  with byte[0] = 0 )
```

Top byte zeroed keeps it below the BN254 field modulus. Computed identically on-chain (`dest_field` view) and in-browser.

## Transaction binding

```
signature_payload = sha256( xdr( HashIdPreimage::SorobanAuthorization {
    networkId, nonce, signatureExpirationLedger, invocation
} ) )
sigpayload_hi = U256(bytes[0..16])   // big-endian
sigpayload_lo = U256(bytes[16..32])
```

Carrying both halves as public inputs welds the proof to one nonce + invocation — it cannot be lifted to another transaction or replayed.

## Error codes

The full `AccError` table and the exact `__check_auth` gate order are on [The account & `__check_auth`](../how-it-works/account-and-check-auth.md). Live, every code is a tested negative control with an on-chain FAILED-transaction receipt (repo `ADVERSARIAL_TESTING.md`).
