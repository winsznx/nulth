// Nulth — Cloudflare Worker port of server.mjs.
// Static app in web/ is served by the ASSETS binding; the API routes below run in the Worker.
// The sweep/self-healing-demo-float model was removed (product moving past it), so this is a
// fully stateless request/response worker. Secrets (FEE_PAYER_SECRET, GROQ_API_KEY,
// WAITLIST_EXPORT_KEY, DEMO_POLICY_SECRET) come from `wrangler secret`. The waitlist sink moved
// from a JSONL file to the WAITLIST KV namespace.
import * as SDK from '@stellar/stellar-sdk';

const SEC_HEADERS = {
  'x-frame-options': 'DENY',
  'content-security-policy': "frame-ancestors 'none'; base-uri 'self'; object-src 'none'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'strict-transport-security': 'max-age=31536000; includeSubDomains',
  'permissions-policy': 'geolocation=(), microphone=(), camera=(), payment=()',
};

function config(env) {
  const PASS = env.NETWORK_PASSPHRASE || SDK.Networks.TESTNET;
  const USDC_SAC = env.USDC_SAC || 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA';
  const DEMO_ACCOUNT = env.NULTH_ACCOUNT || 'CAKSFFBTLDMHS4BH4ABTUVNN3WN5XO3WYIRD4ZNXELDXN5GGBNA77QQW';
  const XLM_SAC = env.XLM_SAC || 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC';
  const DEMO_PAYEE = env.DEMO_PAYEE || 'GBEOVHEZI2PS6OMLKZFULUXFSG5ZN3YAKUJE7UV3B7ACJVIXDA2UU4BS';
  const DEMO_NONALLOW = env.DEMO_NONALLOWLISTED || 'GCES7J7AFTPOM7LRFI5FCE3PRWFCOU56IBPLQY7O2TM3YSTA3G2FLEJ3';
  return {
    RPC_URL: env.RPC_URL || 'https://soroban-testnet.stellar.org',
    PASS, USDC_SAC, DEMO_ACCOUNT, XLM_SAC, DEMO_PAYEE, DEMO_NONALLOW,
    GROQ_MODEL: env.GROQ_MODEL || 'llama-3.3-70b-versatile',
    ALLOWED_ORIGINS: String(env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean),
    ATTACK_DESTS: new Set([DEMO_PAYEE, DEMO_NONALLOW]),
  };
}

// ---- responses ----
function resp(status, body, headers = {}, cors = null) {
  const h = new Headers({ ...SEC_HEADERS, 'access-control-allow-headers': 'content-type, authorization', ...headers });
  if (cors) h.set('access-control-allow-origin', cors);
  return new Response(body, { status, headers: h });
}
const jsonResp = (status, obj, cors) => resp(status, JSON.stringify(obj), { 'content-type': 'application/json' }, cors);

// ---- rate limit (per-isolate, best-effort) ----
const HITS = new Map();
function rateLimited(ip, max = 20, windowMs = 60_000) {
  const now = Date.now();
  if (HITS.size > 10_000) { for (const [k, v] of HITS) { if (!v.some((t) => now - t < windowMs)) HITS.delete(k); } }
  const arr = (HITS.get(ip) || []).filter((t) => now - t < windowMs);
  arr.push(now); HITS.set(ip, arr);
  return arr.length > max;
}
function clientIp(request) {
  const cf = request.headers.get('cf-connecting-ip'); if (cf) return cf;
  const xff = String(request.headers.get('x-forwarded-for') || '').split(',').map((s) => s.trim()).filter(Boolean);
  return xff.length ? xff[xff.length - 1] : '';
}

// ---- CORS (same-origin only) ----
function siteOrigins(request, cfg) {
  const host = String(request.headers.get('x-forwarded-host') || request.headers.get('host') || new URL(request.url).host).split(',')[0].trim();
  const list = [...cfg.ALLOWED_ORIGINS];
  if (host) list.push('https://' + host, 'http://' + host);
  return list;
}
const corsOrigin = (request, cfg) => { const o = request.headers.get('origin'); return o && siteOrigins(request, cfg).includes(o) ? o : null; };
const originAllowed = (request, cfg) => { const o = request.headers.get('origin'); return !o || siteOrigins(request, cfg).includes(o); };
function safeEqual(a, b) { a = String(a); b = String(b); if (a.length !== b.length) return false; let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i); return r === 0; }

// ---- stellar helpers ----
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function settle(rpc, hash) { let f; for (let i = 0; i < 20; i++) { await sleep(2000); try { f = await rpc.getTransaction(hash); } catch { continue; } if (f.status !== 'NOT_FOUND') break; } return f; }
const codeFrom = (s) => { const m = String(s).match(/Error\(Contract, #(\d+)\)/); return m ? Number(m[1]) : null; };
const feePayerOf = (env) => (env.FEE_PAYER_SECRET ? SDK.Keypair.fromSecret(env.FEE_PAYER_SECRET) : null);

// ---- POST /api/relay ----
async function handleRelay(request, env, cfg, ip, cors) {
  const feePayer = feePayerOf(env);
  if (!feePayer) return jsonResp(503, { error: 'relayer_not_configured' }, cors);
  if (rateLimited(ip)) return jsonResp(429, { error: 'rate_limited' }, cors);
  let body; try { body = await request.json(); } catch { return jsonResp(400, { error: 'bad_json' }, cors); }
  const { account, to, amount, authEntryXdr } = body || {};
  if (!account || !SDK.StrKey.isValidContract(account)) return jsonResp(400, { error: 'bad_account' }, cors);
  if (!to || !(SDK.StrKey.isValidEd25519PublicKey(to) || SDK.StrKey.isValidContract(to))) return jsonResp(400, { error: 'bad_destination' }, cors);
  if (!/^[0-9]+$/.test(String(amount)) || BigInt(amount) <= 0n || BigInt(amount) >= (1n << 100n)) return jsonResp(400, { error: 'bad_amount' }, cors);
  let entry; try { entry = SDK.xdr.SorobanAuthorizationEntry.fromXDR(authEntryXdr, 'base64'); } catch { return jsonResp(400, { error: 'bad_auth_entry' }, cors); }
  const rpc = new SDK.rpc.Server(cfg.RPC_URL);
  const addr = (a) => SDK.nativeToScVal(a, { type: 'address' });
  const op = SDK.Operation.invokeContractFunction({ contract: cfg.USDC_SAC, function: 'transfer', args: [addr(account), addr(to), SDK.nativeToScVal(BigInt(amount), { type: 'i128' })], auth: [entry] });
  try {
    const src = await rpc.getAccount(feePayer.publicKey());
    let tx = new SDK.TransactionBuilder(src, { fee: '20000000', networkPassphrase: cfg.PASS }).addOperation(op).setTimeout(120).build();
    const sim = await rpc.simulateTransaction(tx);
    if (SDK.rpc.Api.isSimulationError(sim)) return jsonResp(422, { error: 'rejected', code: codeFrom(sim.error), detail: String(sim.error).split('\n')[0] }, cors);
    tx = SDK.rpc.assembleTransaction(tx, sim).build();
    tx.sign(feePayer);
    const r = await rpc.sendTransaction(tx);
    const final = await settle(rpc, r.hash);
    return jsonResp(200, { hash: r.hash, status: final ? final.status : 'UNKNOWN' }, cors);
  } catch (e) { return jsonResp(500, { error: 'relay_failed', detail: String((e && e.message) || e) }, cors); }
}

// ---- POST /api/attack (relayer submits a browser-crafted attack tx, designed to be REJECTED) ----
async function handleAttack(request, env, cfg, ip, cors) {
  const feePayer = feePayerOf(env);
  if (!feePayer) return jsonResp(503, { error: 'relayer_not_configured' }, cors);
  if (rateLimited(ip)) return jsonResp(429, { error: 'rate_limited' }, cors);
  let body; try { body = await request.json(); } catch { return jsonResp(400, { error: 'bad_json' }, cors); }
  const { sac, to, entryXdr } = body || {};
  if (sac !== 'usdc' && sac !== 'xlm') return jsonResp(400, { error: 'bad_sac' }, cors);
  if (!to || !SDK.StrKey.isValidEd25519PublicKey(to) || !cfg.ATTACK_DESTS.has(to)) return jsonResp(400, { error: 'bad_dest' }, cors);
  let entry; try { entry = SDK.xdr.SorobanAuthorizationEntry.fromXDR(entryXdr, 'base64'); } catch { return jsonResp(400, { error: 'bad_entry' }, cors); }
  try {
    const cred = entry.credentials();
    if (cred.switch() !== SDK.xdr.SorobanCredentialsType.sorobanCredentialsAddress()) return jsonResp(400, { error: 'bad_entry_cred' }, cors);
    if (SDK.Address.fromScAddress(cred.address().address()).toString() !== cfg.DEMO_ACCOUNT) return jsonResp(400, { error: 'entry_not_account' }, cors);
  } catch { return jsonResp(400, { error: 'bad_entry_addr' }, cors); }
  const rpc = new SDK.rpc.Server(cfg.RPC_URL);
  const sacAddr = sac === 'xlm' ? cfg.XLM_SAC : cfg.USDC_SAC;
  const addr = (a) => SDK.nativeToScVal(a, { type: 'address' });
  const AMT = SDK.nativeToScVal(10000000n, { type: 'i128' });
  const attackOp = SDK.Operation.invokeContractFunction({ contract: sacAddr, function: 'transfer', args: [addr(cfg.DEMO_ACCOUNT), addr(to), AMT], auth: [entry] });
  try {
    let src = await rpc.getAccount(feePayer.publicKey());
    const validOp = SDK.Operation.invokeContractFunction({ contract: cfg.USDC_SAC, function: 'transfer', args: [addr(cfg.DEMO_ACCOUNT), addr(cfg.DEMO_PAYEE), AMT] });
    const vtx = new SDK.TransactionBuilder(src, { fee: '100000', networkPassphrase: cfg.PASS }).addOperation(validOp).setTimeout(120).build();
    const vsim = await rpc.simulateTransaction(vtx);
    if (SDK.rpc.Api.isSimulationError(vsim)) return jsonResp(502, { error: 'footprint_failed', detail: String(vsim.error).split('\n')[0] }, cors);
    const sorobanData = vsim.transactionData.build();
    let instr = null; try { instr = sorobanData.resources().instructions(); } catch {}
    src = await rpc.getAccount(feePayer.publicKey());
    const stx = new SDK.TransactionBuilder(src, { fee: '2000000', networkPassphrase: cfg.PASS }).addOperation(attackOp).setTimeout(120).build();
    const ssim = await rpc.simulateTransaction(stx);
    const codeNum = SDK.rpc.Api.isSimulationError(ssim) ? codeFrom(ssim.error) : null;
    src = await rpc.getAccount(feePayer.publicKey());
    const ftx = new SDK.TransactionBuilder(src, { fee: '20000000', networkPassphrase: cfg.PASS }).addOperation(attackOp).setSorobanData(sorobanData).setTimeout(120).build();
    ftx.sign(feePayer);
    const r = await rpc.sendTransaction(ftx);
    const final = await settle(rpc, r.hash);
    return jsonResp(200, { code: codeNum != null ? '#' + codeNum : null, txHash: r.hash, status: final ? final.status : 'UNKNOWN', instr }, cors);
  } catch (e) { return jsonResp(500, { error: 'attack_failed', detail: String((e && e.message) || e).split('\n')[0] }, cors); }
}

// ---- POST /api/agent (Groq translates English -> payment intent; ZK proof is the guardrail, not the model) ----
function fallbackIntent(message, vendors) {
  const m = String(message || '');
  const amt = (m.match(/(\d+(?:\.\d+)?)/) || [])[1];
  const explicitAddr = (m.match(/\b([GC][A-Z2-7]{55})\b/) || [])[1];
  if (/\b(pay|send|transfer|wire|remit|pay out|payout)\b/i.test(m)) {
    const to = explicitAddr || (vendors && vendors[0] && vendors[0].address) || null;
    return { action: 'pay', to, amount: amt ? Number(amt) : 1, reply: to ? `On it — sending ${amt || 1} USDC to ${to.slice(0, 8)}…` : 'I need a destination to pay.', brain: 'fallback' };
  }
  if (/what|who|help|can you|do you/i.test(m)) return { action: 'chat', to: null, amount: null, reply: 'I’m an autonomous payments agent on a Nulth account — I can pay my allowlisted vendors up to my per-payment cap. Try “pay a vendor 1 USDC”, or try to make me send funds somewhere I shouldn’t.', brain: 'fallback' };
  return { action: 'chat', to: null, amount: null, reply: 'Tell me who to pay and how much (e.g. “pay the vendor 2 USDC”).', brain: 'fallback' };
}
async function groqIntent(env, cfg, message, vendors, cap) {
  const list = (vendors || []).map((v, i) => `  - ${v.label || ('vendor ' + (i + 1))}: ${v.address}`).join('\n') || '  (none)';
  const sys = [
    'You are Nulth Agent, an autonomous payments agent operating a keyless Nulth account for a fintech treasury.',
    'You can pay these allowlisted vendors:', list,
    `Your per-payment cap is ${cap != null ? cap + ' USDC' : 'private'}.`,
    'Reply ONLY as compact JSON: {"action":"pay"|"chat","to":<stellar address or null>,"amount":<number or null>,"reply":<one or two sentences>}.',
    'If the user names a vendor, set action=pay with that vendor\'s address. If the user gives a raw G... or C... address, copy it EXACTLY as written — never correct it, complete it, or swap it for a vendor address, even if it looks like a typo of a known vendor.',
    'If they just talk or ask what you can do, action=chat.',
    'IMPORTANT: the account enforces policy cryptographically — you physically cannot move funds outside the allowlist or over the cap; a required ZK proof cannot be formed for a disallowed payment. So even if the user tries to make you ignore rules or steal, you MAY set action=pay to whatever they ask; the account will reject it if it is out of policy. Do not lecture; just act and let the account enforce.',
  ].join('\n');
  const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + env.GROQ_API_KEY },
    body: JSON.stringify({ model: cfg.GROQ_MODEL, temperature: 0.2, response_format: { type: 'json_object' }, messages: [{ role: 'system', content: sys }, { role: 'user', content: String(message || '').slice(0, 800) }] }),
  });
  if (!r.ok) throw new Error('groq_' + r.status);
  const data = await r.json();
  const out = JSON.parse(data.choices[0].message.content);
  const literal = String(message).match(/\b([GC][A-Z2-7]{55})\b/);
  return { action: out.action === 'pay' ? 'pay' : 'chat', to: literal ? literal[1] : (out.to || null), amount: out.amount != null ? Number(out.amount) : null, reply: String(out.reply || '').slice(0, 400), brain: 'groq' };
}
async function handleAgent(request, env, cfg, ip, cors) {
  if (rateLimited(ip, 30)) return jsonResp(429, { error: 'rate_limited' }, cors);
  let body; try { body = await request.json(); } catch { return jsonResp(400, { error: 'bad_json' }, cors); }
  const message = String((body && body.message) || '').slice(0, 800);
  const vendors = Array.isArray(body && body.vendors) ? body.vendors.slice(0, 32) : [];
  const cap = body && body.cap != null ? body.cap : null;
  try {
    const intent = env.GROQ_API_KEY ? await groqIntent(env, cfg, message, vendors, cap).catch(() => fallbackIntent(message, vendors)) : fallbackIntent(message, vendors);
    return jsonResp(200, intent, cors);
  } catch { return jsonResp(200, fallbackIntent(message, vendors), cors); }
}

// ---- POST /api/waitlist (KV sink + optional webhook) ----
async function handleWaitlist(request, env, cfg, ip, cors) {
  if (rateLimited(ip, 10)) return jsonResp(429, { error: 'rate_limited' }, cors);
  let body; try { body = await request.json(); } catch { return jsonResp(400, { error: 'bad_json' }, cors); }
  const email = String((body && body.email) || '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || email.length > 254) return jsonResp(400, { error: 'bad_email' }, cors);
  const ref = body && body.ref != null ? String(body.ref).slice(0, 120) : null;
  const rec = JSON.stringify({ email, ts: new Date().toISOString(), ref });
  let persisted = false;
  if (env.WAITLIST) { try { await env.WAITLIST.put('wl:' + email, rec); persisted = true; } catch (e) { console.warn('[waitlist] KV write failed', String((e && e.message) || e)); } }
  if (env.WAITLIST_WEBHOOK) { try { const wr = await fetch(env.WAITLIST_WEBHOOK, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content: 'Nulth waitlist: ' + email }) }); if (wr.ok) persisted = true; } catch {} }
  if (!persisted) return jsonResp(500, { error: 'not_persisted' }, cors);
  return jsonResp(200, { ok: true }, cors);
}

// ---- GET /api/waitlist/export?key=... (protected KV dump) ----
async function handleWaitlistExport(request, env, cfg, ip, cors) {
  if (rateLimited(ip, 10)) return resp(429, 'rate_limited', {}, cors);
  const auth = String(request.headers.get('authorization') || '');
  const bearer = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  const key = bearer || new URL(request.url).searchParams.get('key') || '';
  const expected = env.WAITLIST_EXPORT_KEY || '';
  if (!expected || !safeEqual(key, expected)) return resp(403, 'forbidden', {}, cors);
  const lines = [];
  if (env.WAITLIST) {
    let cursor;
    do {
      const list = await env.WAITLIST.list({ prefix: 'wl:', cursor });
      for (const k of list.keys) { const v = await env.WAITLIST.get(k.name); if (v) lines.push(v); }
      cursor = list.list_complete ? null : list.cursor;
    } while (cursor);
  }
  const data = lines.length ? lines.join('\n') + '\n' : '';
  return resp(200, data, { 'content-type': 'text/plain; charset=utf-8', 'x-waitlist-count': String(lines.length) }, cors);
}

export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);
      const path = url.pathname;
      const method = request.method;
      const cfg = config(env);
      const cors = corsOrigin(request, cfg);
      const ip = clientIp(request);

      if (method === 'OPTIONS') return resp(204, '', { 'access-control-allow-methods': 'GET, POST, OPTIONS' }, cors);
      if (method === 'POST' && path.startsWith('/api/') && !originAllowed(request, cfg)) return jsonResp(403, { error: 'forbidden_origin' }, cors);

      if (path === '/api/health') {
        const feePayer = feePayerOf(env);
        return jsonResp(200, { ok: true, network: cfg.PASS === SDK.Networks.TESTNET ? 'testnet' : 'custom', relayer: feePayer ? feePayer.publicKey() : null, usdc: cfg.USDC_SAC, agent: env.GROQ_API_KEY ? 'groq' : 'fallback' }, cors);
      }
      if (method === 'POST' && path === '/api/relay') return handleRelay(request, env, cfg, ip, cors);
      if (method === 'POST' && path === '/api/attack') return handleAttack(request, env, cfg, ip, cors);
      if (method === 'POST' && path === '/api/agent') return handleAgent(request, env, cfg, ip, cors);
      if (method === 'POST' && path === '/api/waitlist') return handleWaitlist(request, env, cfg, ip, cors);
      if (method === 'GET' && path.startsWith('/api/waitlist/export')) return handleWaitlistExport(request, env, cfg, ip, cors);
      if (path.startsWith('/api/')) return jsonResp(404, { error: 'not_found' }, cors);

      // never serve local-dev operator keys, even if they slip into the assets dir
      if (path === '/secrets.local.js' || path === '/secrets.example.js') return resp(404, 'not found', {}, cors);

      // demo policy secret: env override in production, else fall through to the static file under web/
      if (method === 'GET' && path === '/policy_secret.json' && env.DEMO_POLICY_SECRET) {
        return resp(200, env.DEMO_POLICY_SECRET, { 'content-type': 'application/json' }, cors);
      }
      // everything else -> static assets (SPA fallback handled by the assets binding)
      return env.ASSETS.fetch(request);
    } catch (e) {
      console.error('[request]', String((e && e.message) || e).split('\n')[0]);
      return jsonResp(500, { error: 'server_error' });
    }
  },
};
