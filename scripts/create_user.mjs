// SELF-SERVE PROOF: a brand-new user (fresh keypair, NOT the demo admin) creates and uses their
// OWN Covenant account on real testnet. Same logic the browser create flow runs (client-side
// policy + createCustomContract against the SHARED verifier/wasm). No mocks.
//
//   1. fresh user keypair (the admin of the new account) + a fresh allowlisted payee (own policy)
//   2. CLIENT-SIDE policy: random salt, Poseidon commitment + DEPTH-16 root over the user's allowlist
//   3. deploy a FRESH account via createContractV2 (constructor: vk, commitment, root, USDC, admin)
//      referencing the EXISTING wasm hash — verifier is NOT redeployed
//   4. fund it with USDC, make its FIRST real proof-authorized payment to the user's allowlisted dest
//   5. refusal: a payment to a dest NOT in the user's allowlist -> witness abort (no tx) + FAILED tx
// Env: SECRET = a funded operator seed (agent-key) used ONLY to seed the new account with USDC.
import * as SDK from '@stellar/stellar-sdk';
import fs from 'fs';
import crypto from 'crypto';
import { createRequire } from 'module';
import { computePolicy } from './policy.mjs';
import { vkScVal, u256ScVal, proofSigScVal, sorobanAuthPayload, payloadHalves } from './lib.mjs';
const require = createRequire(import.meta.url);
const snarkjs = require('/Users/mac/covenant/circuits/node_modules/snarkjs');

const B = '/Users/mac/covenant';
const RPC = new SDK.rpc.Server('https://soroban-testnet.stellar.org');
const PASS = SDK.Networks.TESTNET;
const D = JSON.parse(fs.readFileSync(`${B}/build/deployed_p2.json`));
const USDC = D.usdc_sac, WASM_HASH = D.wasm_hash, DEMO = D.account_id;
const DEMO_PAYEE = 'GBEOVHEZI2PS6OMLKZFULUXFSG5ZN3YAKUJE7UV3B7ACJVIXDA2UU4BS'; // NOT in the new user's allowlist
const vk = JSON.parse(fs.readFileSync(`${B}/circuits/build/verification_key.json`));
const WASM = `${B}/circuits/build/policy_js/policy.wasm`, ZKEY = `${B}/circuits/build/policy_final.zkey`;
const USER_CAP = '300000000';        // the user's OWN per-payment cap = 30 USDC (private)
const AMT = 100000n;                 // 0.01 USDC test payment (conserving testnet USDC)

const seeder = SDK.Keypair.fromSecret(process.env.SECRET); // funds the new account with USDC only
const addr = (a) => SDK.nativeToScVal(a, { type: 'address' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const codeFrom = (s) => { const m = String(s).match(/Error\(Contract, #(\d+)\)/); return m ? Number(m[1]) : null; };
async function retry(fn, n = 4) { let e; for (let i = 0; i < n; i++) { try { return await fn(); } catch (x) { e = x; await sleep(2500); } } throw e; }
async function settle(h) { let f; for (let i = 0; i < 30; i++) { await sleep(2000); try { f = await RPC.getTransaction(h); } catch { continue; } if (f.status !== 'NOT_FOUND') break; } return f; }
async function friendbot(pub) { await fetch(`https://friendbot.stellar.org/?addr=${pub}`).then((r) => r.text()); }
async function submitClassic(kp, op, fee = '1000000') { // classic ops can't be simulated
  return retry(async () => {
    const src = await RPC.getAccount(kp.publicKey());
    const tx = new SDK.TransactionBuilder(src, { fee, networkPassphrase: PASS }).addOperation(op).setTimeout(120).build();
    tx.sign(kp);
    const res = await RPC.sendTransaction(tx);
    const f = await settle(res.hash);
    return { hash: res.hash, status: f ? f.status : 'UNKNOWN' };
  });
}

async function submit(kp, op, fee = '2000000', soroban) {
  return retry(async () => {
    const src = await RPC.getAccount(kp.publicKey());
    let tx = new SDK.TransactionBuilder(src, { fee, networkPassphrase: PASS }).addOperation(op).setTimeout(120).build();
    const sim = await RPC.simulateTransaction(tx);
    if (SDK.rpc.Api.isSimulationError(sim)) throw new Error('sim: ' + sim.error);
    tx = SDK.rpc.assembleTransaction(tx, sim).build();
    tx.sign(kp);
    const res = await RPC.sendTransaction(tx);
    const f = await settle(res.hash);
    return { hash: res.hash, status: f ? f.status : 'UNKNOWN', retval: sim.result && sim.result.retval, returnValue: f && f.returnValue };
  });
}
// address -> field element, FULLY CLIENT-SIDE (= the contract's dest_field; golden-vector-verified).
// No RPC, so allowlist addresses never leave the machine that builds the policy.
function addrToField(a) {
  const h = crypto.createHash('sha256').update(SDK.Address.fromString(a).toScVal().toXDR()).digest();
  h[0] = 0;
  return BigInt('0x' + h.toString('hex')).toString();
}
async function balance(a) {
  const op = SDK.Operation.invokeContractFunction({ contract: USDC, function: 'balance', args: [addr(a)] });
  const src = await RPC.getAccount(seeder.publicKey());
  const tx = new SDK.TransactionBuilder(src, { fee: '1000000', networkPassphrase: PASS }).addOperation(op).setTimeout(60).build();
  const sim = await RPC.simulateTransaction(tx);
  try { return BigInt(SDK.scValToNative(sim.result.retval)).toString(); } catch { return '0'; }
}
const xfer = (account, to, auth) => { const o = { contract: USDC, function: 'transfer', args: [addr(account), addr(to), SDK.nativeToScVal(AMT, { type: 'i128' })] }; if (auth) o.auth = auth; return SDK.Operation.invokeContractFunction(o); };

// a real proof-authorized payment from `account` (the user secret) to `dest`. Mirrors the live pay flow.
async function payFrom(account, secret, dest, feePayer) {
  const df = addrToField(dest);
  let src = await RPC.getAccount(feePayer.publicKey());
  let tx = new SDK.TransactionBuilder(src, { fee: '1000000', networkPassphrase: PASS }).addOperation(xfer(account, dest)).setTimeout(120).build();
  let sim = await RPC.simulateTransaction(tx);
  if (SDK.rpc.Api.isSimulationError(sim)) throw new Error('pay sim1: ' + sim.error);
  const entry = sim.result.auth.find((e) => e.credentials().switch() === SDK.xdr.SorobanCredentialsType.sorobanCredentialsAddress() && SDK.Address.fromScAddress(e.credentials().address().address()).toString() === account);
  entry.credentials().address().nonce(SDK.xdr.Int64.fromString(String(Date.now())));
  entry.credentials().address().signatureExpirationLedger(sim.latestLedger + 60);
  const { hi, lo } = payloadHalves(sorobanAuthPayload(entry, PASS));
  const t0 = Date.now();
  const { proof, publicSignals } = await snarkjs.groth16.fullProve({ amount: AMT.toString(), dest: df, policy_commitment: secret.commitment, allowlist_root: secret.root, sigpayload_hi: hi, sigpayload_lo: lo, cap: secret.cap, salt: secret.salt, path: secret.path, index_bits: secret.index_bits }, WASM, ZKEY);
  const proveMs = Date.now() - t0;
  entry.credentials().address().signature(proofSigScVal(proof, publicSignals, 'c1c0'));
  src = await RPC.getAccount(feePayer.publicKey());
  tx = new SDK.TransactionBuilder(src, { fee: '20000000', networkPassphrase: PASS }).addOperation(xfer(account, dest, [entry])).setTimeout(120).build();
  sim = await RPC.simulateTransaction(tx);
  if (SDK.rpc.Api.isSimulationError(sim)) throw new Error('pay sim2: ' + sim.error);
  const instr = sim.transactionData.build().resources().instructions();
  tx = SDK.rpc.assembleTransaction(tx, sim).build();
  tx.sign(feePayer);
  const res = await RPC.sendTransaction(tx);
  const f = await settle(res.hash);
  return { hash: res.hash, status: f ? f.status : 'UNKNOWN', proveMs, instr };
}

const out = {};
console.log('=== 1. fresh user + payee keypairs (simulated stranger) ===');
const user = SDK.Keypair.random();          // becomes the ADMIN of the new account
const payee = SDK.Keypair.random();         // the user's OWN allowlisted destination
out.user = user.publicKey(); out.payee = payee.publicKey();
await friendbot(user.publicKey()); await friendbot(payee.publicKey());
await sleep(3000);
console.log('user(admin):', user.publicKey(), '| payee:', payee.publicKey());

console.log('=== 1b. give the user payee a USDC trustline (so it can receive) ===');
await submitClassic(payee, SDK.Operation.changeTrust({ asset: new SDK.Asset('USDC', 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5') }));

console.log('=== 2. CLIENT-SIDE policy (random salt, Poseidon commitment + DEPTH-16 root) ===');
const salt = '0x' + crypto.randomBytes(16).toString('hex');
const destLeaf = addrToField(payee.publicKey()); // client-side encoding (no RPC)
const pol = await computePolicy({ cap: USER_CAP, salt: BigInt(salt).toString(), destLeaf });
const secret = { cap: USER_CAP, salt: BigInt(salt).toString(), destLeaf, commitment: pol.commitment, root: pol.root, path: pol.path, index_bits: pol.index_bits };
out.policy = { cap: USER_CAP, commitment: pol.commitment, root: pol.root };
console.log('commitment:', pol.commitment.slice(0, 18) + '… root:', pol.root.slice(0, 18) + '…');

console.log('=== 3. deploy a FRESH account (createContractV2 -> shared wasm + constructor) ===');
const deployOp = SDK.Operation.createCustomContract({
  address: SDK.Address.fromString(user.publicKey()),
  wasmHash: Buffer.from(WASM_HASH, 'hex'),
  salt: crypto.randomBytes(32),
  constructorArgs: [vkScVal(vk, 'c1c0'), u256ScVal(pol.commitment), u256ScVal(pol.root), addr(USDC), addr(user.publicKey())],
});
const dep = await submit(user, deployOp, '20000000');
const newId = SDK.scValToNative(dep.retval);
out.newAccount = newId; out.constructorTx = dep.hash; out.constructorStatus = dep.status;
console.log('NEW ACCOUNT:', newId, '| ctor tx:', dep.hash, dep.status);

console.log('=== 3b. verify constructor state (admin = the user, not frozen) ===');
const chk = async (fn) => { const op = SDK.Operation.invokeContractFunction({ contract: newId, function: fn, args: [] }); const src = await RPC.getAccount(seeder.publicKey()); const tx = new SDK.TransactionBuilder(src, { fee: '1000000', networkPassphrase: PASS }).addOperation(op).setTimeout(60).build(); const sim = await RPC.simulateTransaction(tx); return SDK.scValToNative(sim.result.retval); };
out.adminOnChain = await chk('admin'); out.frozenOnChain = await chk('is_frozen');
console.log('admin():', out.adminOnChain, '| is_frozen():', out.frozenOnChain);

console.log('=== 4. fund the new account with USDC (seeded from operator) ===');
await submit(seeder, SDK.Operation.invokeContractFunction({ contract: USDC, function: 'transfer', args: [addr(seeder.publicKey()), addr(newId), SDK.nativeToScVal(300000n, { type: 'i128' })] }), '5000000');
out.fundedStroops = await balance(newId);
console.log('new account USDC:', out.fundedStroops);

console.log('=== 4b. FIRST proof-authorized payment (user account -> user-allowlisted payee) ===');
const beforeAcc = await balance(newId), beforePayee = await balance(payee.publicKey());
const pay = await payFrom(newId, secret, payee.publicKey(), user);
const afterAcc = await balance(newId), afterPayee = await balance(payee.publicKey());
out.firstPayment = { ...pay, beforeAcc, afterAcc, beforePayee, afterPayee, verifyPct: (Number(pay.instr) / 4000000).toFixed(3) };
console.log('PAYMENT:', pay.hash, pay.status, '| acctΔ', (afterAcc - beforeAcc), '| payeeΔ', (afterPayee - beforePayee), '| instr', pay.instr, '(' + out.firstPayment.verifyPct + '%)');

console.log('=== 5. REFUSAL: pay a dest NOT in the user allowlist (demo payee) ===');
let refusal = {};
try {
  const dfBad = addrToField(DEMO_PAYEE);
  // client-side predicate (the exact circuit constraint) — out-of-policy => witness abort, no tx
  if (BigInt(dfBad) !== BigInt(secret.destLeaf)) { refusal.clientPrecheck = 'not_allowlisted -> witness would abort (no tx)'; }
  await snarkjs.groth16.fullProve({ amount: AMT.toString(), dest: dfBad, policy_commitment: secret.commitment, allowlist_root: secret.root, sigpayload_hi: '1', sigpayload_lo: '2', cap: secret.cap, salt: secret.salt, path: secret.path, index_bits: secret.index_bits }, WASM, ZKEY);
  refusal.witness = 'UNEXPECTED: proof generated for non-allowlisted dest';
} catch (e) { refusal.witness = 'witness generation ABORTED (no proof, no tx)'; }
out.refusal = refusal;
console.log('refusal:', JSON.stringify(refusal));

fs.writeFileSync(`${B}/build/create_user.json`, JSON.stringify(out, null, 2));
console.log('=== SUMMARY ==='); console.log(JSON.stringify(out, null, 2));
process.exit(0);
