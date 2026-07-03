// Initialize the Covenant account: store vk + policy_commitment + allowlist_root.
import * as SDK from '@stellar/stellar-sdk';
import fs from 'fs';
import { vkScVal, u256ScVal } from './lib.mjs';

const RPC = new SDK.rpc.Server('https://soroban-testnet.stellar.org');
const PASS = SDK.Networks.TESTNET;
const ACCOUNT = process.env.ACCOUNT;
const kp = SDK.Keypair.fromSecret(process.env.SECRET);
const vk = JSON.parse(fs.readFileSync('/Users/mac/covenant/circuits/build/verification_key.json'));
const pub = JSON.parse(fs.readFileSync('/Users/mac/covenant/circuits/build/policy_public.json'));

const source = await RPC.getAccount(kp.publicKey());
const op = SDK.Operation.invokeContractFunction({
  contract: ACCOUNT,
  function: 'init',
  args: [vkScVal(vk, 'c1c0'), u256ScVal(pub.policy_commitment), u256ScVal(pub.allowlist_root)],
});
let tx = new SDK.TransactionBuilder(source, { fee: '2000000', networkPassphrase: PASS })
  .addOperation(op).setTimeout(120).build();
let sim = await RPC.simulateTransaction(tx);
if (SDK.rpc.Api.isSimulationError(sim)) { console.error('SIM ERROR:', sim.error); process.exit(1); }
tx = SDK.rpc.assembleTransaction(tx, sim).build();
tx.sign(kp);
const res = await RPC.sendTransaction(tx);
console.log('send status:', res.status, 'hash:', res.hash);
let final;
for (let i = 0; i < 30; i++) {
  await new Promise((r) => setTimeout(r, 2000));
  final = await RPC.getTransaction(res.hash);
  if (final.status !== 'NOT_FOUND') break;
}
console.log('final status:', final.status, 'hash:', res.hash);
process.exit(final.status === 'SUCCESS' ? 0 : 2);
