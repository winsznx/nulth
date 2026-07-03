// Execute a USDC SAC transfer FROM the Covenant account, authorized ONLY by a
// Groth16 proof (no keys). Adapted from the proven zkpay.mjs: swaps the XLM SAC
// for the canonical USDC SAC and attaches the c1c0-serialized ProofSig.
import * as SDK from '@stellar/stellar-sdk';
import fs from 'fs';
import { proofSigScVal } from './lib.mjs';

const RPC = new SDK.rpc.Server('https://soroban-testnet.stellar.org');
const PASS = SDK.Networks.TESTNET;

const ACC = process.env.ACC;       // Covenant account (the keyless spender)
const SAC = process.env.SAC;       // USDC SAC
const PAYEE = process.env.PAYEE;   // destination
const AMOUNT = BigInt(process.env.AMT || '10000000'); // 1.0 USDC
const submitter = SDK.Keypair.fromSecret(process.env.SECRET); // fee payer only

const proof = JSON.parse(fs.readFileSync('/Users/mac/covenant/circuits/build/proof.json'));
const pub = JSON.parse(fs.readFileSync('/Users/mac/covenant/circuits/build/public.json'));
const proofSig = proofSigScVal(proof, pub, 'c1c0');

const op = SDK.Operation.invokeContractFunction({
  contract: SAC,
  function: 'transfer',
  args: [
    SDK.nativeToScVal(ACC, { type: 'address' }),
    SDK.nativeToScVal(PAYEE, { type: 'address' }),
    SDK.nativeToScVal(AMOUNT, { type: 'i128' }),
  ],
});

let source = await RPC.getAccount(submitter.publicKey());
let tx = new SDK.TransactionBuilder(source, { fee: '1000000', networkPassphrase: PASS })
  .addOperation(op).setTimeout(120).build();

let sim = await RPC.simulateTransaction(tx);
if (SDK.rpc.Api.isSimulationError(sim)) { console.error('SIM ERROR', sim.error); process.exit(1); }
const authEntries = sim.result.auth;
console.log('auth entries from sim:', authEntries.length);

const lastLedger = sim.latestLedger + 60;
const signedAuth = [];
for (const entry of authEntries) {
  const cred = entry.credentials();
  if (cred.switch() === SDK.xdr.SorobanCredentialsType.sorobanCredentialsAddress()) {
    const addr = SDK.Address.fromScAddress(cred.address().address()).toString();
    if (addr === ACC) {
      cred.address().signatureExpirationLedger(lastLedger);
      cred.address().signature(proofSig);
      signedAuth.push(entry);
      console.log('attached ProofSig to auth entry for', addr);
      continue;
    }
  }
  signedAuth.push(entry);
}

const op2 = SDK.Operation.invokeContractFunction({
  contract: SAC,
  function: 'transfer',
  args: op.body().invokeHostFunctionOp().hostFunction().invokeContract().args(),
  auth: signedAuth,
});
source = await RPC.getAccount(submitter.publicKey());
tx = new SDK.TransactionBuilder(source, { fee: '20000000', networkPassphrase: PASS })
  .addOperation(op2).setTimeout(120).build();

sim = await RPC.simulateTransaction(tx);
if (SDK.rpc.Api.isSimulationError(sim)) { console.error('SIM2 ERROR', sim.error); process.exit(1); }
const simInsns = sim.transactionData?.build()?.resources()?.instructions?.();
console.log('sim2 ok. simulated cpuInsns:', sim.cost?.cpuInsns, '| declared instructions:', simInsns);

tx = SDK.rpc.assembleTransaction(tx, sim).build();
const declaredInsns = tx.toEnvelope().v1().tx().ext().sorobanData().resources().instructions();
console.log('assembled declared instructions (envelope):', declaredInsns);
tx.sign(submitter);
const res = await RPC.sendTransaction(tx);
console.log('send status:', res.status, 'hash:', res.hash);
let final;
for (let i = 0; i < 30; i++) {
  await new Promise((r) => setTimeout(r, 2000));
  final = await RPC.getTransaction(res.hash);
  if (final.status !== 'NOT_FOUND') break;
}
console.log('final status:', final.status);
console.log('TXHASH=' + res.hash);
console.log('DECLARED_INSTRUCTIONS=' + declaredInsns);
process.exit(final.status === 'SUCCESS' ? 0 : 2);
