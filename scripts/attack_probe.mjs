// Lock the per-attack on-chain code mapping (sim-only, no submit). Each mode crafts the signed
// malicious tx and parses the precise contract AccError from the require_auth simulation.
import * as SDK from '@stellar/stellar-sdk';
import fs from 'fs';
import { createRequire } from 'module';
import { proofSigScVal, sorobanAuthPayload, payloadHalves } from './lib.mjs';
import { commitmentOf } from './policy.mjs';
const require = createRequire(import.meta.url);
const snarkjs = require('/Users/mac/covenant/circuits/node_modules/snarkjs');
const RPC = new SDK.rpc.Server('https://soroban-testnet.stellar.org');
const PASS = SDK.Networks.TESTNET;
const ACC = 'CANA5QYVHNON7AV752ZRATFW2T5BMS3MU5DDPJMU5UGSR3KSH45LOGZE';
const USDC = 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA';
const XLM = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC';
const PAYEE = 'GBEOVHEZI2PS6OMLKZFULUXFSG5ZN3YAKUJE7UV3B7ACJVIXDA2UU4BS';
const ATTACKER = 'GCES7J7AFTPOM7LRFI5FCE3PRWFCOU56IBPLQY7O2TM3YSTA3G2FLEJ3';
const B = '/Users/mac/covenant';
const secret = JSON.parse(fs.readFileSync(`${B}/build/policy_secret.json`));
const kp = SDK.Keypair.fromSecret(process.env.SECRET);
const AMT = 10000000n;
const addr = (a) => SDK.nativeToScVal(a, { type: 'address' });
const xfer = (sac, to, auth) => { const o = { contract: sac, function: 'transfer', args: [addr(ACC), addr(to), SDK.nativeToScVal(AMT, { type: 'i128' })] }; if (auth) o.auth = auth; return SDK.Operation.invokeContractFunction(o); };
const code = (s) => { const m = String(s).match(/Error\(Contract, #(\d+)\)/); return m ? ('#' + m[1]) : (String(s).split('\n')[0]); };
const names = { '#3': 'BadProof', '#4': 'BadPolicyBinding', '#5': 'BadAmountBinding', '#6': 'BadDestBinding', '#10': 'BadTokenBinding', '#13': 'BadSigPayload', '#16': 'TooManyContexts' };
async function destField(a) { const op = SDK.Operation.invokeContractFunction({ contract: ACC, function: 'dest_field', args: [addr(a)] }); const src = await RPC.getAccount(kp.publicKey()); const tx = new SDK.TransactionBuilder(src, { fee: '1000000', networkPassphrase: PASS }).addOperation(op).setTimeout(60).build(); const sim = await RPC.simulateTransaction(tx); return BigInt(SDK.scValToNative(sim.result.retval)).toString(); }

async function probe(mode) {
  const sac = mode === 'wrong_token' ? XLM : USDC;
  const to = mode === 'redirect' ? ATTACKER : PAYEE;
  const dfProve = await destField(PAYEE); // always prove the allowlisted dest (provable)
  let src = await RPC.getAccount(kp.publicKey());
  let tx = new SDK.TransactionBuilder(src, { fee: '2000000', networkPassphrase: PASS }).addOperation(xfer(sac, to)).setTimeout(120).build();
  let sim = await RPC.simulateTransaction(tx);
  const entries = (sim.result?.auth || []).filter((e) => e.credentials().switch() === SDK.xdr.SorobanCredentialsType.sorobanCredentialsAddress() && SDK.Address.fromScAddress(e.credentials().address().address()).toString() === ACC);
  if (!entries.length) return `${mode}: NO AUTH ENTRY (sim: ${code(sim.error)})`;
  const entry = entries[0];
  const exp = sim.latestLedger + 60;
  const nonce = BigInt(Date.now());
  entry.credentials().address().nonce(SDK.xdr.Int64.fromString(nonce.toString()));
  entry.credentials().address().signatureExpirationLedger(exp);
  const payload = sorobanAuthPayload(entry, PASS);
  const { hi, lo } = payloadHalves(payload);
  let salt = secret.salt, commitment = secret.commitment;
  if (mode === 'wrong_policy') { salt = '11111111111111111111'; commitment = await commitmentOf(secret.cap, salt); }
  const input = { amount: AMT.toString(), dest: dfProve, policy_commitment: commitment, allowlist_root: secret.root, sigpayload_hi: hi, sigpayload_lo: lo, cap: secret.cap, salt, path: secret.path, index_bits: secret.index_bits };
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(input, `${B}/circuits/build/policy_js/policy.wasm`, `${B}/circuits/build/policy_final.zkey`);
  let p = proof;
  if (mode === 'swap_ac') p = { ...proof, pi_a: proof.pi_c, pi_c: proof.pi_a };
  entry.credentials().address().signature(proofSigScVal(p, publicSignals, 'c1c0'));
  if (mode === 'fresh_nonce') entry.credentials().address().nonce(SDK.xdr.Int64.fromString((nonce + 1n).toString()));
  src = await RPC.getAccount(kp.publicKey());
  tx = new SDK.TransactionBuilder(src, { fee: '2000000', networkPassphrase: PASS }).addOperation(xfer(sac, to, [entry])).setTimeout(120).build();
  sim = await RPC.simulateTransaction(tx);
  const c = SDK.rpc.Api.isSimulationError(sim) ? code(sim.error) : 'SIM_OK(unexpected)';
  return `${mode}: ${c} ${names[c] ? '(' + names[c] + ')' : ''}`;
}

for (const m of ['swap_ac', 'fresh_nonce', 'wrong_policy', 'wrong_token', 'redirect']) {
  console.log(await probe(m));
}
process.exit(0);
