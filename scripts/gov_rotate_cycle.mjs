// Robust live rotate cycle (self-restoring): rotate->BOGUS, prove a payment (old proof now fails
// BadPolicyBinding #4), rotate->REAL, prove a payment SUCCEEDS for the (re-)committed policy.
// The rotate-back runs in a finally block + retries, so the account is NEVER left bricked.
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
const AMT = 10000000n;

const op = SDK.Keypair.fromSecret(process.env.SECRET);
const admin = SDK.Keypair.fromSecret(process.env.ADMIN_SECRET);
const addr = (a) => SDK.nativeToScVal(a, { type: 'address' });
const xfer = (to, auth) => { const o = { contract: USDC, function: 'transfer', args: [addr(ACC), addr(to), SDK.nativeToScVal(AMT, { type: 'i128' })] }; if (auth) o.auth = auth; return SDK.Operation.invokeContractFunction(o); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const codeFrom = (s) => { const m = String(s).match(/Error\(Contract, #(\d+)\)/); return m ? Number(m[1]) : null; };
async function retry(fn, n = 4) { let e; for (let i = 0; i < n; i++) { try { return await fn(); } catch (x) { e = x; await sleep(2500); } } throw e; }
async function settle(hash) { let f; for (let i = 0; i < 30; i++) { await sleep(2000); try { f = await RPC.getTransaction(hash); } catch { continue; } if (f.status !== 'NOT_FOUND') break; } return f ? f.status : 'UNKNOWN'; }

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
async function adminInvoke(fn, args) {
  return retry(async () => {
    const o = SDK.Operation.invokeContractFunction({ contract: ACC, function: fn, args: args || [] });
    let src = await RPC.getAccount(admin.publicKey());
    let tx = new SDK.TransactionBuilder(src, { fee: '2000000', networkPassphrase: PASS }).addOperation(o).setTimeout(120).build();
    const sim = await RPC.simulateTransaction(tx);
    if (SDK.rpc.Api.isSimulationError(sim)) throw new Error(fn + ' sim: ' + sim.error);
    tx = SDK.rpc.assembleTransaction(tx, sim).build();
    tx.sign(admin);
    const res = await RPC.sendTransaction(tx);
    return { hash: res.hash, status: await settle(res.hash) };
  });
}
async function captureValidFootprint() {
  const src = await RPC.getAccount(op.publicKey());
  const tx = new SDK.TransactionBuilder(src, { fee: '1000000', networkPassphrase: PASS }).addOperation(xfer(PAYEE)).setTimeout(120).build();
  const sim = await RPC.simulateTransaction(tx);
  if (SDK.rpc.Api.isSimulationError(sim)) throw new Error('cannot capture footprint: ' + sim.error);
  return { sorobanData: sim.transactionData.build(), entry: sim.result.auth.find((e) => e.credentials().switch() === SDK.xdr.SorobanCredentialsType.sorobanCredentialsAddress() && SDK.Address.fromScAddress(e.credentials().address().address()).toString() === ACC) };
}
async function attemptPayment(fp) {
  return retry(async () => {
    const df = await destField(PAYEE);
    const ll = (await RPC.getLatestLedger()).sequence;
    fp.entry.credentials().address().nonce(SDK.xdr.Int64.fromString(String(Date.now())));
    fp.entry.credentials().address().signatureExpirationLedger(ll + 60);
    const { hi, lo } = payloadHalves(sorobanAuthPayload(fp.entry, PASS));
    const { proof, publicSignals } = await snarkjs.groth16.fullProve({ amount: AMT.toString(), dest: df, policy_commitment: secret.commitment, allowlist_root: secret.root, sigpayload_hi: hi, sigpayload_lo: lo, cap: secret.cap, salt: secret.salt, path: secret.path, index_bits: secret.index_bits }, WASM, ZKEY);
    fp.entry.credentials().address().signature(proofSigScVal(proof, publicSignals, 'c1c0'));
    let src = await RPC.getAccount(op.publicKey());
    let tx = new SDK.TransactionBuilder(src, { fee: '20000000', networkPassphrase: PASS }).addOperation(xfer(PAYEE, [fp.entry])).setSorobanData(fp.sorobanData).setTimeout(120).build();
    const sim = await RPC.simulateTransaction(tx);
    const code = codeFrom(sim.error || '');
    src = await RPC.getAccount(op.publicKey());
    tx = new SDK.TransactionBuilder(src, { fee: '20000000', networkPassphrase: PASS }).addOperation(xfer(PAYEE, [fp.entry])).setSorobanData(fp.sorobanData).setTimeout(120).build();
    tx.sign(op);
    const res = await RPC.sendTransaction(tx);
    return { code, hash: res.hash, status: await settle(res.hash) };
  });
}

const out = { account: ACC, steps: {} };
const log = (k, v) => { out.steps[k] = v; console.log(k, JSON.stringify(v)); };
const fp = await captureValidFootprint();
out.balanceBefore = await balance(ACC);
try {
  console.log('=== rotate -> BOGUS ===');
  log('rotateBogus', await adminInvoke('rotate_policy', [u256ScVal(BOGUS_C), u256ScVal(BOGUS_R)]));
  console.log('=== old proof now rejected (expect #4) ===');
  log('postRotateSpend', await attemptPayment(fp));
} finally {
  console.log('=== rotate -> REAL (restore, guaranteed) ===');
  log('rotateReal', await adminInvoke('rotate_policy', [u256ScVal(secret.commitment), u256ScVal(secret.root)]));
}
console.log('=== fresh proof for the (re-)committed policy SUCCEEDS (real USDC) ===');
log('newPolicySpend', await attemptPayment(fp));
out.balanceAfter = await balance(ACC);
fs.writeFileSync(`${B}/build/gov_cycle.json`, JSON.stringify(out, null, 2));
console.log('=== CYCLE SUMMARY ===');
console.log(JSON.stringify(out, null, 2));
process.exit(0);
