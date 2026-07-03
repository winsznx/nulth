// Self-serve account creation — ALL policy secrets are generated and kept client-side.
// Flow: connect Freighter -> define policy (cap + allowlist) -> compute Poseidon commitment +
// DEPTH-16 root in-browser (web/lib/poseidon.js) -> deploy a fresh account via createContractV2
// against the SHARED wasm hash + SHARED verifier, signed by the user's wallet -> persist an
// encrypted-at-rest-able JSON keystore (localStorage + download). The cap, salt and allowlist
// never touch a server: they live only in this file's outputs (keystore / localStorage).
(function () {
  const SDK = window.StellarSdk;
  const C = window.COVENANT;
  const rpc = new SDK.rpc.Server(C.rpcUrl);
  const PASS = C.networkPassphrase;
  const addr = (a) => SDK.nativeToScVal(a, { type: 'address' });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const LS_KEY = 'nulth.accounts.v1', SS_KEY = 'nulth.unlocked.v1';
  // one-time migration from the pre-rebrand keys so existing keystores are never lost
  try {
    for (const [store, nk, ok] of [[localStorage, LS_KEY, 'covenant.accounts.v1'], [sessionStorage, SS_KEY, 'covenant.unlocked.v1']]) {
      if (!store.getItem(nk) && store.getItem(ok)) store.setItem(nk, store.getItem(ok));
    }
  } catch (e) {}

  function randomBytes(n) { const b = new Uint8Array(n); crypto.getRandomValues(b); return window.Buffer.from(b); }
  function randomSaltDec() { const b = new Uint8Array(16); crypto.getRandomValues(b); return BigInt('0x' + Array.from(b).map((x) => x.toString(16).padStart(2, '0')).join('')).toString(); }

  // CLIENT-SIDE policy — random salt, Poseidon(cap,salt) commitment, DEPTH-16 root over the
  // allowlist. Each address is encoded to its field element IN-BROWSER via CovenantPoseidon.addrToField
  // (= the contract's dest_field, golden-vector-verified). NO RPC: the allowlist (incl. unexercised
  // entries) never leaves the browser. Only the commitment + root are public, and they reveal nothing.
  function buildPolicy(capUsdc, allowlistAddrs) {
    const cap = BigInt(Math.round(Number(capUsdc) * 1e7)).toString();
    const salt = randomSaltDec();
    const pol = window.CovenantPoseidon.buildPolicyForAddresses(cap, salt, allowlistAddrs);
    const members = pol.members.map((m, i) => ({ address: allowlistAddrs[i], destLeaf: m.destLeaf, index: m.index, path: m.path, index_bits: m.index_bits }));
    return { cap, salt, commitment: pol.commitment, root: pol.root, members };
  }

  // Deploy a fresh account: createContractV2(shared wasm hash) + constructor(vk, commitment, root,
  // USDC, admin). The user's wallet signs. Returns the new (dynamic) account id.
  async function deploy(admin, pol, onStep) {
    onStep && onStep('loading verifier key');
    const vk = await fetch(C.proverVk, { cache: 'no-store' }).then((r) => r.json());
    const S = window.CovenantSerialize;
    const op = SDK.Operation.createCustomContract({
      address: SDK.Address.fromString(admin),
      wasmHash: window.Buffer.from(C.accountWasmHash, 'hex'),
      salt: randomBytes(32),
      constructorArgs: [S.vkScVal(vk, 'c1c0'), S.u256ScVal(pol.commitment), S.u256ScVal(pol.root), addr(C.usdcSac), addr(admin)],
    });
    onStep && onStep('simulating deploy');
    let src = await rpc.getAccount(admin);
    let tx = new SDK.TransactionBuilder(src, { fee: '20000000', networkPassphrase: PASS }).addOperation(op).setTimeout(180).build();
    const sim = await rpc.simulateTransaction(tx);
    if (SDK.rpc.Api.isSimulationError(sim)) throw new Error('deploy sim: ' + sim.error);
    const account = SDK.scValToNative(sim.result.retval);
    tx = SDK.rpc.assembleTransaction(tx, sim).build();
    onStep && onStep('awaiting wallet signature');
    const signed = await window.CovenantWallet.sign(tx);
    onStep && onStep('submitting deploy');
    const res = await rpc.sendTransaction(signed);
    let final; for (let i = 0; i < 30; i++) { await sleep(2000); final = await rpc.getTransaction(res.hash); if (final.status !== 'NOT_FOUND') break; }
    return { account, hash: res.hash, status: final ? final.status : 'UNKNOWN' };
  }

  // ---- keystore encryption (WebCrypto: PBKDF2-SHA256 250k -> AES-256-GCM) ----
  // At rest (downloaded file + localStorage) the SECRET fields (cap, salt, allowlist) are encrypted
  // under the user's passphrase. The decrypted copy lives only in sessionStorage (cleared when the
  // tab closes) — never written to disk in plaintext. Public fields (account/admin/commitment/root)
  // stay readable. We can't recover a lost passphrase (no escrow), like any real keystore.
  const ITER = 250000;
  const te = new TextEncoder(), tdc = new TextDecoder();
  const b64 = (u) => btoa(String.fromCharCode.apply(null, u));
  const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  async function deriveKey(passphrase, salt) {
    const base = await crypto.subtle.importKey('raw', te.encode(passphrase), 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: ITER, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  }
  async function encryptSecret(secret, passphrase) {
    const salt = crypto.getRandomValues(new Uint8Array(16)), iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await deriveKey(passphrase, salt);
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, te.encode(JSON.stringify(secret))));
    return { v: 1, kdf: 'PBKDF2-SHA256', iterations: ITER, salt: b64(salt), iv: b64(iv), cipher: 'AES-256-GCM', ct: b64(ct) };
  }
  async function decryptSecret(enc, passphrase) {
    const key = await deriveKey(passphrase, unb64(enc.salt));
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(enc.iv) }, key, unb64(enc.ct));
    return JSON.parse(tdc.decode(pt));
  }

  // a DECRYPTED (in-memory) keystore — what the active account + prover use
  function makeKeystore(account, admin, pol) {
    return { version: 2, network: C.network, account, admin, token: C.usdcSac, verifier: C.verifier,
      commitment: pol.commitment, root: pol.root, cap: pol.cap, salt: pol.salt, members: pol.members, createdAt: new Date().toISOString() };
  }
  // encrypt the secret fields for at-rest storage / download
  async function seal(fullKs, passphrase) {
    const enc = await encryptSecret({ cap: fullKs.cap, salt: fullKs.salt, members: fullKs.members }, passphrase);
    return { version: 2, network: fullKs.network, account: fullKs.account, admin: fullKs.admin, token: fullKs.token, verifier: fullKs.verifier,
      commitment: fullKs.commitment, root: fullKs.root, createdAt: fullKs.createdAt, enc };
  }
  async function unlock(encKs, passphrase) {
    if (!encKs.enc) return encKs; // already a decrypted/legacy keystore
    const s = await decryptSecret(encKs.enc, passphrase);
    return { version: 2, network: encKs.network, account: encKs.account, admin: encKs.admin, token: encKs.token, verifier: encKs.verifier,
      commitment: encKs.commitment, root: encKs.root, cap: s.cap, salt: s.salt, members: s.members, createdAt: encKs.createdAt };
  }

  // the per-payment prover secret for paying a given allowlisted member (operates on a DECRYPTED ks)
  function secretFor(ks, address) {
    const m = ks.members.find((x) => x.address === address) || ks.members[0];
    return { cap: ks.cap, salt: ks.salt, commitment: ks.commitment, root: ks.root, destLeaf: m.destLeaf, path: m.path, index_bits: m.index_bits };
  }
  // localStorage = ENCRYPTED keystores (durable, ciphertext) ; sessionStorage = DECRYPTED (tab session)
  function listLocal() { try { return JSON.parse(localStorage.getItem(LS_KEY) || '{}'); } catch (e) { return {}; } }
  function saveLocal(encKs) { const all = listLocal(); all[encKs.account] = encKs; localStorage.setItem(LS_KEY, JSON.stringify(all)); }
  function loadLocal(account) { return listLocal()[account] || null; }
  function isEncrypted(account) { const k = loadLocal(account); return !!(k && k.enc); }
  function listUnlocked() { try { return JSON.parse(sessionStorage.getItem(SS_KEY) || '{}'); } catch (e) { return {}; } }
  function saveUnlocked(fullKs) { const all = listUnlocked(); all[fullKs.account] = fullKs; sessionStorage.setItem(SS_KEY, JSON.stringify(all)); }
  function loadUnlocked(account) { return listUnlocked()[account] || null; }

  async function importKeystore(json, passphrase) {
    const ks = typeof json === 'string' ? JSON.parse(json) : json;
    if (!ks.account || !ks.commitment) throw new Error('invalid keystore');
    // validate every address in an imported keystore so a hostile file can't smuggle markup into the UI
    const S = window.StellarSdk;
    const okAddr = (a) => typeof a === 'string' && (!S || S.StrKey.isValidEd25519PublicKey(a) || S.StrKey.isValidContract(a));
    if (S && !S.StrKey.isValidContract(ks.account)) throw new Error('invalid keystore: bad account id');
    const checkMembers = (arr) => { if (Array.isArray(arr)) for (const m of arr) if (!m || !okAddr(m.address)) throw new Error('invalid keystore: bad allowlist address'); };
    if (ks.enc) { const full = await unlock(ks, passphrase); checkMembers(full.members); saveLocal(ks); saveUnlocked(full); return full; }
    checkMembers(ks.members); saveLocal(ks); saveUnlocked(ks); return ks; // legacy plaintext keystore
  }
  function download(encKs) {
    const blob = new Blob([JSON.stringify(encKs, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob); const a = document.createElement('a');
    a.href = url; a.download = 'nulth-' + encKs.account.slice(0, 8) + '.keystore.json'; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }

  window.CovenantCreate = { buildPolicy, deploy, makeKeystore, seal, unlock, secretFor,
    listLocal, saveLocal, loadLocal, isEncrypted, listUnlocked, saveUnlocked, loadUnlocked, importKeystore, download };
})();
