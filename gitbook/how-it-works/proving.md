# Proving (client-side)

The proof is generated in the spender's browser. The cap, the salt, and the allowlist never leave the device — only the proof and its six public signals go on-chain.

## Where the secret lives

Your policy secret (cap, salt, allowlist and per-member Merkle paths) exists in exactly two places, both local:

- an **encrypted keystore** you download, and
- your browser's local storage (ciphertext).

**Encryption at rest:** the secret fields are sealed with **PBKDF2-SHA256 (250,000 iterations) → AES-256-GCM** under a passphrase you choose. The public fields (account, admin, commitment, root) stay readable; the decrypted copy lives only in `sessionStorage` and is gone when the tab closes. There is no passphrase escrow — like any real keystore, a lost passphrase is unrecoverable.

## No metadata leak

Encoding the allowlist is done entirely in-browser (`dest_field` is a pure hash of the address). Building the policy makes **zero network calls that carry allowlist addresses** — a curious RPC provider never sees your allowlist, including the entries you never pay.

## Generating a proof

For each payment the browser:

1. builds the Soroban authorization payload for this exact invocation — `sha256(xdr(HashIdPreimage::SorobanAuthorization{ networkId, nonce, signatureExpirationLedger, invocation }))` — and splits it into two 128-bit halves (`sigpayload_hi/lo`) so the proof is bound to this transaction;
2. runs `snarkjs` Groth16 `fullProve` on the policy circuit with the private witness;
3. serializes the proof to a `ProofSig` and attaches it as the account's authorization.

**Cost:** the one-time artifact download is ≈ 6.3 MB (zkey + witness wasm), cached thereafter. Proving takes **under a second** on a modern laptop (~865 ms measured, DEPTH-16). Memory footprint is modest enough for any current browser.

## Who submits

The spender's browser produces the proof; a **relayer / fee-payer** submits the transaction and pays the XLM fee. The fee-payer **cannot authorize a spend** — the proof does that, and it is bound to the specific transfer. This cleanly separates "who pays gas" from "who is allowed to move funds," and is what lets an agent or a user spend without ever holding a key that can drain the account.

Next: [Governance](governance.md) — how the account is administered without granting spend power.
