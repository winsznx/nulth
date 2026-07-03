// P2 governance — REAL on-chain proof sequence against the deployed governance account.
// Emits real txs/codes (no mocks). Leaves the account UNFROZEN + on its REAL policy.
//
//   non-admin freeze -> rejected (require_auth(admin) unsatisfiable)
//   admin freeze     -> SUCCESS; a proof-authorized spend now fails AccountFrozen (#17)
//   admin unfreeze   -> SUCCESS
//   rotate -> BOGUS  -> SUCCESS; the old proof now fails BadPolicyBinding (#4)
//   rotate -> REAL   -> SUCCESS; a fresh proof for the (re-)committed policy SUCCEEDS (real USDC)
//
// Rejections are landed as real FAILED txs via submit-past-sim with a footprint borrowed while
// the account is healthy (require_auth failures fail simulation, so we cannot assemble normally).
// Env: SECRET=<operator/fee-payer seed>  ADMIN_SECRET=<governance admin seed>
import * as SDK from '@stellar/stellar-sdk';
import fs from 'fs';
import { createRequire } from 'module';
import { proofSigScVal, sorobanAuthPayload, payloadHalves, u256ScVal } from './lib.mjs';
const require = createRequire(import.meta.url);
const snarkjs = require('/Users/mac/covenant/circuits/node_modules/snarkjs');

const B = '/Users/mac/covenant';
const RPC = new SDK.rpc.Server('https://soroban-testnet.stellar.org');
const PASS = SDK.Networks.TESTNET;
const D = JSON.parse(fs.readFileSync(`${B}/build/deployed_p2.json`));
const ACC = D.account_id, USDC = D.usdc_sac;
const PAYEE = 'GBEOVHEZI2PS6OMLKZFULUXFSG5ZN3YAKUJE7UV3B7ACJVIXDA2UU4BS';
const secret = JSON.parse(fs.readFileSync(`${B}/build/policy_secret.json`));
const WASM = `${B}/circuits/build/policy_js/policy.wasm`, ZKEY = `${B}/circuits/build/policy_final.zkey`;
const BOGUS_C = '9', BOGUS_R = '9';
const AMT = 10000000n; // 1.0 USDC

if (!process.env.SECRET || !process.env.ADMIN_SECRET) { console.error('SECRET and ADMIN_SECRET env required'); process.exit(1); }
const op = SDK.Keypair.fromSecret(process.env.SECRET);
const admin = SDK.Keypair.fromSecret(process.env.ADMIN_SECRET);

const addr = (a) => SDK.nativeToScVal(a, { type: 'address' });
const xfer = (to, auth) => { const o = { contract: USDC, function: 'transfer', args: [addr(ACC), addr(to), SDK.nativeToScVal(AMT, { type: 'i128' })] }; if (auth) o.auth = auth; return SDK.Operation.invokeContractFunction(o); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const codeFrom = (s) => { const m = String(s).match(/Error\(Contract, #(\d+)\)/); return m ? Number(m[1]) : null; };
async function settle(hash) { let f; for (let i = 0; i < 30; i++) { await sleep(2000); f = await RPC.getTransaction(hash); if (f.status !== 'NOT_FOUND') break; } return f ? f.status : 'UNKNOWN'; }
async function latestLedger() { return (await RPC.getLatestLedger()).sequence; }

async function destField(a) {
  const o = SDK.Operation.invokeContractFunction({ contract: ACC, function: 'dest_field', args: [addr(a)] });
  const src = await RPC.getAccount(op.publicKey());
  const tx = new SDK.TransactionBuilder(src, { fee: '1000000', networkPassphrase: PASS }).addOperation(o).setTimeout(60).build();
  const sim = await RPC.simulateTransaction(tx);
  return BigInt(SDK.scValToNative(sim.result.retval)).toString();
}
async function balance(a) {
  const o = SDK.Operation.invokeContractFunction({ contract: USDC, function: 'balance', args: [addr(a)] });
  const src = await RPC.getAccount(op.publicKey());
  const tx = new SDK.TransactionBuilder(src, { fee: '1000000', networkPassphrase: PASS }).addOperation(o).setTimeout(60).build();
  const sim = await RPC.simulateTransaction(tx);
  return BigInt(SDK.scValToNative(sim.result.retval)).toString();
}

// admin-signed governance call (admin is the tx source -> require_auth satisfied by envelope sig)
async function adminInvoke(fn, args) {
  const o = SDK.Operation.invokeContractFunction({ contract: ACC, function: fn, args: args || [] });
  let src = await RPC.getAccount(admin.publicKey());
  let tx = new SDK.TransactionBuilder(src, { fee: '2000000', networkPassphrase: PASS }).addOperation(o).setTimeout(120).build();
  const sim = await RPC.simulateTransaction(tx);
  if (SDK.rpc.Api.isSimulationError(sim)) throw new Error(fn + ' admin sim: ' + sim.error);
  tx = SDK.rpc.assembleTransaction(tx, sim).build();
  tx.sign(admin);
  const res = await RPC.sendTransaction(tx);
  return { hash: res.hash, status: await settle(res.hash) };
}

// capture a valid transfer footprint + auth-entry template WHILE the account is healthy
async function captureValidFootprint() {
  const src = await RPC.getAccount(op.publicKey());
  const tx = new SDK.TransactionBuilder(src, { fee: '1000000', networkPassphrase: PASS }).addOperation(xfer(PAYEE)).setTimeout(120).build();
  const sim = await RPC.simulateTransaction(tx);
  if (SDK.rpc.Api.isSimulationError(sim)) throw new Error('cannot capture footprint (account not healthy): ' + sim.error);
  const sorobanData = sim.transactionData.build();
  const entry = sim.result.auth.find((e) => e.credentials().switch() === SDK.xdr.SorobanCredentialsType.sorobanCredentialsAddress() && SDK.Address.fromScAddress(e.credentials().address().address()).toString() === ACC);
  return { sorobanData, entry };
}

// attempt a real proof-authorized payment to PAYEE. If __check_auth rejects, read the precise
// code from simulation and land a real FAILED tx via the borrowed footprint; else SUCCESS.
async function attemptPayment(fp) {
  const df = await destField(PAYEE);
  const ll = await latestLedger();
  fp.entry.credentials().address().nonce(SDK.xdr.Int64.fromString(String(Date.now())));
  fp.entry.credentials().address().signatureExpirationLedger(ll + 60);
  const { hi, lo } = payloadHalves(sorobanAuthPayload(fp.entry, PASS));
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(
    { amount: AMT.toString(), dest: df, policy_commitment: secret.commitment, allowlist_root: secret.root, sigpayload_hi: hi, sigpayload_lo: lo, cap: secret.cap, salt: secret.salt, path: secret.path, index_bits: secret.index_bits }, WASM, ZKEY);
  fp.entry.credentials().address().signature(proofSigScVal(proof, publicSignals, 'c1c0'));
  let src = await RPC.getAccount(op.publicKey());
  let tx = new SDK.TransactionBuilder(src, { fee: '20000000', networkPassphrase: PASS }).addOperation(xfer(PAYEE, [fp.entry])).setSorobanData(fp.sorobanData).setTimeout(120).build();
  const sim = await RPC.simulateTransaction(tx);
  const simErr = SDK.rpc.Api.isSimulationError(sim) ? String(sim.error).split('\n').find((l) => l.includes('Error(')) || String(sim.error).split('\n')[0] : null;
  const code = codeFrom(sim.error || '');
  src = await RPC.getAccount(op.publicKey());
  tx = new SDK.TransactionBuilder(src, { fee: '20000000', networkPassphrase: PASS }).addOperation(xfer(PAYEE, [fp.entry])).setSorobanData(fp.sorobanData).setTimeout(120).build();
  tx.sign(op);
  const res = await RPC.sendTransaction(tx);
  return { code, simErr, hash: res.hash, status: await settle(res.hash) };
}

// a non-admin tries to freeze: require_auth(admin) is unsatisfiable -> sim fails; we also land a
// real FAILED tx by borrowing a freeze footprint from an admin sim (not submitted).
async function nonAdminFreeze() {
  const o = SDK.Operation.invokeContractFunction({ contract: ACC, function: 'freeze', args: [] });
  let src = await RPC.getAccount(op.publicKey());
  let tx = new SDK.TransactionBuilder(src, { fee: '2000000', networkPassphrase: PASS }).addOperation(o).setTimeout(120).build();
  const sim = await RPC.simulateTransaction(tx);
  const simErr = SDK.rpc.Api.isSimulationError(sim) ? String(sim.error).split('\n')[0] : '(unexpected: sim succeeded)';
  let hash = null, status = null;
  try {
    const asrc = await RPC.getAccount(admin.publicKey());
    const atx = new SDK.TransactionBuilder(asrc, { fee: '2000000', networkPassphrase: PASS }).addOperation(SDK.Operation.invokeContractFunction({ contract: ACC, function: 'freeze', args: [] })).setTimeout(120).build();
    const asim = await RPC.simulateTransaction(atx);
    if (!SDK.rpc.Api.isSimulationError(asim)) {
      const fp = asim.transactionData.build();
      src = await RPC.getAccount(op.publicKey());
      const ftx = new SDK.TransactionBuilder(src, { fee: '20000000', networkPassphrase: PASS }).addOperation(o).setSorobanData(fp).setTimeout(120).build();
      ftx.sign(op);
      const res = await RPC.sendTransaction(ftx);
      hash = res.hash; status = await settle(res.hash);
    }
  } catch (e) { /* sim-only rejection is sufficient proof */ }
  return { simErr, hash, status };
}

const out = { account: ACC, admin: admin.publicKey(), steps: {} };
const log = (k, v) => { out.steps[k] = v; console.log(k, JSON.stringify(v)); };

console.log('=== capture healthy footprint ===');
const fp = await captureValidFootprint();
out.balanceBefore = await balance(ACC);

console.log('=== 1. non-admin freeze (must be rejected) ===');
log('nonAdminFreeze', await nonAdminFreeze());

console.log('=== 2. admin freeze ===');
log('adminFreeze', await adminInvoke('freeze', []));
console.log('=== 3. frozen spend rejection (expect #17) ===');
log('frozenSpend', await attemptPayment(fp));

console.log('=== 4. admin unfreeze ===');
log('adminUnfreeze', await adminInvoke('unfreeze', []));

console.log('=== 5. rotate -> BOGUS ===');
log('rotateBogus', await adminInvoke('rotate_policy', [u256ScVal(BOGUS_C), u256ScVal(BOGUS_R)]));
console.log('=== 6. old-proof rejection after rotation (expect #4) ===');
log('postRotateSpend', await attemptPayment(fp));

console.log('=== 7. rotate -> REAL (restore) ===');
log('rotateReal', await adminInvoke('rotate_policy', [u256ScVal(secret.commitment), u256ScVal(secret.root)]));
console.log('=== 8. fresh proof for the (re-)committed policy SUCCEEDS (real USDC) ===');
log('newPolicySpend', await attemptPayment(fp));

out.balanceAfter = await balance(ACC);
fs.writeFileSync(`${B}/build/gov_proof.json`, JSON.stringify(out, null, 2));
console.log('=== SUMMARY ===');
console.log(JSON.stringify(out, null, 2));
process.exit(0);
