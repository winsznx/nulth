# Nulth — web

Faithful standalone implementation of the Claude Design handoff (`Nulth.dc.html`).
Vanilla JS SPA, no build step. The institutional Mercury/Linear aesthetic, Geist +
Geist Mono, light app shell + dark operator surfaces — recreated pixel-for-pixel from
the design, with the **real deployed contract IDs and the real verify cost** wired in.

## Run

```bash
python3 -m http.server -d web 8080
# open http://localhost:8080/
```

No network needed except Google Fonts (Geist). Everything else is local.

## Layout

```
web/
  index.html   # shell: Geist fonts + the design's global styles/keyframes
  app.js       # the ported logic class + all 8 screens (inline styles verbatim)
  prover/      # (existing) the real in-browser DEPTH-16 Groth16 prover harness
  README.md
```

## Screens (routes)

| Screen | What it is |
|---|---|
| Landing | the one-sentence pitch · private→public thesis card · "no private key" · the two numbers |
| Dashboard | balance, metric cards, activity, security panel, verify-cost-vs-ceiling gauge |
| Policy | live private-state-vs-public-commitment split; drag the cap → commitment recomputes |
| Agent Desk | the Jailbreak Terminal: agent stream + attack console; inject → chain rejects |
| Exploitation Deck | 8 attack cards; run → REJECTED_BY_AUTH_LAYER receipt with the error code |
| Verify | the Truth Slider: prove `cap ≤ limit` without revealing the cap |
| Activity | proof-authorized ledger |
| X-Ray Ledger | drag the lens; exposed treasury data dissolves into the proof |

## Real data wired in (`REAL` in app.js)

These are the on-chain facts from the deployment, used everywhere the UI shows a headline number:

- account `CAKSFFBTLDMHS4BH4ABTUVNN3WN5XO3WYIRD4ZNXELDXN5GGBNA77QQW`
- verifier `CCKBPVP7MZJOQYU44RK5MG4PA2YKV4UQ7CJMPK3OIHNFHLG5PEMNDREG`
- verify cost **8.537%** of the 400M ceiling (34,149,591 instr, DEPTH-16)
- a real proof-authorized payment tx `8d204b9b…`

## Wiring the LIVE routes to the chain (next)

The prototype's demo data is illustrative (vendors, activity, balances). The chain-gated
flows attach here:

- **Policy** — replace `hashFor()` previews with the real `circomlibjs` Poseidon commitment/root
  (the `scripts/policy.mjs` logic), proving in-browser via `web/prover/`.
- **Verify** — generate the Tier-1 `cap ≤ regulatory_max` proof client-side and verify against
  the deployed account.
- **Agent Desk / Exploitation Deck** — dispatch the real payloads through `scripts/pay_p1.mjs`
  / the negative-control matrix and read back the on-chain error codes + tx hashes.

`onSlider`/`dispatch` in `app.js` are the seams where simulated handlers become real
`stellar-sdk` calls.
