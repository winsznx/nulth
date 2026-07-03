// Nulth server — one Railway service that (1) hosts the static app in web/, and (2) exposes a
// minimal submit-only API:
//   GET  /api/health   -> { ok, network, relayer: <fee-payer pubkey|null>, usdc }
//   POST /api/relay    -> { account, to, amount, authEntryXdr } : builds the USDC transfer op
//                          itself, attaches the client's proof-signed auth entry, pays the XLM fee,
//                          and submits. It can ONLY relay a Nulth USDC transfer — never a general
//                          fee faucet — and it cannot authorize a spend (the ZK proof does that).
//   POST /api/waitlist -> { email } : appends to a JSONL sink (+ optional webhook).
//
// The fee-payer secret lives ONLY in the FEE_PAYER_SECRET env var, server-side. It holds a small,
// throwaway testnet XLM balance for fees; it never touches account funds and holds no USDC.
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import * as SDK from '@stellar/stellar-sdk';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8080);
const WEB_ROOT = path.join(__dirname, 'web');
const RPC_URL = process.env.RPC_URL || 'https://soroban-testnet.stellar.org';
const PASS = process.env.NETWORK_PASSPHRASE || SDK.Networks.TESTNET;
const USDC_SAC = process.env.USDC_SAC || 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA';
const WAITLIST_FILE = process.env.WAITLIST_FILE || path.join(__dirname, 'data', 'waitlist.jsonl');
const WAITLIST_WEBHOOK = process.env.WAITLIST_WEBHOOK || '';

const rpc = new SDK.rpc.Server(RPC_URL);
const feePayer = process.env.FEE_PAYER_SECRET ? SDK.Keypair.fromSecret(process.env.FEE_PAYER_SECRET) : null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// self-healing demo float: every payout moves USDC account -> payee; this recycles it back so
// the demo account never drains during a live investor session. Testnet-only, testnet-value key.
const DEMO_ACCOUNT = process.env.NULTH_ACCOUNT || 'CANA5QYVHNON7AV752ZRATFW2T5BMS3MU5DDPJMU5UGSR3KSH45LOGZE';
const payee = process.env.PAYEE_SECRET ? SDK.Keypair.fromSecret(process.env.PAYEE_SECRET) : null;
const SWEEP_MIN = BigInt(Math.round(Number(process.env.SWEEP_MIN_USDC || '5') * 1e7));
const SWEEP_MS = Number(process.env.SWEEP_INTERVAL_MS || 120_000);

// Exploitation Deck: the relayer submits browser-crafted attack txs (designed to be rejected).
const XLM_SAC = process.env.XLM_SAC || 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC';
const DEMO_PAYEE = process.env.DEMO_PAYEE || 'GBEOVHEZI2PS6OMLKZFULUXFSG5ZN3YAKUJE7UV3B7ACJVIXDA2UU4BS';
const DEMO_NONALLOW = process.env.DEMO_NONALLOWLISTED || 'GCES7J7AFTPOM7LRFI5FCE3PRWFCOU56IBPLQY7O2TM3YSTA3G2FLEJ3';
const ATTACK_DESTS = new Set([DEMO_PAYEE, DEMO_NONALLOW]);

// ---- tiny in-memory rate limiter (per real client IP, sliding window) ----
const HITS = new Map();
function rateLimited(ip, max = 20, windowMs = 60_000) {
  const now = Date.now();
  if (HITS.size > 10_000) { for (const [k, v] of HITS) { if (!v.some((t) => now - t < windowMs)) HITS.delete(k); } } // evict expired so a spoof/flood can't grow the map unbounded
  const arr = (HITS.get(ip) || []).filter((t) => now - t < windowMs);
  arr.push(now);
  HITS.set(ip, arr);
  return arr.length > max;
}
// Real client IP behind Railway's proxy. Prefer Envoy's trusted external address; else the LAST
// X-Forwarded-For hop (appended by the trusted proxy) — never the client-supplied first hop, which
// is spoofable and would let anyone bypass rate limits.
function clientIp(req) {
  const env = req.headers['x-envoy-external-address'];
  if (env) return String(env).split(',')[0].trim();
  const xff = String(req.headers['x-forwarded-for'] || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (xff.length) return xff[xff.length - 1];
  return String(req.socket.remoteAddress || '');
}

// ---- CORS (same-origin only) + security headers ----
const ALLOWED_ORIGINS = String(process.env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
function siteOrigins(req) {
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
  const list = [...ALLOWED_ORIGINS];
  if (host) list.push('https://' + host, 'http://' + host);
  return list;
}
function corsOrigin(req) { const o = req.headers.origin; return o && siteOrigins(req).includes(o) ? o : null; }
// A cross-origin browser POST carries an Origin the site doesn't own -> reject. Same-origin app calls
// (Origin == our host, or no Origin) pass. Direct non-browser calls (no Origin) pass but are rate-limited.
function originAllowed(req) { const o = req.headers.origin; return !o || siteOrigins(req).includes(o); }
function safeEqual(a, b) { const ba = Buffer.from(String(a)), bb = Buffer.from(String(b)); return ba.length === bb.length && crypto.timingSafeEqual(ba, bb); }
const SEC_HEADERS = {
  'x-frame-options': 'DENY',
  'content-security-policy': "frame-ancestors 'none'; base-uri 'self'; object-src 'none'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'strict-transport-security': 'max-age=31536000; includeSubDomains',
  'permissions-policy': 'geolocation=(), microphone=(), camera=(), payment=()',
};

// ---- helpers ----
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.wasm': 'application/wasm', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.map': 'application/json' };
function send(res, code, body, headers = {}) {
  const h = { ...SEC_HEADERS, 'access-control-allow-headers': 'content-type, authorization', ...headers };
  if (res._cors) h['access-control-allow-origin'] = res._cors; // reflect only same-origin; cross-origin gets no ACAO
  res.writeHead(code, h);
  res.end(body);
}
function json(res, code, obj) { send(res, code, JSON.stringify(obj), { 'content-type': 'application/json' }); }
function readBody(req) { return new Promise((resolve) => { let d = ''; req.on('data', (c) => { d += c; if (d.length > 1e6) req.destroy(); }); req.on('end', () => resolve(d)); }); }
async function settle(hash) { let f; for (let i = 0; i < 30; i++) { await sleep(2000); try { f = await rpc.getTransaction(hash); } catch { continue; } if (f.status !== 'NOT_FOUND') break; } return f; }
const codeFrom = (s) => { const m = String(s).match(/Error\(Contract, #(\d+)\)/); return m ? Number(m[1]) : null; };

// ---- POST /api/relay ----
async function handleRelay(req, res, ip) {
  if (!feePayer) return json(res, 503, { error: 'relayer_not_configured' });
  if (rateLimited(ip)) return json(res, 429, { error: 'rate_limited' });
  let body;
  try { body = JSON.parse(await readBody(req)); } catch { return json(res, 400, { error: 'bad_json' }); }
  const { account, to, amount, authEntryXdr } = body || {};

  // strict validation — the relayer only ever builds a USDC transfer from a covenant (contract) account
  if (!account || !SDK.StrKey.isValidContract(account)) return json(res, 400, { error: 'bad_account' });
  if (!to || !(SDK.StrKey.isValidEd25519PublicKey(to) || SDK.StrKey.isValidContract(to))) return json(res, 400, { error: 'bad_destination' });
  if (!/^[0-9]+$/.test(String(amount)) || BigInt(amount) <= 0n || BigInt(amount) >= (1n << 100n)) return json(res, 400, { error: 'bad_amount' });
  let entry;
  try { entry = SDK.xdr.SorobanAuthorizationEntry.fromXDR(authEntryXdr, 'base64'); } catch { return json(res, 400, { error: 'bad_auth_entry' }); }

  const addr = (a) => SDK.nativeToScVal(a, { type: 'address' });
  const op = SDK.Operation.invokeContractFunction({
    contract: USDC_SAC, function: 'transfer',
    args: [addr(account), addr(to), SDK.nativeToScVal(BigInt(amount), { type: 'i128' })],
    auth: [entry],
  });

  try {
    const src = await rpc.getAccount(feePayer.publicKey());
    let tx = new SDK.TransactionBuilder(src, { fee: '20000000', networkPassphrase: PASS }).addOperation(op).setTimeout(120).build();
    const sim = await rpc.simulateTransaction(tx);
    if (SDK.rpc.Api.isSimulationError(sim)) {
      // an invalid / out-of-policy proof fails simulation — a truthful refusal, not a server error
      return json(res, 422, { error: 'rejected', code: codeFrom(sim.error), detail: String(sim.error).split('\n')[0] });
    }
    tx = SDK.rpc.assembleTransaction(tx, sim).build();
    tx.sign(feePayer);
    const resp = await rpc.sendTransaction(tx);
    const final = await settle(resp.hash);
    return json(res, 200, { hash: resp.hash, status: final ? final.status : 'UNKNOWN' });
  } catch (e) {
    return json(res, 500, { error: 'relay_failed', detail: String(e && e.message || e) });
  }
}

// ---- POST /api/attack : relayer-sign + submit a browser-crafted attack tx (designed to be REJECTED) ----
// The browser builds the malformed proof + auth entry (the ZK part); the relayer only pays the fee and
// submits past the (expected) failing simulation with a borrowed footprint. Safety: the auth entry must
// authorize the shared demo account (never the relayer), and the op is a USDC/XLM transfer FROM that
// account to a known demo dest — nothing can move funds (only a valid proof passes __check_auth).
async function handleAttack(req, res, ip) {
  if (!feePayer) return json(res, 503, { error: 'relayer_not_configured' });
  if (rateLimited(ip)) return json(res, 429, { error: 'rate_limited' });
  let body; try { body = JSON.parse(await readBody(req)); } catch { return json(res, 400, { error: 'bad_json' }); }
  const { sac, to, entryXdr } = body || {};
  if (sac !== 'usdc' && sac !== 'xlm') return json(res, 400, { error: 'bad_sac' });
  if (!to || !SDK.StrKey.isValidEd25519PublicKey(to) || !ATTACK_DESTS.has(to)) return json(res, 400, { error: 'bad_dest' });
  let entry;
  try { entry = SDK.xdr.SorobanAuthorizationEntry.fromXDR(entryXdr, 'base64'); } catch { return json(res, 400, { error: 'bad_entry' }); }
  try {
    const cred = entry.credentials();
    if (cred.switch() !== SDK.xdr.SorobanCredentialsType.sorobanCredentialsAddress()) return json(res, 400, { error: 'bad_entry_cred' });
    if (SDK.Address.fromScAddress(cred.address().address()).toString() !== DEMO_ACCOUNT) return json(res, 400, { error: 'entry_not_account' });
  } catch { return json(res, 400, { error: 'bad_entry_addr' }); }

  const sacAddr = sac === 'xlm' ? XLM_SAC : USDC_SAC;
  const addr = (a) => SDK.nativeToScVal(a, { type: 'address' });
  const AMT = SDK.nativeToScVal(10000000n, { type: 'i128' });
  const attackOp = SDK.Operation.invokeContractFunction({ contract: sacAddr, function: 'transfer', args: [addr(DEMO_ACCOUNT), addr(to), AMT], auth: [entry] });
  try {
    // borrow a valid USDC->payee footprint so we can submit past the (expected) failing simulation
    let src = await rpc.getAccount(feePayer.publicKey());
    const validOp = SDK.Operation.invokeContractFunction({ contract: USDC_SAC, function: 'transfer', args: [addr(DEMO_ACCOUNT), addr(DEMO_PAYEE), AMT] });
    const vtx = new SDK.TransactionBuilder(src, { fee: '100000', networkPassphrase: PASS }).addOperation(validOp).setTimeout(120).build();
    const vsim = await rpc.simulateTransaction(vtx);
    if (SDK.rpc.Api.isSimulationError(vsim)) return json(res, 502, { error: 'footprint_failed', detail: String(vsim.error).split('\n')[0] });
    const sorobanData = vsim.transactionData.build();
    let instr = null; try { instr = sorobanData.resources().instructions(); } catch {}
    // sim the attack to read the authoritative rejection code (expected to fail auth)
    src = await rpc.getAccount(feePayer.publicKey());
    const stx = new SDK.TransactionBuilder(src, { fee: '2000000', networkPassphrase: PASS }).addOperation(attackOp).setTimeout(120).build();
    const ssim = await rpc.simulateTransaction(stx);
    const codeNum = SDK.rpc.Api.isSimulationError(ssim) ? codeFrom(ssim.error) : null;
    // submit past sim with the borrowed footprint -> a real REJECTED tx on-chain (real hash)
    src = await rpc.getAccount(feePayer.publicKey());
    let ftx = new SDK.TransactionBuilder(src, { fee: '20000000', networkPassphrase: PASS }).addOperation(attackOp).setSorobanData(sorobanData).setTimeout(120).build();
    ftx.sign(feePayer);
    const resp = await rpc.sendTransaction(ftx);
    const final = await settle(resp.hash);
    return json(res, 200, { code: codeNum != null ? '#' + codeNum : null, txHash: resp.hash, status: final ? final.status : 'UNKNOWN', instr });
  } catch (e) { return json(res, 500, { error: 'attack_failed', detail: String(e && e.message || e).split('\n')[0] }); }
}

// ---- POST /api/agent : interpret an English instruction into a payment intent ----
// The LLM (Groq, key server-side) is ONLY the translator: message -> { action, to, amount, reply }.
// It is NOT the guardrail — the browser then proves + relays, and the ZK proof (not the model) is
// what makes an out-of-policy payment impossible. If GROQ_API_KEY is unset, a deterministic parser
// is used so the demo still works. The agent will ATTEMPT what it's asked (even a hijack) — the
// account rejects out-of-policy payments cryptographically, which is the whole point.
const GROQ_MODEL = process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';
function fallbackIntent(message, vendors) {
  const m = String(message || '');
  const amt = (m.match(/(\d+(?:\.\d+)?)/) || [])[1];
  const explicitAddr = (m.match(/\b([GC][A-Z2-7]{55})\b/) || [])[1];
  const wantsPay = /\b(pay|send|transfer|wire|remit|pay out|payout)\b/i.test(m);
  if (wantsPay) {
    const to = explicitAddr || (vendors && vendors[0] && vendors[0].address) || null;
    return { action: 'pay', to, amount: amt ? Number(amt) : 1, reply: to ? `On it — sending ${amt || 1} USDC to ${to.slice(0, 8)}…` : 'I need a destination to pay.', brain: 'fallback' };
  }
  if (/what|who|help|can you|do you/i.test(m)) return { action: 'chat', to: null, amount: null, reply: 'I’m an autonomous payments agent on a Nulth account — I can pay my allowlisted vendors up to my per-payment cap. Try “pay a vendor 1 USDC”, or try to make me send funds somewhere I shouldn’t.', brain: 'fallback' };
  return { action: 'chat', to: null, amount: null, reply: 'Tell me who to pay and how much (e.g. “pay the vendor 2 USDC”).', brain: 'fallback' };
}
async function groqIntent(message, vendors, cap) {
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
    method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + process.env.GROQ_API_KEY },
    body: JSON.stringify({ model: GROQ_MODEL, temperature: 0.2, response_format: { type: 'json_object' }, messages: [{ role: 'system', content: sys }, { role: 'user', content: String(message || '').slice(0, 800) }] }),
  });
  if (!r.ok) throw new Error('groq_' + r.status);
  const data = await r.json();
  const out = JSON.parse(data.choices[0].message.content);
  // Honor an explicit address EXACTLY as the user wrote it. The LLM must never correct, complete, or
  // swap the destination for a look-alike vendor address — otherwise the *model* becomes the guardrail.
  // If the user typed a raw G.../C... address, that verbatim string is the destination, full stop.
  const literal = String(message).match(/\b([GC][A-Z2-7]{55})\b/);
  return { action: out.action === 'pay' ? 'pay' : 'chat', to: literal ? literal[1] : (out.to || null), amount: out.amount != null ? Number(out.amount) : null, reply: String(out.reply || '').slice(0, 400), brain: 'groq' };
}
async function handleAgent(req, res, ip) {
  if (rateLimited(ip, 30)) return json(res, 429, { error: 'rate_limited' });
  let body; try { body = JSON.parse(await readBody(req)); } catch { return json(res, 400, { error: 'bad_json' }); }
  const message = String((body && body.message) || '').slice(0, 800);
  const vendors = Array.isArray(body && body.vendors) ? body.vendors.slice(0, 32) : [];
  const cap = body && body.cap != null ? body.cap : null;
  try {
    const intent = process.env.GROQ_API_KEY ? await groqIntent(message, vendors, cap).catch(() => fallbackIntent(message, vendors)) : fallbackIntent(message, vendors);
    return json(res, 200, intent);
  } catch (e) { return json(res, 200, fallbackIntent(message, vendors)); }
}

// ---- POST /api/waitlist ----
async function handleWaitlist(req, res, ip) {
  if (rateLimited(ip, 10)) return json(res, 429, { error: 'rate_limited' });
  let body;
  try { body = JSON.parse(await readBody(req)); } catch { return json(res, 400, { error: 'bad_json' }); }
  const email = String((body && body.email) || '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || email.length > 254) return json(res, 400, { error: 'bad_email' });
  const ref = body && body.ref != null ? String(body.ref).slice(0, 120) : null; // cap so a large ref can't bloat the sink
  const rec = JSON.stringify({ email, ts: new Date().toISOString(), ref }) + '\n';
  let persisted = false;
  try { fs.mkdirSync(path.dirname(WAITLIST_FILE), { recursive: true }); fs.appendFileSync(WAITLIST_FILE, rec); persisted = true; }
  catch (e) { console.warn('[waitlist] durable write failed:', String(e && e.message || e).split('\n')[0]); }
  if (WAITLIST_WEBHOOK) { try { const wr = await fetch(WAITLIST_WEBHOOK, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content: 'Nulth waitlist: ' + email }) }); if (wr.ok) persisted = true; } catch { /* best effort */ } }
  if (!persisted) return json(res, 500, { error: 'not_persisted' }); // never tell the user "you're on the list" if nothing kept it
  return json(res, 200, { ok: true });
}

// ---- GET /api/waitlist/export?key=... : protected download of captured leads ----
function handleWaitlistExport(req, res, ip) {
  if (rateLimited(ip, 10)) return send(res, 429, 'rate_limited');
  const auth = String(req.headers['authorization'] || '');
  const bearer = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  const key = bearer || new URL(req.url, 'http://x').searchParams.get('key') || ''; // header preferred; ?key= kept for back-compat
  const expected = process.env.WAITLIST_EXPORT_KEY || '';
  if (!expected || !safeEqual(key, expected)) return send(res, 403, 'forbidden');
  let data = ''; try { data = fs.readFileSync(WAITLIST_FILE, 'utf8'); } catch { /* empty */ }
  const count = data ? data.trim().split('\n').filter(Boolean).length : 0;
  return send(res, 200, data, { 'content-type': 'text/plain; charset=utf-8', 'x-waitlist-count': String(count) });
}

// ---- static file serving (web/) with SPA-friendly fallback to index.html ----
function serveStatic(req, res) {
  let urlPath;
  try { urlPath = decodeURIComponent((req.url || '/').split('?')[0]); } catch { return send(res, 400, 'bad request'); } // malformed %-encoding -> 400, not a thrown 502
  let rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  let file = path.join(WEB_ROOT, rel);
  if (!file.startsWith(WEB_ROOT)) return send(res, 403, 'forbidden'); // path traversal guard
  fs.readFile(file, (err, data) => {
    if (err) { // fall back to index.html for unknown non-asset paths (single-page app)
      if (path.extname(file)) return send(res, 404, 'not found');
      return fs.readFile(path.join(WEB_ROOT, 'index.html'), (e2, d2) => e2 ? send(res, 404, 'not found') : send(res, 200, d2, { 'content-type': 'text/html' }));
    }
    send(res, 200, data, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
  });
}

async function sacBalance(who) {
  const src = await rpc.getAccount(payee.publicKey());
  const op = SDK.Operation.invokeContractFunction({ contract: USDC_SAC, function: 'balance', args: [SDK.nativeToScVal(who, { type: 'address' })] });
  const tx = new SDK.TransactionBuilder(src, { fee: '1000000', networkPassphrase: PASS }).addOperation(op).setTimeout(60).build();
  const sim = await rpc.simulateTransaction(tx);
  if (SDK.rpc.Api.isSimulationError(sim)) throw new Error(String(sim.error).split('\n')[0]);
  return BigInt(SDK.scValToNative(sim.result.retval).toString());
}

let sweeping = false;
async function sweepDemo() {
  if (!payee || sweeping) return;
  sweeping = true;
  try {
    const bal = await sacBalance(payee.publicKey());
    if (bal < SWEEP_MIN) return;
    const op = SDK.Operation.invokeContractFunction({ contract: USDC_SAC, function: 'transfer',
      args: [SDK.nativeToScVal(payee.publicKey(), { type: 'address' }), SDK.nativeToScVal(DEMO_ACCOUNT, { type: 'address' }), SDK.nativeToScVal(bal, { type: 'i128' })] });
    const src = await rpc.getAccount(payee.publicKey());
    let tx = new SDK.TransactionBuilder(src, { fee: '2000000', networkPassphrase: PASS }).addOperation(op).setTimeout(120).build();
    const sim = await rpc.simulateTransaction(tx);
    if (SDK.rpc.Api.isSimulationError(sim)) { console.warn('[sweep] sim failed:', String(sim.error).split('\n')[0]); return; }
    tx = SDK.rpc.assembleTransaction(tx, sim).build();
    tx.sign(payee);
    const resp = await rpc.sendTransaction(tx);
    console.log(`[sweep] recycled ${Number(bal) / 1e7} USDC payee->account tx=${resp.hash}`);
  } catch (e) { console.warn('[sweep] error:', String(e && e.message || e).split('\n')[0]); }
  finally { sweeping = false; }
}

const server = http.createServer(async (req, res) => {
  try {
    res._cors = corsOrigin(req); // reflect ACAO only for our own origin
    const ip = clientIp(req);
    if (req.method === 'OPTIONS') return send(res, 204, '', { 'access-control-allow-methods': 'GET, POST, OPTIONS' });
    // a cross-origin browser POST carries a foreign Origin -> refuse (same-origin app + non-browser clients pass)
    if (req.method === 'POST' && req.url.startsWith('/api/') && !originAllowed(req)) return json(res, 403, { error: 'forbidden_origin' });
    if (req.url === '/api/health') return json(res, 200, { ok: true, network: PASS === SDK.Networks.TESTNET ? 'testnet' : 'custom', relayer: feePayer ? feePayer.publicKey() : null, usdc: USDC_SAC, agent: process.env.GROQ_API_KEY ? 'groq' : 'fallback' });
    if (req.method === 'POST' && req.url === '/api/relay') return handleRelay(req, res, ip);
    if (req.method === 'POST' && req.url === '/api/attack') return handleAttack(req, res, ip);
    if (req.method === 'POST' && req.url === '/api/agent') return handleAgent(req, res, ip);
    if (req.method === 'POST' && req.url === '/api/waitlist') return handleWaitlist(req, res, ip);
    if (req.method === 'GET' && req.url.startsWith('/api/waitlist/export')) return handleWaitlistExport(req, res, ip);
    // demo policy secret is served from an env var in production (never committed / never in the repo);
    // local dev falls through to the on-disk file under web/.
    if (req.method === 'GET' && req.url === '/policy_secret.json' && process.env.DEMO_POLICY_SECRET) {
      return send(res, 200, process.env.DEMO_POLICY_SECRET, { 'content-type': 'application/json' });
    }
    if (req.method === 'GET') return serveStatic(req, res);
    return send(res, 404, 'not found');
  } catch (e) {
    console.error('[request]', String(e && e.message || e).split('\n')[0]);
    try { return json(res, 500, { error: 'server_error' }); } catch { /* headers already sent */ }
  }
});
// keep the process alive on an unexpected throw instead of crash-looping on malformed input
process.on('unhandledRejection', (e) => console.error('[unhandledRejection]', String(e && e.message || e).split('\n')[0]));
process.on('uncaughtException', (e) => console.error('[uncaughtException]', String(e && e.message || e).split('\n')[0]));

server.listen(PORT, () => {
  console.log(`nulth server on :${PORT} · web=${WEB_ROOT} · relayer=${feePayer ? feePayer.publicKey() : 'DISABLED (set FEE_PAYER_SECRET)'} · rpc=${RPC_URL}`);
  if (payee) {
    console.log(`[sweep] self-healing demo float ON · payee=${payee.publicKey()} · refill when payee ≥ ${Number(SWEEP_MIN) / 1e7} USDC · every ${SWEEP_MS / 1000}s`);
    setInterval(() => { sweepDemo(); }, SWEEP_MS);
  } else {
    console.log('[sweep] disabled (set PAYEE_SECRET to enable self-healing demo float)');
  }
});
