// De-risk the DIRECT __check_auth invocation (controllable Context ScVal) against the deployed
// account: surfaces the precise AccError for each crafted input. This is the deck's "parallel
// direct __check_auth simulation". Proves one valid proof for a chosen payload, then probes.
import * as SDK from '@stellar/stellar-sdk';
import fs from 'fs';
import { createRequire } from 'module';
import { proofSigScVal, payloadHalves } from './lib.mjs';
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
const sym = (s) => SDK.xdr.ScVal.scvSymbol(s);
const i128 = (n) => SDK.nativeToScVal(BigInt(n), { type: 'i128' });
const ctx = (sac, from, to, amount) => SDK.xdr.ScVal.scvVec([sym('Contract'), SDK.xdr.ScVal.scvMap([
  new SDK.xdr.ScMapEntry({ key: sym('args'), val: SDK.xdr.ScVal.scvVec([addr(from), addr(to), i128(amount)]) }),
  new SDK.xdr.ScMapEntry({ key: sym('contract'), val: addr(sac) }),
  new SDK.xdr.ScMapEntry({ key: sym('fn_name'), val: sym('transfer') }),
])]);
const parseCode = (s) => { const m = String(s).match(/Error\(Contract, #(\d+)\)/); return m ? ('#' + m[1]) : (String(s).match(/Error\([^)]*\)/) || ['?'])[0]; };

async function destField(a) {
  const op = SDK.Operation.invokeContractFunction({ contract: ACC, function: 'dest_field', args: [addr(a)] });
  const src = await RPC.getAccount(kp.publicKey());
  const tx = new SDK.TransactionBuilder(src, { fee: '1000000', networkPassphrase: PASS }).addOperation(op).setTimeout(60).build();
  const sim = await RPC.simulateTransaction(tx);
  return BigInt(SDK.scValToNative(sim.result.retval)).toString();
}
async function callCheckAuth(payloadBuf, proofScv, contextsScv) {
  const op = SDK.Operation.invokeContractFunction({ contract: ACC, function: '__check_auth',
    args: [SDK.xdr.ScVal.scvBytes(payloadBuf), proofScv, SDK.xdr.ScVal.scvVec(contextsScv)] });
  const src = await RPC.getAccount(kp.publicKey());
  const tx = new SDK.TransactionBuilder(src, { fee: '2000000', networkPassphrase: PASS }).addOperation(op).setTimeout(60).build();
  const sim = await RPC.simulateTransaction(tx);
  if (SDK.rpc.Api.isSimulationError(sim)) return { code: parseCode(sim.error), raw: String(sim.error).split('\n')[0] };
  return { ok: SDK.scValToNative(sim.result.retval) };
}

const df = await destField(PAYEE);
const P = SDK.hash(Buffer.from('covenant-deck-probe-v1'));
const { hi, lo } = payloadHalves(P);
const input = { amount: AMT.toString(), dest: df, policy_commitment: secret.commitment, allowlist_root: secret.root, sigpayload_hi: hi, sigpayload_lo: lo, cap: secret.cap, salt: secret.salt, path: secret.path, index_bits: secret.index_bits };
const { proof, publicSignals } = await snarkjs.groth16.fullProve(input, `${B}/circuits/build/policy_js/policy.wasm`, `${B}/circuits/build/policy_final.zkey`);
const sig = proofSigScVal(proof, publicSignals, 'c1c0');

console.log('valid (1 ctx, correct)   ->', JSON.stringify(await callCheckAuth(P, sig, [ctx(USDC, ACC, PAYEE, AMT)])));
console.log('empty contexts           -> expect #15 NoContext       :', JSON.stringify(await callCheckAuth(P, sig, [])));
console.log('two contexts             -> expect #16 TooManyContexts :', JSON.stringify(await callCheckAuth(P, sig, [ctx(USDC, ACC, PAYEE, AMT), ctx(USDC, ACC, PAYEE, AMT)])));
console.log('redirected dest          -> expect #6 BadDestBinding   :', JSON.stringify(await callCheckAuth(P, sig, [ctx(USDC, ACC, ATTACKER, AMT)])));
console.log('wrong token (XLM SAC)    -> expect #10 BadTokenBinding :', JSON.stringify(await callCheckAuth(P, sig, [ctx(XLM, ACC, PAYEE, AMT)])));
process.exit(0);
