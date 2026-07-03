// Copy this file to `secrets.local.js` (gitignored) and set a TESTNET secret.
//
// IMPORTANT: this key is ONLY the transaction fee-payer / submitter. It is NOT a
// spending key for the Covenant account — the account's sole spend authority is the
// ZK proof (no spending key exists on-chain). Demo-only; in production the submit
// path is a wallet / gasless relayer (PRD §14), not an embedded key.
//
// Without secrets.local.js the app runs READ-ONLY (live balances/policy still load;
// the Pay flow is disabled with an honest "operator key not configured" notice).
// `admin` is the DISCLOSED governance key (rotate the committed policy, freeze/unfreeze).
// It is NOT a spending key: it can never move funds — only a valid ZK proof for the
// committed policy authorizes a transfer. Without it, the /account screen is read-only.
window.COVENANT_SECRET = {
  feePayer: 'S...your-testnet-secret-seed...',
  admin: 'S...your-testnet-admin-seed...',
};
