#!/usr/bin/env bash
# Covenant end-to-end test suite — REAL testnet, no mocks.
# Prereqs: web/policy_secret.json + circuit artifacts present; web/secrets.local.js set
# (operator fee-payer); for the agent leg, the agent server must be running:
#   SECRET=$(stellar keys show agent-key) node scripts/agent_server.mjs &
set +e
cd "$(dirname "$0")/.."
export SECRET=$(stellar keys show agent-key 2>/dev/null)

echo "==================== CARGO (contract) ===================="
(cd contracts && cargo test -p covenant-account 2>&1 | grep -E "running [0-9]+ tests|test result:")

echo "==================== CIRCUITS (snarkjs) ===================="
node scripts/test_circuits.mjs 2>&1 | grep -E "PASS|FAIL|circuit tests:"

echo "==================== FRONTEND E2E (headless Chrome, real testnet) ===================="
# NOTE: these hit the public Soroban testnet RPC; run sequentially with a pause between legs
# so the shared endpoint does not rate-limit (rapid back-to-back batches return throttled errors).
PAUSE="${E2E_PAUSE:-15}"
echo "-- payment + out-of-policy refusal + wording --"
node scripts/web_e2e.mjs 2>&1 | grep -E "wording|phase:|console errors"
sleep "$PAUSE"
echo "-- Tier-1 disclosure (in-browser prove + on-chain verify) --"
node scripts/disc_e2e.mjs 2>&1 | grep -E "phase:|console errors"
sleep "$PAUSE"
echo "-- exploitation deck (5 real attacks) --"
node scripts/deck_e2e.mjs 2>&1 | grep -E '"code"|console errors'
sleep "$PAUSE"
echo "-- agent desk (needs agent server on :8799) --"
if curl -s http://localhost:8799/health >/dev/null 2>&1; then
  node scripts/agent_e2e.mjs 2>&1 | grep -E "done:|refusal|console errors"
else
  echo "   SKIPPED — agent server not running (start it, see header)"
fi
sleep "$PAUSE"
echo "-- /account governance (real admin-signed freeze -> unfreeze) --"
node scripts/account_e2e.mjs 2>&1 | grep -E '"action"|frozenNow|console errors'
echo "==================== DONE ===================="
