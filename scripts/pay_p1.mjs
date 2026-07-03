// P1 hardened pay path: proves AT pay-time, binding the live Soroban
// signature_payload into the proof. Also drives the negative-control matrix.
//
// env: ACC SAC PAYEE AMT SECRET [NONCE] [SEND=yes|no] [MODE] [WRONG_SALT] [TO_OVERRIDE]
// MODE: valid | fresh_nonce | wrong_token | wrong_policy | bitflip | swap_ac
import * as SDK from '@stellar/stellar-sdk';
import fs from 'fs';
import { createRequire } from 'module';
import { commitmentOf } from './policy.mjs';
import { proofSigScVal, payloadHalves, sorobanAuthPayload } from './lib.mjs';
const require = createRequire(import.meta.url);
const snarkjs = require('/Users/mac/covenant/circuits/node_modules/snarkjs');

const RPC = new SDK.rpc.Server('https://soroban-testnet.stellar.org');
const PASS = SDK.Networks.TESTNET;
const ACC = process.env.ACC, SAC = process.env.SAC, PAYEE = process.env.PAYEE;
const TO = process.env.TO_OVERRIDE || PAYEE;
const AMOUNT = BigInt(process.env.AMT || '10000000');
const submitter = SDK.Keypair.fromSecret(process.env.SECRET);
const SEND = (process.env.SEND || 'yes') === 'yes';
const MODE = process.env.MODE || 'valid';
const NONCE = process.env.NONCE ? BigInt(process.env.NONCE) : BigInt(Date.now());

const B = '/Users/mac/covenant';
const secret = JSON.parse(fs.readFileSync(`${B}/build/policy_secret.json`));

const mkOp = (auth) => SDK.Operation.invokeContractFunction({
  contract: SAC, function: 'transfer',
  args: [SDK.nativeToScVal(ACC, { type: 'address' }), SDK.nativeToScVal(TO, { type: 'address' }), SDK.nativeToScVal(AMOUNT, { type: 'i128' })],
  ...(auth ? { auth } : {}),
});

let source = await RPC.getAccount(submitter.publicKey());
let tx = new SDK.TransactionBuilder(source, { fee: '1000000', networkPassphrase: PASS }).addOperation(mkOp()).setTimeout(120).build();
let sim = await RPC.simulateTransaction(tx);
if (SDK.rpc.Api.isSimulationError(sim)) { console.error('SIM1 ERROR', sim.error); process.exit(1); }
const entry = sim.result.auth.find((e) => {
  const c = e.credentials();
  return c.switch() === SDK.xdr.SorobanCredentialsType.sorobanCredentialsAddress() &&
    SDK.Address.fromScAddress(c.address().address()).toString() === ACC;
});
if (!entry) { console.error('no auth entry for ACC'); process.exit(1); }

const exp = sim.latestLedger + 60;
entry.credentials().address().nonce(SDK.xdr.Int64.fromString(NONCE.toString()));
entry.credentials().address().signatureExpirationLedger(exp);

// Compute the payload the host will pass to __check_auth for THIS (nonce, exp, invocation).
const payload = sorobanAuthPayload(entry, PASS);
const { hi, lo } = payloadHalves(payload);

// Prove against the live payload, reusing the precomputed DEPTH-16 path (no tree rebuild).
// wrong_policy: different salt -> different commitment (root/path unchanged).
let salt = secret.salt;
let commitment = secret.commitment;
if (MODE === 'wrong_policy') {
  salt = process.env.WRONG_SALT || '11111111111111111111';
  commitment = await commitmentOf(secret.cap, salt);
}
const input = {
  amount: AMOUNT.toString(), dest: secret.destLeaf,
  policy_commitment: commitment, allowlist_root: secret.root,
  sigpayload_hi: hi, sigpayload_lo: lo,
  cap: secret.cap, salt, path: secret.path, index_bits: secret.index_bits,
};
const { proof, publicSignals } = await snarkjs.groth16.fullProve(input, `${B}/circuits/build/policy_js/policy.wasm`, `${B}/circuits/build/policy_final.zkey`);

// tamper modes that mutate the proof bytes / nonce AFTER proving
let proofSig;
if (MODE === 'bitflip') {
  const bad = { ...proof, pi_a: [...proof.pi_a] };
  // flip the proof by perturbing pi_a x-coordinate -> mangled curve point
  bad.pi_a[0] = (BigInt(proof.pi_a[0]) ^ 1n).toString();
  proofSig = proofSigScVal(bad, publicSignals, 'c1c0');
} else if (MODE === 'swap_ac') {
  const swapped = { ...proof, pi_a: proof.pi_c, pi_c: proof.pi_a };
  proofSig = proofSigScVal(swapped, publicSignals, 'c1c0');
} else {
  proofSig = proofSigScVal(proof, publicSignals, 'c1c0');
}

if (MODE === 'fresh_nonce') {
  // lift the (valid) proof but pair it with a DIFFERENT nonce -> payload mismatch
  entry.credentials().address().nonce(SDK.xdr.Int64.fromString((NONCE + 1n).toString()));
}
entry.credentials().address().signature(proofSig);

source = await RPC.getAccount(submitter.publicKey());
tx = new SDK.TransactionBuilder(source, { fee: '20000000', networkPassphrase: PASS }).addOperation(mkOp([entry])).setTimeout(120).build();
sim = await RPC.simulateTransaction(tx);
if (SDK.rpc.Api.isSimulationError(sim)) {
  console.log(`MODE=${MODE} SIM2_DIAGNOSTIC: ${String(sim.error).split('\n')[0]}`);
  // surface the contract error code line too
  const m = String(sim.error).match(/Error\([^)]*\)[^"]*/);
  if (m) console.log('ERROR_CODE:', m[0]);
  process.exit(SEND ? 3 : 0);
}
const declared = sim.transactionData.build().resources().instructions();
console.log(`MODE=${MODE} sim2 OK. declared instructions: ${declared}`);
if (!SEND) { console.log('SEND=no -> stopping after sim'); process.exit(0); }

tx = SDK.rpc.assembleTransaction(tx, sim).build();
const declaredEnv = tx.toEnvelope().v1().tx().ext().sorobanData().resources().instructions();
fs.writeFileSync(`${B}/build/last_auth.xdr`, entry.toXDR('base64'));
tx.sign(submitter);
const res = await RPC.sendTransaction(tx);
let final;
for (let i = 0; i < 30; i++) { await new Promise((r) => setTimeout(r, 2000)); final = await RPC.getTransaction(res.hash); if (final.status !== 'NOT_FOUND') break; }
console.log(`MODE=${MODE} send=${res.status} final=${final.status}`);
console.log('TXHASH=' + res.hash);
console.log('NONCE=' + NONCE.toString());
console.log('DECLARED_INSTRUCTIONS=' + declaredEnv);
console.log('SIGNED_AUTH_XDR=' + entry.toXDR('base64'));
process.exit(final.status === 'SUCCESS' ? 0 : 2);
