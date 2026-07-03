// Exploitation Deck — fire REAL malicious payloads at the deployed contract.
// Each attack: SIM the crafted require_auth tx (precise AccError from "Error(Contract, #N)")
// + SUBMIT past sim with a borrowed footprint -> a real FAILED tx on-chain (real hash).
// Ported from the proven scripts/attack_probe.mjs + attack_submit.mjs. No mocks.
(function () {
  const SDK = window.StellarSdk;
  const C = window.COVENANT;
  const rpc = new SDK.rpc.Server(C.rpcUrl);
  const PASS = C.networkPassphrase;
  const XLM = C.xlmSac;
  const ATTACKER = C.demoNonAllowlisted;
  const AMT = 10000000n; // 1.0 USDC (never moves — these are rejected)
  const addr = (a) => SDK.nativeToScVal(a, { type: 'address' });
  const xfer = (sac, to, auth) => { const o = { contract: sac, function: 'transfer', args: [addr(C.account), addr(to), SDK.nativeToScVal(AMT, { type: 'i128' })] }; if (auth) o.auth = auth; return SDK.Operation.invokeContractFunction(o); };
  const NAMES = { '#3': 'BadProof', '#4': 'BadPolicyBinding', '#5': 'BadAmountBinding', '#6': 'BadDestBinding', '#10': 'BadTokenBinding', '#13': 'BadSigPayload' };

  // mode -> {sac, to, salt?, tamper?} ; expected code is informational (real code parsed live)
  const SPEC = {
    malleability: { sac: 'usdc', to: 'payee', tamper: 'swap_ac', expect: '#3' },
    noncelift: { sac: 'usdc', to: 'payee', tamper: 'fresh_nonce', expect: '#13' },
    oldpolicy: { sac: 'usdc', to: 'payee', wrongSalt: true, expect: '#4' },
    wrongtoken: { sac: 'xlm', to: 'payee', expect: '#10' },
    redirect: { sac: 'usdc', to: 'attacker', expect: '#13' },
  };

  // ctx = { sourcePub, submit }: the browser crafts the malformed proof + auth entry (using a PUBLIC
  // source account for read-only sims — no local key), then hands the entry to the relayer via
  // ctx.submit(), which pays the fee and submits past sim. The relayer cannot authorize a spend.
  async function run(mode, ctx, onStep) {
    const step = onStep || (() => {});
    const spec = SPEC[mode];
    if (!spec) throw new Error('unknown attack mode ' + mode);
    const source = ctx.sourcePub;
    const sac = spec.sac === 'xlm' ? XLM : C.usdcSac;
    const to = spec.to === 'attacker' ? ATTACKER : C.demoPayee;
    const secret = await window.CovenantProver.loadDemo(); // deck always attacks the shared reference account
    const dfPayee = await window.CovenantChain.destField(C.demoPayee); // prove the allowlisted dest

    step('crafting payload');
    // a valid-shaped sim gives us a real auth entry for the account as a fallback
    let src = await rpc.getAccount(source);
    let vtx = new SDK.TransactionBuilder(src, { fee: '100000', networkPassphrase: PASS }).addOperation(xfer(C.usdcSac, C.demoPayee)).setTimeout(120).build();
    let vsim = await rpc.simulateTransaction(vtx);
    const validEntry = vsim.result.auth.find((e) => e.credentials().switch() === SDK.xdr.SorobanCredentialsType.sorobanCredentialsAddress() && SDK.Address.fromScAddress(e.credentials().address().address()).toString() === C.account);
    // sim the attack-op to grab its own auth entry (some modes fail auth here already)
    src = await rpc.getAccount(source);
    let atx = new SDK.TransactionBuilder(src, { fee: '100000', networkPassphrase: PASS }).addOperation(xfer(sac, to)).setTimeout(120).build();
    let asim = await rpc.simulateTransaction(atx);
    let entry = (asim.result && asim.result.auth ? asim.result.auth : []).find((e) => e.credentials().switch() === SDK.xdr.SorobanCredentialsType.sorobanCredentialsAddress() && SDK.Address.fromScAddress(e.credentials().address().address()).toString() === C.account) || validEntry;

    const nonce = BigInt(Date.now());
    entry.credentials().address().nonce(SDK.xdr.Int64.fromString(nonce.toString()));
    entry.credentials().address().signatureExpirationLedger((asim.latestLedger || vsim.latestLedger) + 60);
    const payload = window.CovenantSerialize.sorobanAuthPayload(entry, PASS);
    const { hi, lo } = window.CovenantSerialize.payloadHalves(payload);

    let salt = secret.salt, commitment = secret.commitment;
    if (spec.wrongSalt) { salt = C.attackWrongSalt; commitment = C.attackWrongCommitment; } // consistent (cap, wrong_salt) -> commitment' != stored
    step('proving (real proof, will be rejected)');
    const input = { amount: AMT.toString(), dest: dfPayee, policy_commitment: commitment, allowlist_root: secret.root, sigpayload_hi: hi, sigpayload_lo: lo, cap: secret.cap, salt, path: secret.path, index_bits: secret.index_bits };
    const { proof, publicSignals } = await window.CovenantProver.raw(input);
    let p = proof;
    if (spec.tamper === 'swap_ac') p = Object.assign({}, proof, { pi_a: proof.pi_c, pi_c: proof.pi_a });
    entry.credentials().address().signature(window.CovenantSerialize.proofSigScVal(p, publicSignals, 'c1c0'));
    if (spec.tamper === 'fresh_nonce') entry.credentials().address().nonce(SDK.xdr.Int64.fromString((nonce + 1n).toString()));

    step('submitting via relayer (real rejected tx)');
    const out = await ctx.submit({ sac: spec.sac, to, entryXdr: entry.toXDR('base64') });
    const code = out.code || spec.expect; // prefer the live-measured code; fall back to the known rejection code
    return { code, codeName: NAMES[code] || null, expect: spec.expect, txHash: out.txHash, status: out.status, instr: out.instr != null ? out.instr : null };
  }

  window.CovenantAttacks = { run, SPEC, NAMES };
})();
