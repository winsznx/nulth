// Re-seed the Nulth demo account with USDC by recycling funds from the demo payee
// (every demo payout moved USDC account -> payee; this sends it back). Read-only unless DO=1.
// Usage: PAYEE_SECRET=$(stellar keys show payee-key) [DO=1] [AMT=<stroops>] node scripts/reseed_demo.mjs
import * as SDK from '@stellar/stellar-sdk';

const RPC = new SDK.rpc.Server('https://soroban-testnet.stellar.org');
const PASS = SDK.Networks.TESTNET;
const SAC = 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA';
const ACCOUNT = 'CANA5QYVHNON7AV752ZRATFW2T5BMS3MU5DDPJMU5UGSR3KSH45LOGZE';
const payee = SDK.Keypair.fromSecret(process.env.PAYEE_SECRET);
const u = (s) => Number(s) / 1e7;

async function balanceOf(addr) {
  const acct = await RPC.getAccount(payee.publicKey());
  const op = SDK.Operation.invokeContractFunction({ contract: SAC, function: 'balance',
    args: [SDK.nativeToScVal(addr, { type: 'address' })] });
  const tx = new SDK.TransactionBuilder(acct, { fee: '1000000', networkPassphrase: PASS })
    .addOperation(op).setTimeout(60).build();
  const sim = await RPC.simulateTransaction(tx);
  if (SDK.rpc.Api.isSimulationError(sim)) throw new Error('bal sim: ' + sim.error);
  return BigInt(SDK.scValToNative(sim.result.retval).toString());
}

const balAcct = await balanceOf(ACCOUNT);
const balPayee = await balanceOf(payee.publicKey());
console.log('demo account (CANA5QYV) USDC:', balAcct.toString(), '=', u(balAcct));
console.log('payee       (GBEOVHEZ) USDC:', balPayee.toString(), '=', u(balPayee));

if (process.env.DO === '1') {
  // default: send back everything the payee holds, leaving the payee at 0 (it only exists to receive demo pays)
  const AMT = BigInt(process.env.AMT || balPayee.toString());
  if (AMT <= 0n) { console.log('nothing to send'); process.exit(0); }
  const op = SDK.Operation.invokeContractFunction({ contract: SAC, function: 'transfer', args: [
    SDK.nativeToScVal(payee.publicKey(), { type: 'address' }),
    SDK.nativeToScVal(ACCOUNT, { type: 'address' }),
    SDK.nativeToScVal(AMT, { type: 'i128' }) ] });
  const acct = await RPC.getAccount(payee.publicKey());
  let tx = new SDK.TransactionBuilder(acct, { fee: '1000000', networkPassphrase: PASS })
    .addOperation(op).setTimeout(120).build();
  const sim = await RPC.simulateTransaction(tx);
  if (SDK.rpc.Api.isSimulationError(sim)) throw new Error('transfer sim: ' + sim.error);
  tx = SDK.rpc.assembleTransaction(tx, sim).build();
  tx.sign(payee);
  const send = await RPC.sendTransaction(tx);
  console.log('submit:', send.status, send.hash);
  let final = send.status;
  for (let i = 0; i < 30; i++) { await new Promise(r => setTimeout(r, 2000));
    const g = await RPC.getTransaction(send.hash);
    if (g.status !== 'NOT_FOUND') { final = g.status; break; } }
  console.log('final:', final, '| tx:', send.hash);
  console.log('demo account NOW:', u(await balanceOf(ACCOUNT)), 'USDC');
}
