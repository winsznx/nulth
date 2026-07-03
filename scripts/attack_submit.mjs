// Decisive feasibility test: can an attack that FAILS auth still be SUBMITTED and land as a
// real REJECTED tx on-chain (real hash)? require_auth failures fail simulation, so we borrow a
// valid payment's soroban footprint and submit past sim. Redirect attack: proof bound to the
// attacker-invocation but sig_dest=payee -> __check_auth rejects (BadDestBinding, internal).
import * as SDK from '@stellar/stellar-sdk';
import fs from 'fs';
import { createRequire } from 'module';
import { proofSigScVal, sorobanAuthPayload, payloadHalves } from './lib.mjs';
const require = createRequire(import.meta.url);
const snarkjs = require('/Users/mac/covenant/circuits/node_modules/snarkjs');
const RPC = new SDK.rpc.Server('https://soroban-testnet.stellar.org');
const PASS = SDK.Networks.TESTNET;
const ACC = 'CANA5QYVHNON7AV752ZRATFW2T5BMS3MU5DDPJMU5UGSR3KSH45LOGZE';
const USDC = 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA';
const PAYEE = 'GBEOVHEZI2PS6OMLKZFULUXFSG5ZN3YAKUJE7UV3B7ACJVIXDA2UU4BS';
const ATTACKER = 'GCES7J7AFTPOM7LRFI5FCE3PRWFCOU56IBPLQY7O2TM3YSTA3G2FLEJ3';
const B = '/Users/mac/covenant';
const secret = JSON.parse(fs.readFileSync(`${B}/build/policy_secret.json`));
const kp = SDK.Keypair.fromSecret(process.env.SECRET);
const AMT = 10000000n;
const addr = (a) => SDK.nativeToScVal(a, { type: 'address' });
const xfer = (to, auth) => { const o = { contract: USDC, function: 'transfer', args: [addr(ACC), addr(to), SDK.nativeToScVal(AMT, { type: 'i128' })] }; if (auth) o.auth = auth; return SDK.Operation.invokeContractFunction(o); };
async function destField(a) { const op = SDK.Operation.invokeContractFunction({ contract: ACC, function: 'dest_field', args: [addr(a)] }); const src = await RPC.getAccount(kp.publicKey()); const tx = new SDK.TransactionBuilder(src, { fee: '1000000', networkPassphrase: PASS }).addOperation(op).setTimeout(60).build(); const sim = await RPC.simulateTransaction(tx); return BigInt(SDK.scValToNative(sim.result.retval)).toString(); }

// 1) borrow a valid payment's soroban footprint (to PAYEE) — gives a superset footprint.
const dfPayee = await destField(PAYEE);
let src = await RPC.getAccount(kp.publicKey());
let validTx = new SDK.TransactionBuilder(src, { fee: '100000', networkPassphrase: PASS }).addOperation(xfer(PAYEE)).setTimeout(120).build();
let validSim = await RPC.simulateTransaction(validTx);
const sorobanData = validSim.transactionData.build();
const validEntry = validSim.result.auth.find((e) => e.credentials().switch() === SDK.xdr.SorobanCredentialsType.sorobanCredentialsAddress() && SDK.Address.fromScAddress(e.credentials().address().address()).toString() === ACC);

// 2) build the ATTACK: transfer to ATTACKER; auth entry for that invocation; prove for the
//    attacker-invocation payload but with sig_dest = dest_field(PAYEE) (redirect).
src = await RPC.getAccount(kp.publicKey());
let attackTx = new SDK.TransactionBuilder(src, { fee: '100000', networkPassphrase: PASS }).addOperation(xfer(ATTACKER)).setTimeout(120).build();
let attackSim = await RPC.simulateTransaction(attackTx);
console.log('attack sim error (expected, auth fails):', SDK.rpc.Api.isSimulationError(attackSim) ? String(attackSim.error).split('\n')[0] : 'NONE (unexpected)');
// the failing sim still returns the auth entry to populate
const entry = (attackSim.result?.auth || [])[0] || validEntry;
const exp = (validSim.latestLedger || attackSim.latestLedger) + 60;
entry.credentials().address().nonce(SDK.xdr.Int64.fromString(String(Date.now())));
entry.credentials().address().signatureExpirationLedger(exp);
const payload = sorobanAuthPayload(entry, PASS);
const { hi, lo } = payloadHalves(payload);
const input = { amount: AMT.toString(), dest: dfPayee, policy_commitment: secret.commitment, allowlist_root: secret.root, sigpayload_hi: hi, sigpayload_lo: lo, cap: secret.cap, salt: secret.salt, path: secret.path, index_bits: secret.index_bits };
const { proof, publicSignals } = await snarkjs.groth16.fullProve(input, `${B}/circuits/build/policy_js/policy.wasm`, `${B}/circuits/build/policy_final.zkey`);
entry.credentials().address().signature(proofSigScVal(proof, publicSignals, 'c1c0'));

// 3) build the final attack tx with the BORROWED footprint, high fee, sign, SUBMIT past sim.
src = await RPC.getAccount(kp.publicKey());
let finalTx = new SDK.TransactionBuilder(src, { fee: '20000000', networkPassphrase: PASS })
  .addOperation(xfer(ATTACKER, [entry])).setSorobanData(sorobanData).setTimeout(120).build();
finalTx.sign(kp);
const res = await RPC.sendTransaction(finalTx);
console.log('send status:', res.status, '| hash:', res.hash, res.errorResult ? ('| ' + JSON.stringify(res.errorResult)) : '');
let final; for (let i = 0; i < 25; i++) { await new Promise((r) => setTimeout(r, 2000)); final = await RPC.getTransaction(res.hash); if (final.status !== 'NOT_FOUND') break; }
console.log('FINAL on-chain status:', final ? final.status : 'NOT_FOUND', '| hash:', res.hash);
process.exit(0);
