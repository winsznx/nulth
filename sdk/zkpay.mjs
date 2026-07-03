// Execute a SAC transfer FROM the ZK policy account, authorized ONLY by a Groth16 proof.
import * as SDK from '@stellar/stellar-sdk';
import fs from 'fs';

const RPC = new SDK.rpc.Server('https://soroban-testnet.stellar.org');
const PASS = SDK.Networks.TESTNET;

const ACC = 'CDT426OZ2NFYFDDVMHZNKVMXCLZXBAR652DTR5DLS4UBGKOONEQDCFCN'; // zk account
const SAC = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC'; // XLM SAC
const PAYEE = 'GBSEFJUBG2EDXLOMGGK7AF6MDPH7AIJNHIA5B23QENSIIVQE2IYRSASK';
const AMOUNT = BigInt(process.env.AMT || '10000000');

// submitter (fee payer) - por-demo key
const SECRET = process.env.SECRET;
const submitter = SDK.Keypair.fromSecret(SECRET);

const proof = JSON.parse(fs.readFileSync(process.env.PROOF || 'build/cli_proof_ok.json'));
const pub = JSON.parse(fs.readFileSync(process.env.PUB || 'build/cli_pub_ok.json'));

const hexBytes = (h) => Buffer.from(h, 'hex');
const u256 = (dec) => {
  // build ScVal U256 from decimal string
  let v = BigInt(dec);
  const parts = [];
  for (let i = 0; i < 4; i++) { parts.push(v & ((1n<<64n)-1n)); v >>= 64n; }
  // parts[0]=lo_lo ... parts[3]=hi_hi
  return SDK.xdr.ScVal.scvU256(new SDK.xdr.UInt256Parts({
    hiHi: new SDK.xdr.Uint64(parts[3]),
    hiLo: new SDK.xdr.Uint64(parts[2]),
    loHi: new SDK.xdr.Uint64(parts[1]),
    loLo: new SDK.xdr.Uint64(parts[0]),
  }));
};

// ProofSig struct as ScVal map (field order must be alphabetical-ish per contracttype: a,b,c,pub_signals)
const proofSig = SDK.xdr.ScVal.scvMap([
  new SDK.xdr.ScMapEntry({ key: SDK.xdr.ScVal.scvSymbol('a'), val: SDK.xdr.ScVal.scvBytes(hexBytes(proof.a)) }),
  new SDK.xdr.ScMapEntry({ key: SDK.xdr.ScVal.scvSymbol('b'), val: SDK.xdr.ScVal.scvBytes(hexBytes(proof.b)) }),
  new SDK.xdr.ScMapEntry({ key: SDK.xdr.ScVal.scvSymbol('c'), val: SDK.xdr.ScVal.scvBytes(hexBytes(proof.c)) }),
  new SDK.xdr.ScMapEntry({ key: SDK.xdr.ScVal.scvSymbol('pub_signals'), val: SDK.xdr.ScVal.scvVec(pub.map(u256)) }),
]);

const source = await RPC.getAccount(submitter.publicKey());

const op = SDK.Operation.invokeContractFunction({
  contract: SAC,
  function: 'transfer',
  args: [
    SDK.nativeToScVal(ACC, { type: 'address' }),
    SDK.nativeToScVal(PAYEE, { type: 'address' }),
    SDK.nativeToScVal(AMOUNT, { type: 'i128' }),
  ],
});

let tx = new SDK.TransactionBuilder(source, { fee: '1000000', networkPassphrase: PASS })
  .addOperation(op).setTimeout(120).build();

// simulate to get the auth entries
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
      // set our ProofSig as the signature + expiration
      cred.address().signatureExpirationLedger(lastLedger);
      cred.address().signature(proofSig);
      signedAuth.push(entry);
      console.log('attached ProofSig to auth entry for', addr);
      continue;
    }
  }
  signedAuth.push(entry);
}

// rebuild op with signed auth
const op2 = SDK.Operation.invokeContractFunction({
  contract: SAC, function: 'transfer',
  args: op.body().invokeHostFunctionOp().hostFunction().invokeContract().args(),
  auth: signedAuth,
});
const source2 = await RPC.getAccount(submitter.publicKey());
tx = new SDK.TransactionBuilder(source2, { fee: '10000000', networkPassphrase: PASS })
  .addOperation(op2).setTimeout(120).build();

sim = await RPC.simulateTransaction(tx);
if (SDK.rpc.Api.isSimulationError(sim)) { console.error('SIM2 ERROR', sim.error); process.exit(1); }
console.log('sim2 ok. cpu instructions:', sim.cost?.cpuInsns ?? sim.transactionData?.build()?.resources()?.instructions());

tx = SDK.rpc.assembleTransaction(tx, sim).build();
tx.sign(submitter);
const res = await RPC.sendTransaction(tx);
console.log('send status:', res.status, 'hash:', res.hash);
let tries = 0, final;
while (tries++ < 30) {
  await new Promise(r => setTimeout(r, 2000));
  final = await RPC.getTransaction(res.hash);
  if (final.status !== 'NOT_FOUND') break;
}
console.log('final status:', final.status);
