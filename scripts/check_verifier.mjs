// On-chain oracle: invoke the deployed standalone verifier's verify_proof with
// our vk + proof, trying both G2 coordinate orders, and report which returns true.
// This settles the byte serialization empirically before we touch the account.
import * as SDK from '@stellar/stellar-sdk';
import fs from 'fs';
import { vkScVal, proofScVal, pubVecScVal } from './lib.mjs';

const RPC = new SDK.rpc.Server('https://soroban-testnet.stellar.org');
const PASS = SDK.Networks.TESTNET;
const VERIFIER = process.env.VERIFIER;
const SRC = process.env.SRC; // a funded public key (source for simulation)
const B = '/Users/mac/covenant/circuits/build';
const vk = JSON.parse(fs.readFileSync(`${B}/verification_key.json`));
const proof = JSON.parse(fs.readFileSync(`${B}/proof.json`));
const pub = JSON.parse(fs.readFileSync(`${B}/public.json`));

const source = await RPC.getAccount(SRC);

for (const order of ['c1c0', 'c0c1']) {
  const op = SDK.Operation.invokeContractFunction({
    contract: VERIFIER,
    function: 'verify_proof',
    args: [vkScVal(vk, order), proofScVal(proof, order), pubVecScVal(pub)],
  });
  const tx = new SDK.TransactionBuilder(source, { fee: '1000000', networkPassphrase: PASS })
    .addOperation(op).setTimeout(60).build();
  const sim = await RPC.simulateTransaction(tx);
  if (SDK.rpc.Api.isSimulationError(sim)) {
    console.log(`[${order}] SIM ERROR: ${String(sim.error).slice(0, 200)}`);
    continue;
  }
  let val;
  try { val = SDK.scValToNative(sim.result.retval); } catch (e) { val = `decode-err:${e.message}`; }
  const insns = sim.cost?.cpuInsns ?? sim.transactionData?.build()?.resources()?.instructions?.();
  console.log(`[${order}] verify_proof => ${val}  | cpuInsns=${insns}`);
}
