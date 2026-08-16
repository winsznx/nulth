# Migration: nulth server Railway → Cloudflare Workers (2026-08-16)

Railway's trial expired and stopped the service, so nulth (`nulth.xyz`) went down. The single
`server.mjs` (raw `http` server: static `web/` + submit-only API) was ported to a **Cloudflare
Worker**. This was viable because the app is stateless once the demo **sweep** loop is removed
(the product is moving past the self-healing-float model), and `@stellar/stellar-sdk` bundles and
runs on workerd (~324 KiB gzipped).

## Files
| File | Change |
|------|--------|
| `worker.mjs` | New — Worker port of `server.mjs`. Same routes (`/api/health`, `/api/relay`, `/api/attack`, `/api/agent`, `/api/waitlist`, `/api/waitlist/export`, `/policy_secret.json`), same CORS/rate-limit/security-header behaviour, static served via the `ASSETS` binding. |
| `wrangler.jsonc` | New — `assets` = `./web` (SPA fallback), `WAITLIST` KV binding, `nodejs_compat`, testnet vars, `run_worker_first` for `/api/*` + the sensitive paths. |
| `web/.assetsignore` | New — excludes `secrets.local.js` and `.shots/` from the published assets. |
| `server.mjs` | Unchanged (kept for local `node server.mjs` dev). |

## What changed from server.mjs
- **Sweep removed.** No `setInterval`/`sweepDemo`/`sacBalance`; `PAYEE_SECRET` and `SWEEP_*` are no
  longer used. This is what makes the app Workers-shaped (no background loop).
- **Waitlist: JSONL file → KV.** `env.WAITLIST.put('wl:'+email, …)`; export lists the `wl:` prefix.
  Durable across deploys (the old `/tmp`/file sink was not).
- **Raw `http` → `fetch(request, env)`**, `process.env.*` → `env.*`, `req/res` → `Request`/`Response`.
- **Static** via `env.ASSETS.fetch` with `not_found_handling: single-page-application`.
- **Secret leak closed.** `web/secrets.local.js` holds real testnet operator seeds and is local-dev
  only; the Worker hard-404s `/secrets.local.js` (+ `.assetsignore`) so it is never published. In
  production the Pay flow uses the server-side relay (`FEE_PAYER_SECRET`), not the client key.

## Env
- **Vars** (`wrangler.jsonc`): `RPC_URL`, `NETWORK_PASSPHRASE`, `USDC_SAC`, `NULTH_ACCOUNT`, `XLM_SAC`,
  `DEMO_PAYEE`, `DEMO_NONALLOWLISTED`, `GROQ_MODEL` — all testnet defaults.
- **Secrets** (`wrangler secret put`):
  - `FEE_PAYER_SECRET` — set (testnet fee-payer, funded). Required for `/api/relay` + `/api/attack`.
  - `GROQ_API_KEY` — optional; without it `/api/agent` uses the deterministic fallback parser.
  - `WAITLIST_EXPORT_KEY` — optional; gates `/api/waitlist/export`.
  - `DEMO_POLICY_SECRET` — optional; without it `/policy_secret.json` falls back to the static file.

## Deploy
```bash
cd /Users/mac/covenant && npx wrangler deploy      # uses the account wrangler OAuth login
```
- **Live (Workers subdomain):** https://nulth.timjosh507.workers.dev
- **Worker name:** `nulth` · **KV:** `WAITLIST` (`41d5b641…10908`)

## Domain (nulth.xyz)
Namecheap nameservers moved to Cloudflare (`duke`/`raquel.ns.cloudflare.com`). `nulth.xyz` and
`www.nulth.xyz` are attached to the `nulth` Worker as custom domains — they serve once the zone
activates. Email (Namecheap Private Email) preserved: `MX`/`SPF`/`SRV` stay DNS-only, and the
`autoconfig`/`autodiscover`/`mail` CNAMEs were switched to grey-cloud (DNS only).

## Verified
`/api/health` (relayer set, funded), static site + `/prover/*.wasm`, `/api/agent` (fallback),
`/api/waitlist` (KV write), `/secrets.local.js` → 404.
