// Public configuration — live testnet addresses (PRD §3) and the DEPTH-16 artifacts.
// No secrets here. The operator fee-payer key lives in secrets.local.js (gitignored).
window.NULTH = {
  network: 'testnet',
  rpcUrl: 'https://soroban-testnet.stellar.org',
  networkPassphrase: 'Test SDF Network ; September 2015',
  // deployed, DEPTH-16 / P1 hardened / P2 governance (timelocked rotation + freeze + epoch budget)
  account:  'CAKSFFBTLDMHS4BH4ABTUVNN3WN5XO3WYIRD4ZNXELDXN5GGBNA77QQW',
  verifier: 'CCKBPVP7MZJOQYU44RK5MG4PA2YKV4UQ7CJMPK3OIHNFHLG5PEMNDREG',
  // DISCLOSED governance key: can rotate the committed policy and freeze/unfreeze the
  // account, but CANNOT move funds (only a valid ZK proof for the committed policy can).
  admin: 'GDSY6EO672YWIL5VPQJ2O4IIHFTXIMR763R7SMSMBRDQKNGTHNAJWVBU',
  usdcSac:    'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA',
  usdcIssuer: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
  // native XLM SAC (used by the wrong-token attack card) — testnet
  xlmSac:     'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC',
  // rolling epoch spend budget + rotation timelock — passed to the constructor when a
  // user deploys their own account. Caps CUMULATIVE spend per window (not just per payment)
  // and delays committed-policy rotation so a compromised admin cannot instantly redirect funds.
  epochLedgers: 17280,        // ~1 day window at ~5s/ledger
  epochCapMultiplier: 10,     // window budget = 10x the per-payment cap
  rotationDelayLedgers: 12,   // ~1 min rotation timelock (observable, demo-friendly)
  // shared, already-uploaded account wasm — new user accounts are created by createContractV2
  // against THIS hash (no re-upload) + the SHARED verifier above. (build/deployed_p2.json)
  accountWasmHash: 'a1dc3a6e6570d096fd60caffec7f7543bef6acce071a1cccbcc7c5f5aa90fd41',
  // the single allowlisted demo destination (its dest_field is the leaf in policy_secret.json)
  demoPayee: 'GBEOVHEZI2PS6OMLKZFULUXFSG5ZN3YAKUJE7UV3B7ACJVIXDA2UU4BS',
  // a real, valid testnet address that is NOT in the allowlist (for the out-of-policy demo)
  demoNonAllowlisted: 'GCES7J7AFTPOM7LRFI5FCE3PRWFCOU56IBPLQY7O2TM3YSTA3G2FLEJ3',
  explorer: 'https://stellar.expert/explorer/testnet',
  // published repo + docs — used by "Read the tech", the footer, and the every-screen Docs link
  repoUrl: 'https://github.com/winsznx/nulth',
  docsUrl: 'https://docs.nulth.xyz',
  // in-app testnet funding: real public friendbot (XLM for fees) + Circle faucet (testnet USDC) fallback
  friendbotUrl: 'https://friendbot.stellar.org',
  circleFaucetUrl: 'https://faucet.circle.com',
  // demo USDC the operator seeds into a freshly-created account so a stranger can pay immediately
  seedUsdc: '2',
  // headline numbers (PRD §3) — the ONLY cost figure anywhere is 8.537%
  costPct: '8.537',
  costInstr: '34,149,591',
  // Soroban per-transaction instruction ceiling (the denominator behind costPct)
  instrCeiling: 400000000,
  slots: '65,536',
  // contract test count — single source of truth (keep in step with `cargo test -p nulth-account`)
  tests: '42 / 42',
  // full honest test total (matches README/docs): 42 cargo + 7 circuit + 5 e2e drivers = 54
  testsTotal: '54',
  testsBreakdown: '42 cargo · 7 circuit · 5 e2e',
  // client-side prover artifacts (served locally; secrets never leave the browser)
  proverWasm: './prover/policy.wasm',
  proverZkey: './prover/policy_final.zkey',
  proverVk: './prover/verification_key.json',
  // Tier-1 auditor disclosure circuit (cap <= regulatory_max), verified on the same BN254 verifier
  discWasm: './prover/disclosure.wasm',
  discZkey: './prover/disclosure_final.zkey',
  discVk: './prover/disclosure_vk.json',
  policySecretUrl: './policy_secret.json',
  // a consistent (cap, wrong_salt) -> commitment' != stored, for the old-policy attack card
  attackWrongSalt: '11111111111111111111',
  attackWrongCommitment: '15122675254766484402923306987016161665897474158622330193899955986038406708140',
};
