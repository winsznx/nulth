// Live contract-read layer + the proof-authorized submit flow. Real Soroban RPC, no mocks.
// Ported from the proven scripts/pay_p1.mjs (don't reinvent the crypto).
(function () {
  const SDK = window.StellarSdk;
  const C = window.COVENANT;
  const rpc = new SDK.rpc.Server(C.rpcUrl);
  const PASS = C.networkPassphrase;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // The ACTIVE account: the shared demo by default, or a user's self-served account. config.js
  // holds shared infra only — user accounts are dynamic and flow through here, never hardcoded.
  let _active = { account: C.account, secret: null };
  function setActive(account, secret) {
    _active = { account: account || C.account, secret: secret || null };
    if (window.CovenantProver) { if (_active.secret) window.CovenantProver.setSecret(_active.secret); else window.CovenantProver.useDemo(); }
  }
  function activeAccount() { return _active.account; }
  function isDemo() { return _active.account === C.account; }

  // Submit-only relayer (server-side fee-payer). Probed once from /api/health; when present the
  // browser needs no local fee-payer key — it proves, then hands the proof-signed auth entry to the
  // relayer, which pays the XLM fee and submits. The relayer cannot authorize a spend (the proof does).
  let _relay; // undefined = unprobed, null = none, { url, pubkey } = available
  async function relayerInfo() {
    if (_relay !== undefined) return _relay;
    try { const h = await fetch('/api/health', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)); _relay = (h && h.relayer) ? { url: '/api', pubkey: h.relayer } : null; }
    catch (e) { _relay = null; }
    return _relay;
  }

  function feePayerSecret() { return window.COVENANT_SECRET && window.COVENANT_SECRET.feePayer; }
  // A funded classic account used only as the source for read-only simulations.
  function readSourcePub() {
    const s = feePayerSecret();
    return s ? SDK.Keypair.fromSecret(s).publicKey() : C.demoPayee;
  }

  async function simRead(op) {
    const src = await rpc.getAccount(readSourcePub());
    const tx = new SDK.TransactionBuilder(src, { fee: '1000000', networkPassphrase: PASS }).addOperation(op).setTimeout(60).build();
    const sim = await rpc.simulateTransaction(tx);
    if (SDK.rpc.Api.isSimulationError(sim)) throw new Error(sim.error);
    return SDK.scValToNative(sim.result.retval);
  }

  const addr = (a) => SDK.nativeToScVal(a, { type: 'address' });

  async function sacBalance(account) {
    const op = SDK.Operation.invokeContractFunction({ contract: C.usdcSac, function: 'balance', args: [addr(account)] });
    const v = await simRead(op);
    return BigInt(v); // stroops (7 decimals)
  }

  async function destField(account) {
    const op = SDK.Operation.invokeContractFunction({ contract: C.account, function: 'dest_field', args: [addr(account)] });
    const v = await simRead(op);
    return BigInt(v).toString();
  }

  // read the account's instance storage: POL (commitment), ROOT (allowlist root), TOKEN, ADMIN, FROZEN
  async function readPolicy(account) {
    const acct = account || _active.account;
    const key = SDK.xdr.LedgerKey.contractData(new SDK.xdr.LedgerKeyContractData({
      contract: new SDK.Address(acct).toScAddress(),
      key: SDK.xdr.ScVal.scvLedgerKeyContractInstance(),
      durability: SDK.xdr.ContractDataDurability.persistent(),
    }));
    const res = await rpc.getLedgerEntries(key);
    const e = res.entries && res.entries[0];
    if (!e) return null;
    const data = typeof e.val.contractData === 'function' ? e.val : SDK.xdr.LedgerEntryData.fromXDR(e.xdr, 'base64');
    const storage = data.contractData().val().instance().storage() || [];
    const out = {};
    for (const me of storage) {
      const k = SDK.scValToNative(me.key());
      if (k === 'POL') out.commitment = BigInt(SDK.scValToNative(me.val())).toString();
      else if (k === 'ROOT') out.root = BigInt(SDK.scValToNative(me.val())).toString();
      else if (k === 'TOKEN') out.token = SDK.scValToNative(me.val());
      else if (k === 'ADMIN') out.admin = SDK.scValToNative(me.val());
      else if (k === 'FROZEN') out.frozen = SDK.scValToNative(me.val()) === true;
    }
    return out;
  }

  // best-effort recent on-chain activity: USDC SAC transfer events touching the active account
  async function recentActivity(limit) {
    const acct = _active.account;
    try {
      const latest = await rpc.getLatestLedger();
      // Two RPC quirks to respect: (1) the USDC SAC is a busy shared contract, so without a topic
      // filter getEvents returns the OLDEST events in the window and never reaches this account;
      // (2) the public RPC caps how many ledgers it scans per call, so a LARGE startLedger offset
      // silently misses the NEWEST events. ~6000 ledgers reliably includes recent activity.
      // transfer topics are [transfer, from, to, asset]; the 4th wildcard matches the asset segment.
      const startLedger = Math.max(1, latest.sequence - 6000);
      const xf = SDK.nativeToScVal('transfer', { type: 'symbol' }).toXDR('base64');
      const a = SDK.nativeToScVal(acct, { type: 'address' }).toXDR('base64');
      const res = await rpc.getEvents({ startLedger, filters: [{ type: 'contract', contractIds: [C.usdcSac], topics: [[xf, a, '*', '*'], [xf, '*', a, '*']] }], limit: 100 });
      const rows = [];
      for (const ev of res.events || []) {
        const topics = (ev.topic || []).map((t) => { try { return SDK.scValToNative(t); } catch { return null; } });
        if (topics[0] !== 'transfer') continue;
        const from = topics[1], to = topics[2];
        if (from !== acct && to !== acct) continue;
        let amount = null; try { amount = BigInt(SDK.scValToNative(ev.value)); } catch {}
        rows.push({ from, to, amount, dir: from === acct ? 'out' : 'in', tx: ev.txHash, ledger: ev.ledger });
      }
      return rows.reverse().slice(0, limit || 8);
    } catch (e) { return []; }
  }

  function transferOp(to, amountStroops, auth) {
    const o = { contract: C.usdcSac, function: 'transfer', args: [addr(_active.account), addr(to), SDK.nativeToScVal(BigInt(amountStroops), { type: 'i128' })] };
    if (auth) o.auth = auth;
    return SDK.Operation.invokeContractFunction(o);
  }

  // The end-to-end proof-authorized payment: browser proof -> token.transfer -> chain.
  async function pay(opts) {
    const step = opts.onStep || (() => {});
    const amountStroops = BigInt(opts.amountStroops);
    const destAddr = opts.destAddr;
    // relayer mode (server-side fee-payer) if available; else a local fee-payer key (dev).
    const relay = await relayerInfo();
    let kp = null, srcPub;
    if (relay && relay.pubkey) { srcPub = relay.pubkey; }
    else {
      const secret = opts.feePayerSecret || feePayerSecret();
      if (!secret) { const e = new Error('no_operator_key'); e.reason = 'no_operator_key'; throw e; }
      kp = SDK.Keypair.fromSecret(secret); srcPub = kp.publicKey();
    }

    step('reading dest_field');
    const df = await destField(destAddr);
    await window.CovenantProver.load();
    const pre = window.CovenantProver.precheck(amountStroops, df);
    if (!pre.ok) { const e = new Error('refused'); e.reason = pre.reason; throw e; } // no tx forms

    step('simulating');
    let src = await rpc.getAccount(srcPub);
    let tx = new SDK.TransactionBuilder(src, { fee: '1000000', networkPassphrase: PASS }).addOperation(transferOp(destAddr, amountStroops)).setTimeout(120).build();
    let sim = await rpc.simulateTransaction(tx);
    if (SDK.rpc.Api.isSimulationError(sim)) throw new Error('sim1: ' + sim.error);
    const entry = sim.result.auth.find((e) => {
      const c = e.credentials();
      return c.switch() === SDK.xdr.SorobanCredentialsType.sorobanCredentialsAddress() &&
        SDK.Address.fromScAddress(c.address().address()).toString() === _active.account;
    });
    if (!entry) throw new Error('no auth entry for covenant account');
    const exp = sim.latestLedger + 60;
    const nonce = BigInt(Date.now());
    entry.credentials().address().nonce(SDK.xdr.Int64.fromString(nonce.toString()));
    entry.credentials().address().signatureExpirationLedger(exp);

    const payload = window.CovenantSerialize.sorobanAuthPayload(entry, PASS);
    const { hi, lo } = window.CovenantSerialize.payloadHalves(payload);
    step('proving');
    const { proof, publicSignals, ms } = await window.CovenantProver.prove(amountStroops, df, hi, lo);
    entry.credentials().address().signature(window.CovenantSerialize.proofSigScVal(proof, publicSignals, 'c1c0'));

    // read-only sim of the signed tx to surface the verify cost (and validate the proof) either way
    src = await rpc.getAccount(srcPub);
    tx = new SDK.TransactionBuilder(src, { fee: '20000000', networkPassphrase: PASS }).addOperation(transferOp(destAddr, amountStroops, [entry])).setTimeout(120).build();
    sim = await rpc.simulateTransaction(tx);
    if (SDK.rpc.Api.isSimulationError(sim)) throw new Error('sim2: ' + sim.error);
    const declared = sim.transactionData.build().resources().instructions();

    if (relay && relay.pubkey) {
      step('relaying'); // hand the proof-signed auth entry to the server-side fee-payer
      const r = await fetch(relay.url + '/relay', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ account: _active.account, to: destAddr, amount: amountStroops.toString(), authEntryXdr: entry.toXDR('base64') }) }).then((x) => x.json());
      if (r.error) { if (r.error === 'rejected') { const e = new Error('refused'); e.reason = 'rejected'; e.code = r.code; throw e; } throw new Error(r.error + (r.detail ? ': ' + r.detail : '')); }
      return { hash: r.hash, status: r.status, proveMs: ms, declaredInstr: declared, nonce: nonce.toString() };
    }

    step('submitting');
    tx = SDK.rpc.assembleTransaction(tx, sim).build();
    tx.sign(kp);
    const res = await rpc.sendTransaction(tx);
    step('confirming');
    let final;
    for (let i = 0; i < 30; i++) { await sleep(2000); final = await rpc.getTransaction(res.hash); if (final.status !== 'NOT_FOUND') break; }
    return { hash: res.hash, status: final ? final.status : 'UNKNOWN', proveMs: ms, declaredInstr: declared, nonce: nonce.toString() };
  }

  // Tier-1 disclosure: verify the cap<=regulatory_max proof ON-CHAIN against the deployed
  // generic BN254 verifier (read-only simulation executes the real contract). Returns {ok, insns}.
  let _discVk = null;
  async function verifyDisclosure(proof, publicSignals) {
    if (!_discVk) _discVk = await fetch(C.discVk, { cache: 'no-store' }).then((r) => r.json());
    const S = window.CovenantSerialize;
    const op = SDK.Operation.invokeContractFunction({
      contract: C.verifier, function: 'verify_proof',
      args: [S.vkScVal(_discVk, 'c1c0'), S.proofScVal(proof, 'c1c0'), S.pubVecScVal(publicSignals)],
    });
    const src = await rpc.getAccount(readSourcePub());
    const tx = new SDK.TransactionBuilder(src, { fee: '1000000', networkPassphrase: PASS }).addOperation(op).setTimeout(60).build();
    const sim = await rpc.simulateTransaction(tx);
    if (SDK.rpc.Api.isSimulationError(sim)) throw new Error('verify sim: ' + sim.error);
    let insns = null; try { insns = sim.transactionData.build().resources().instructions(); } catch {}
    return { ok: SDK.scValToNative(sim.result.retval) === true, insns };
  }

  // ---- governance (admin) ----
  // The admin is the DISCLOSED governance key: it can rotate the committed policy and
  // freeze/unfreeze, but CANNOT move funds. The admin signs as the transaction source,
  // so the contract's admin.require_auth() is satisfied by SOURCE_ACCOUNT credentials
  // (the envelope signature) — no Soroban auth-entry signing needed.
  function adminSecret() { return window.COVENANT_SECRET && window.COVENANT_SECRET.admin; }

  // Admin governance on the ACTIVE account. Demo account: signed by the embedded admin-key
  // (secrets.local.js). User account: signed by the connected Freighter wallet (the user is admin).
  async function adminInvoke(fnName, args) {
    const op = SDK.Operation.invokeContractFunction({ contract: _active.account, function: fnName, args: args || [] });
    const demo = isDemo();
    const kp = demo ? (adminSecret() ? SDK.Keypair.fromSecret(adminSecret()) : null) : null;
    if (demo && !kp) { const e = new Error('no_admin_key'); e.reason = 'no_admin_key'; throw e; }
    const sourcePub = demo ? kp.publicKey() : await window.CovenantWallet.getAddress();
    let src = await rpc.getAccount(sourcePub);
    let tx = new SDK.TransactionBuilder(src, { fee: '2000000', networkPassphrase: PASS }).addOperation(op).setTimeout(120).build();
    const sim = await rpc.simulateTransaction(tx);
    if (SDK.rpc.Api.isSimulationError(sim)) throw new Error(fnName + ' sim: ' + sim.error);
    tx = SDK.rpc.assembleTransaction(tx, sim).build();
    tx = demo ? (tx.sign(kp), tx) : await window.CovenantWallet.sign(tx);
    const res = await rpc.sendTransaction(tx);
    let final;
    for (let i = 0; i < 30; i++) { await sleep(2000); final = await rpc.getTransaction(res.hash); if (final.status !== 'NOT_FOUND') break; }
    return { hash: res.hash, status: final ? final.status : 'UNKNOWN' };
  }

  const adminFreeze = () => adminInvoke('freeze', []);
  const adminUnfreeze = () => adminInvoke('unfreeze', []);
  const adminRotate = (commitment, root) => adminInvoke('rotate_policy', [
    window.CovenantSerialize.u256ScVal(commitment), window.CovenantSerialize.u256ScVal(root),
  ]);

  // ---- in-app testnet funding (real on-chain, no mocks) ----
  function operatorPub() { const s = feePayerSecret(); return s ? SDK.Keypair.fromSecret(s).publicKey() : null; }

  // Real public friendbot: fund a classic G-account with testnet XLM (fees). Idempotent-ish —
  // an already-funded account returns a createAccount "already exists" error we surface as 'already'.
  async function friendbotFund(pub) {
    if (!/^G[A-Z2-7]{55}$/.test(pub || '')) { const e = new Error('bad_addr'); e.reason = 'bad_addr'; throw e; }
    let res;
    try { res = await fetch(C.friendbotUrl + '/?addr=' + encodeURIComponent(pub)); }
    catch (e) { const er = new Error('friendbot_unreachable'); er.reason = 'friendbot_unreachable'; throw er; }
    const body = await res.json().catch(() => ({}));
    if (res.ok) return { status: 'funded', hash: body.hash || body.id || null };
    const msg = JSON.stringify(body || {});
    if (/op_already_exists|already.*funded|account.*exist|createAccountAlreadyExist/i.test(msg) || res.status === 400) {
      return { status: 'already', hash: null };
    }
    if (res.status === 429) { const e = new Error('rate_limited'); e.reason = 'rate_limited'; throw e; }
    const e = new Error('friendbot_failed'); e.reason = 'friendbot_failed'; e.detail = msg; throw e;
  }

  // Operator seeds testnet USDC into a freshly-created Covenant account so a stranger can pay
  // immediately. The operator (a classic G-account that holds USDC) is the SAC transfer `from`
  // AND the tx source, so transfer's from.require_auth() is satisfied by the envelope signature.
  // (Same shape as scripts/create_user.mjs's seeder transfer.)
  async function seedUsdc(toAccount, amountStroops) {
    const secret = feePayerSecret();
    if (!secret) { const e = new Error('no_operator_key'); e.reason = 'no_operator_key'; throw e; }
    const kp = SDK.Keypair.fromSecret(secret);
    const op = SDK.Operation.invokeContractFunction({
      contract: C.usdcSac, function: 'transfer',
      args: [addr(kp.publicKey()), addr(toAccount), SDK.nativeToScVal(BigInt(amountStroops), { type: 'i128' })],
    });
    let src = await rpc.getAccount(kp.publicKey());
    let tx = new SDK.TransactionBuilder(src, { fee: '2000000', networkPassphrase: PASS }).addOperation(op).setTimeout(120).build();
    const sim = await rpc.simulateTransaction(tx);
    if (SDK.rpc.Api.isSimulationError(sim)) throw new Error('seed sim: ' + sim.error);
    tx = SDK.rpc.assembleTransaction(tx, sim).build();
    tx.sign(kp);
    const res = await rpc.sendTransaction(tx);
    let final;
    for (let i = 0; i < 30; i++) { await sleep(2000); final = await rpc.getTransaction(res.hash); if (final.status !== 'NOT_FOUND') break; }
    return { hash: res.hash, status: final ? final.status : 'UNKNOWN' };
  }

  // operator's own testnet USDC balance (so the UI can tell whether it can seed)
  async function operatorUsdc() { const p = operatorPub(); if (!p) return null; try { return await sacBalance(p); } catch { return null; } }

  // waitlist capture -> the durable server-side sink (POST /api/waitlist). Throws on any failure so the
  // UI never shows a false "you're on the list" — success means the server actually persisted the lead.
  async function submitWaitlist(email) {
    let r;
    try { r = await fetch('/api/waitlist', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, ref: C.network }) }); }
    catch (e) { const err = new Error('unreachable'); err.reason = 'unreachable'; throw err; }
    let j = null; try { j = await r.json(); } catch (e) {}
    if (!r.ok || !(j && j.ok === true)) { const err = new Error((j && j.error) || ('http_' + r.status)); err.reason = (j && j.error) || 'failed'; throw err; }
    return j;
  }

  // Exploitation Deck submit: the browser crafts the malformed proof + auth entry; the relayer only
  // pays the fee and submits past simulation. The relayer CANNOT authorize a spend (no valid proof),
  // so this is safe — every attack lands as a real REJECTED tx on-chain.
  async function submitAttack(body) {
    const r = await fetch('/api/attack', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((x) => x.json());
    if (r.error) throw new Error(r.error + (r.detail ? ': ' + r.detail : ''));
    return r;
  }

  window.CovenantChain = {
    rpc,
    hasOperatorKey: () => !!feePayerSecret() || !!(_relay && _relay.pubkey),
    hasSeedKey: () => !!feePayerSecret(), // seeding needs a LOCAL operator key; the relayer only relays proof-signed transfers
    hasRelayer: () => !!(_relay && _relay.pubkey),
    relayerInfo,
    hasAdminKey: () => !!adminSecret(),
    adminPublicKey: () => { const s = adminSecret(); return s ? SDK.Keypair.fromSecret(s).publicKey() : null; },
    setActive, activeAccount, isDemo,
    sacBalance, destField, readPolicy, recentActivity, pay, verifyDisclosure,
    adminFreeze, adminUnfreeze, adminRotate,
    operatorPub, operatorUsdc, friendbotFund, seedUsdc, submitWaitlist, submitAttack,
    fmtUsdc: (stroops) => (Number(stroops) / 1e7).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
  };
  // probe the relayer once; refresh the UI (enables the pay flow) when one is present
  relayerInfo().then((r) => { if (r && r.pubkey && window.App && typeof window.App.render === 'function') window.App.render(); });
})();
