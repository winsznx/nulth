# Redeploy runbook (new Nulth contract)

The contract changed in ways that alter the compiled WASM, so the on-chain deployment must be refreshed:

- crate renamed `covenant_account` → `nulth_account` (struct `NulthAccount`)
- **new 8-arg constructor**: `(vk, policy_commitment, allowlist_root, token, admin, epoch_ledgers: u32, epoch_cap: i128, rotation_delay_ledgers: u32)`
- rolling epoch spend budget + timelocked policy rotation + `amount > 0`

Because the WASM hash changes, the shared `accountWasmHash` and the demo `account` in
[`web/config.js`](../web/config.js) must be updated after redeploy. The BN254 `verifier` bytecode is
unchanged by the rename (struct/crate names are not embedded in the contract ABI), so it does **not**
require re-upload — but re-registering it under the new package name for stellar.expert is fine.

## Steps

```bash
# 0. verify locally first
cargo test --manifest-path contracts/Cargo.toml        # 42/42
cd circuits && npm test && cd ..                        # 7/7

# 1. build the optimized WASM + read its hash
stellar contract build                                 # workspace build
stellar contract optimize --wasm contracts/target/wasm32-unknown-unknown/release/nulth_account.wasm
sha256sum contracts/target/wasm32-unknown-unknown/release/nulth_account.optimized.wasm   # -> NEW accountWasmHash

# 2. upload the account WASM (records the wasm hash on-chain)
stellar contract upload \
  --wasm contracts/target/wasm32-unknown-unknown/release/nulth_account.optimized.wasm \
  --source <DEPLOYER> --network testnet

# 3. deploy a fresh DEMO account with the 8-arg constructor
#    (epoch_ledgers, epoch_cap, rotation_delay match web/config.js defaults)
stellar contract deploy --wasm-hash <NEW_HASH> --source <DEPLOYER> --network testnet -- \
  --vk <VK> --policy_commitment <COMMITMENT> --allowlist_root <ROOT> \
  --token <USDC_SAC> --admin <ADMIN> \
  --epoch_ledgers 17280 --epoch_cap <PER_PAYMENT_CAP*10> --rotation_delay_ledgers 12
#    (or: `SECRET=<deployer> node scripts/create_user.mjs`, which now passes all 8 args)

# 4. seed the new demo account with USDC + make one proof-authorized payment to confirm
#    (setup_p1.mjs / pay_p1.mjs / account_e2e.mjs)

# 5. update web/config.js: `accountWasmHash` (step 1), `account` (step 3),
#    and `verifier` only if re-uploaded. Remove the ⚠ REDEPLOY REQUIRED note.
```

## Post-deploy sanity

- `epoch_status()` on the new account returns the configured `(epoch_ledgers, epoch_cap)` and `spent = 0`.
- `propose_rotation` → `execute_rotation` before the delay fails `RotationLocked #22`; after the delay succeeds.
- Two payments summing past `epoch_cap` in one window: the second fails `EpochCapExceeded #20`.
- Frontend self-serve create still deploys (it now passes the 8-arg constructor from `web/lib/create.js`).
