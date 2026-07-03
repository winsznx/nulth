// Client-side DEPTH-16 prover. Works for the shared demo policy AND any self-served user policy —
// the secret (cap/salt/allowlist path) NEVER leaves the browser; only the proof + 6 public signals
// go on-chain. setSecret() points it at a user's keystore; useDemo() restores the demo policy.
(function () {
  const C = window.COVENANT;
  let _demo = null;      // the shared demo policy (lazy-fetched)
  let _override = null;  // an active user keystore (set by CovenantChain.setActive)

  async function load() {
    if (_override) return _override;
    if (_demo) return _demo;
    _demo = await fetch(C.policySecretUrl, { cache: 'no-store' }).then((r) => {
      if (!r.ok) throw new Error('policy secret not available (' + r.status + ')');
      return r.json();
    });
    return _demo;
  }
  function setSecret(s) { _override = s; }
  function useDemo() { _override = null; }
  function cur() { return _override || _demo; }
  // the shared demo policy, ignoring any active user override (the Exploitation Deck always
  // attacks the shared reference account, regardless of which account the user is operating).
  async function loadDemo() {
    if (!_demo) _demo = await fetch(C.policySecretUrl, { cache: 'no-store' }).then((r) => { if (!r.ok) throw new Error('policy secret not available (' + r.status + ')'); return r.json(); });
    return _demo;
  }

  // ---- Web Worker proving (off the main thread) with a safe inline fallback ----
  let _worker = null, _seq = 0, _workerBroken = false;
  function getWorker() {
    if (_workerBroken) return null;
    if (_worker) return _worker;
    try { _worker = new Worker('lib/prover-worker.js'); _worker.onerror = () => { _workerBroken = true; _worker = null; }; return _worker; }
    catch (e) { _workerBroken = true; return null; }
  }
  function proveViaWorker(input, wasmAbs, zkeyAbs, timeoutMs) {
    return new Promise((resolve, reject) => {
      const w = getWorker();
      if (!w) return reject(new Error('no_worker'));
      const id = ++_seq;
      const to = setTimeout(() => { cleanup(); _workerBroken = true; try { w.terminate(); } catch (e) {} _worker = null; reject(new Error('prove_timeout')); }, timeoutMs || 120000);
      function cleanup() { clearTimeout(to); w.removeEventListener('message', onMsg); }
      function onMsg(e) { if (!e.data || e.data.id !== id) return; cleanup(); e.data.ok ? resolve({ proof: e.data.proof, publicSignals: e.data.publicSignals }) : reject(new Error(e.data.error || 'worker_error')); }
      w.addEventListener('message', onMsg);
      w.postMessage({ id, input, wasm: wasmAbs, zkey: zkeyAbs });
    });
  }
  // Prove in the worker; fall back to inline snarkjs only when the worker is *unavailable* (not on a
  // genuine slow/hang/abort, which would just re-fail). Callers translate a throw into an honest message.
  async function fullProve(input, wasmUrl, zkeyUrl) {
    const abs = (u) => { try { return new URL(u, location.href).href; } catch (e) { return u; } };
    try { return await proveViaWorker(input, abs(wasmUrl), abs(zkeyUrl)); }
    catch (e) {
      if (e.message === 'no_worker') return await snarkjs.groth16.fullProve(input, wasmUrl, zkeyUrl);
      throw e;
    }
  }

  // Select the allowlist member matching destField. Supports a user keystore (members[]) and the
  // flat demo secret (single destLeaf/path). Returns null if destField is not in the allowlist.
  function pick(s, destField) {
    if (!s) return null;
    if (Array.isArray(s.members)) return s.members.find((m) => BigInt(m.destLeaf) === BigInt(destField)) || null;
    return BigInt(s.destLeaf) === BigInt(destField) ? { destLeaf: s.destLeaf, path: s.path, index_bits: s.index_bits } : null;
  }

  // Whether a valid proof can exist for (amount, destField) under the active policy.
  function precheck(amountStroops, destField) {
    const s = cur();
    if (!s) throw new Error('prover not loaded');
    if (!pick(s, destField)) return { ok: false, reason: 'not_allowlisted' };
    if (BigInt(amountStroops) > BigInt(s.cap)) return { ok: false, reason: 'over_cap' };
    return { ok: true };
  }

  async function prove(amountStroops, destField, sigHi, sigLo) {
    await load();
    // pre-empt out-of-policy BEFORE proving — no witness attempt, no tx, no double-run
    const pre = precheck(amountStroops, destField);
    if (!pre.ok) { const e = new Error('refused'); e.reason = pre.reason; throw e; }
    const s = cur(); const m = pick(s, destField);
    const input = {
      amount: String(amountStroops), dest: String(destField),
      policy_commitment: s.commitment, allowlist_root: s.root,
      sigpayload_hi: sigHi, sigpayload_lo: sigLo,
      cap: s.cap, salt: s.salt, path: m.path, index_bits: m.index_bits,
    };
    const t0 = performance.now();
    let out;
    try { out = await fullProve(input, C.proverWasm, C.proverZkey); }
    catch (e) { const err = new Error('prove_failed'); err.reason = 'prove_failed'; err.detail = String((e && e.message) || e); throw err; }
    return { proof: out.proof, publicSignals: out.publicSignals, ms: Math.round(performance.now() - t0) };
  }

  // Tier-1 disclosure: prove the hidden cap (committed in `commitment`) <= regulatory_max.
  async function proveDisclosure(commitment, regMaxStroops) {
    await load();
    const s = cur();
    // pre-empt the unsatisfiable case (cap > limit) BEFORE proving — no witness attempt, no double-run
    if (BigInt(regMaxStroops) < BigInt(s.cap)) { const e = new Error('cannot_prove'); e.reason = 'cap_exceeds_limit'; throw e; }
    const input = { policy_commitment: commitment, regulatory_max: String(regMaxStroops), cap: s.cap, salt: s.salt };
    const t0 = performance.now();
    let out;
    try { out = await fullProve(input, C.discWasm, C.discZkey); }
    catch (e) { const err = new Error('prove_failed'); err.reason = 'prove_failed'; err.detail = String((e && e.message) || e); throw err; }
    return { proof: out.proof, publicSignals: out.publicSignals, ms: Math.round(performance.now() - t0) };
  }

  // low-level: run the policy circuit on an arbitrary input (Exploitation Deck). Demo policy only.
  async function raw(input) { await load(); return fullProve(input, C.proverWasm, C.proverZkey); }

  window.CovenantProver = {
    load, loadDemo, precheck, prove, proveDisclosure, raw, setSecret, useDemo,
    get cap() { return cur() && cur().cap; },
    get loaded() { return !!cur(); },
  };
})();
