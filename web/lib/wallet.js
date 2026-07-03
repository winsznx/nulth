// Freighter wallet adapter — uses the official @stellar/freighter-api v6 (vendored UMD in
// lib/freighter-api.js), which talks to the extension over its postMessage bridge (the modern
// Freighter exposes only a `window.freighter` boolean flag, not a callable global). The connecting
// account becomes the ADMIN of a new Covenant account and signs the deploy/admin txs. No keys here.
(function () {
  const C = window.COVENANT;
  let _address = null;

  // the vendored UMD exposes window.freighterApi (named exports; .default as fallback)
  function fa() {
    const a = window.freighterApi;
    if (!a) return null;
    return typeof a.requestAccess === 'function' ? a : (a.default || a);
  }
  // the library is loaded (the extension itself is checked async via isConnected)
  function available() { return !!fa(); }

  async function connect() {
    const a = fa();
    if (!a) { const e = new Error('freighter-api not loaded'); e.reason = 'not_installed'; throw e; }
    const conn = await a.isConnected().catch(() => ({ isConnected: false }));
    if (!conn || !conn.isConnected) { const e = new Error('Freighter extension not detected'); e.reason = 'not_installed'; throw e; }
    const req = await a.requestAccess();
    if (req.error || !req.address) { const e = new Error('access denied'); e.reason = 'denied'; throw e; }
    _address = req.address;
    return _address;
  }

  async function getAddress() {
    if (_address) return _address;
    const a = fa();
    if (!a) throw new Error('freighter-api not loaded');
    const r = await a.getAddress();
    if (r.error || !r.address) { const e = new Error('no_address'); e.reason = 'no_address'; throw e; }
    _address = r.address;
    return _address;
  }

  // Sign a built Transaction via the extension; returns a submittable signed Transaction.
  async function sign(tx) {
    const a = fa();
    if (!a) throw new Error('freighter-api not loaded');
    const opts = { networkPassphrase: C.networkPassphrase };
    if (_address) opts.address = _address;
    const r = await a.signTransaction(tx.toXDR(), opts);
    if (r.error || !r.signedTxXdr) throw new Error('wallet sign failed: ' + (r.error && (r.error.message || JSON.stringify(r.error)) || 'unknown'));
    return window.StellarSdk.TransactionBuilder.fromXDR(r.signedTxXdr, C.networkPassphrase);
  }

  window.CovenantWallet = { available, connect, getAddress, sign, _api: fa };
})();
