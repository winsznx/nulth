// De-risk Tier-1 disclosure: prove cap<=regulatory_max in ZK, verify it ON-CHAIN against the
// deployed generic BN254 verifier (new vk), and confirm cap>max cannot be proven (witness abort).
import * as SDK from '@stellar/stellar-sdk';
import fs from 'fs';
import { createRequire } from 'module';
import { vkScVal, proofScVal, pubVecScVal } from './lib.mjs';
const require = createRequire(import.meta.url);
const snarkjs = require('/Users/mac/covenant/circuits/node_modules/snarkjs');

const RPC = new SDK.rpc.Server('https://soroban-testnet.stellar.org');
const PASS = SDK.Networks.TESTNET;
const VERIFIER = 'CCKBPVP7MZJOQYU44RK5MG4PA2YKV4UQ7CJMPK3OIHNFHLG5PEMNDREG';
const B = '/Users/mac/covenant';
const secret = JSON.parse(fs.readFileSync(`${B}/build/policy_secret.json`));
const vk = JSON.parse(fs.readFileSync(`${B}/circuits/build/disclosure_vk.json`));
const wasm = `${B}/circuits/build/disclosure_js/disclosure.wasm`, zkey = `${B}/circuits/build/disclosure_final.zkey`;
const kp = SDK.Keypair.fromSecret(process.env.SECRET);

const prove = (regMax) => snarkjs.groth16.fullProve({ policy_commitment: secret.commitment, regulatory_max: String(regMax), cap: secret.cap, salt: secret.salt }, wasm, zkey);
const verifyOp = (proof, pub) => SDK.Operation.invokeContractFunction({ contract: VERIFIER, function: 'verify_proof', args: [vkScVal(vk, 'c1c0'), proofScVal(proof, 'c1c0'), pubVecScVal(pub)] });

console.log('cap (hidden) =', (Number(secret.cap) / 1e7), 'USDC');
console.log('=== compliant: cap <= regulatory_max (500 USDC) ===');
const { proof, publicSignals } = await prove('5000000000');
console.log('publicSignals [commitment, regMax]:', publicSignals.map((s) => s.slice(0, 12) + '…'));
console.log('off-chain verify:', await snarkjs.groth16.verify(vk, publicSignals, proof));

let src = await RPC.getAccount(kp.publicKey());
let tx = new SDK.TransactionBuilder(src, { fee: '1000000', networkPassphrase: PASS }).addOperation(verifyOp(proof, publicSignals)).setTimeout(60).build();
let sim = await RPC.simulateTransaction(tx);
if (SDK.rpc.Api.isSimulationError(sim)) { console.log('SIM ERROR:', String(sim.error).slice(0, 160)); }
else { console.log('ON-CHAIN verify_proof (sim) =>', SDK.scValToNative(sim.result.retval), '| insns', sim.transactionData.build().resources().instructions()); }

// land a settled on-chain verification for evidence
tx = SDK.rpc.assembleTransaction(tx, sim).build(); tx.sign(kp);
const res = await RPC.sendTransaction(tx);
let final; for (let i = 0; i < 30; i++) { await new Promise((r) => setTimeout(r, 2000)); final = await RPC.getTransaction(res.hash); if (final.status !== 'NOT_FOUND') break; }
console.log('SETTLED verify tx:', res.hash, '·', final.status);

console.log('=== non-compliant: cap > regulatory_max (5 USDC) ===');
try { await prove('50000000'); console.log('UNEXPECTED: a proof was generated'); }
catch (e) { console.log('witness abort — operator CANNOT prove compliance with a limit below the cap (correct)'); }
process.exit(0);
