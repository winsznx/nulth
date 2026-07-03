// Replay confirm (a): resubmit the EXACT same signed auth entry (same nonce).
// Soroban must reject it — the (address, nonce) pair was consumed by the first apply.
import * as SDK from '@stellar/stellar-sdk';
const RPC = new SDK.rpc.Server('https://soroban-testnet.stellar.org');
const PASS = SDK.Networks.TESTNET;
const { ACC, SAC, PAYEE, AUTH_XDR } = process.env;
const AMT = BigInt(process.env.AMT || '10000000');
const submitter = SDK.Keypair.fromSecret(process.env.SECRET);

const entry = SDK.xdr.SorobanAuthorizationEntry.fromXDR(AUTH_XDR, 'base64');
const op = SDK.Operation.invokeContractFunction({
  contract: SAC, function: 'transfer',
  args: [SDK.nativeToScVal(ACC, { type: 'address' }), SDK.nativeToScVal(PAYEE, { type: 'address' }), SDK.nativeToScVal(AMT, { type: 'i128' })],
  auth: [entry],
});
const source = await RPC.getAccount(submitter.publicKey());
let tx = new SDK.TransactionBuilder(source, { fee: '20000000', networkPassphrase: PASS }).addOperation(op).setTimeout(120).build();
let sim = await RPC.simulateTransaction(tx);
if (SDK.rpc.Api.isSimulationError(sim)) {
  console.log('REPLAY rejected at SIMULATION (nonce already consumed):');
  console.log(String(sim.error).split('\n').slice(0, 3).join(' | '));
  process.exit(0);
}
// sim passed -> try to actually apply; the host nonce check should reject at apply
tx = SDK.rpc.assembleTransaction(tx, sim).build();
tx.sign(submitter);
const res = await RPC.sendTransaction(tx);
console.log('replay send status:', res.status, res.errorResult ? JSON.stringify(res.errorResult) : '');
let final;
for (let i = 0; i < 20; i++) { await new Promise((r) => setTimeout(r, 2000)); final = await RPC.getTransaction(res.hash); if (final.status !== 'NOT_FOUND') break; }
console.log('replay final status:', final.status, 'hash:', res.hash);
console.log(final.status === 'SUCCESS' ? 'UNEXPECTED: replay succeeded' : 'EXPECTED: replay rejected by host');
