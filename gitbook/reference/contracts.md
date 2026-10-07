# Deployed contracts

Nulth runs on **Stellar testnet (Protocol 26)**. Mainnet is intentionally held pending external review (see [Security model](../security/security-model.md)).

## Shared infrastructure

Everyone's accounts share one verifier and one account program — you don't redeploy them, you instantiate an account against them.

| Component | ID / hash |
|---|---|
| BN254 Groth16 **verifier** (shared) | `CCKBPVP7MZJOQYU44RK5MG4PA2YKV4UQ7CJMPK3OIHNFHLG5PEMNDREG` |
| Account **wasm hash** (shared) | `a1dc3a6e6570d096fd60caffec7f7543bef6acce071a1cccbcc7c5f5aa90fd41` |
| Payment asset — **USDC SAC** | `CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA` (canonical Circle testnet USDC) |
| Reference account (the hosted demo) | `CAKSFFBTLDMHS4BH4ABTUVNN3WN5XO3WYIRD4ZNXELDXN5GGBNA77QQW` |

## How a new account is created

Creating a Nulth account is a single `createContractV2` (a.k.a. `createCustomContract`) that instantiates the shared wasm with a constructor:

```
__constructor(vk, policy_commitment, allowlist_root, token, admin)
```

- `vk` — the shared verification key.
- `policy_commitment`, `allowlist_root` — *your* private policy's public commitments (computed in your browser).
- `token` — the USDC SAC above.
- `admin` — your wallet (governance).

The resulting contract ID is your account. The verifier is untouched; you're adding an account, not new infrastructure.

## Costs (decoded on-chain)

| | |
|---|---|
| Payment proof verify | **34,149,591 instr · 8.537%** of the 400M budget (constant, allowlist-independent) |
| Disclosure proof verify | ≈ **28.5M instr** |
| One-time prover artifacts (browser) | ≈ 6.3 MB (zkey + wasm), cached |

## Verify a claim yourself

Every ID above is live — open it on [stellar.expert](https://stellar.expert/explorer/testnet). The repo's `README.md` and `ADVERSARIAL_TESTING.md` link the specific proof-authorized payment and the on-chain FAILED attack transactions.
