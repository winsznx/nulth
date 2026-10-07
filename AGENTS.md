# How AI was used to build Nulth

Nulth was built with heavy AI assistance. This file states plainly what the AI did, what a human
did, and which results are real on-chain facts versus AI-generated text. Nothing here is spin.

## What the AI did

- **Strategy, architecture, and review** — a Claude assistant did the planning: breaking the work into
  scoped, gated passes (one feature or one document per pass), writing the prompts, and reviewing the
  diffs and the documentation for accuracy.
- **Implementation** — Claude Code wrote the contract, circuits, scripts, and frontend. Every scoped
  prompt was run against **real Stellar testnet** (Protocol 26). The transaction hashes in the reports
  and docs are **real on-chain results** — settled or rejected ledger entries — **not AI-asserted
  outcomes**. Anyone can click them on stellar.expert and verify the result independently.
- **Some early docs + the competitive landscape** were first drafted by a multi-agent "stellar-build"
  skill. Those drafts contained errors (stale contract IDs, a wrong error-code attribution, an
  overstated trusted-setup claim). They were **reconciled to the vetted facts and the real repo** in a
  dedicated pass — see [REPORT_DOC_RECONCILE.md](./REPORT_DOC_RECONCILE.md). We disclose the process,
  not just the result.

## The `/agent` demo's brain (deployed path)

The **deployed** Agent Desk (`/agent` route → `server.mjs` `/api/agent`) uses a **Groq LLM when
`GROQ_API_KEY` is configured, and a deterministic regex parser fallback otherwise** — `/api/health`
reports which (`agent: "groq" | "fallback"`). Either way the LLM is **only an intent translator**
(English → `{action, to, amount}`), **not** the guardrail: an out-of-policy instruction is *attempted*
and then cryptographically **refused by the account** because no valid proof can be formed. A separate
**legacy** driver (`scripts/agent_server.mjs`) wraps a real Claude via the `claude` CLI (no
`ANTHROPIC_API_KEY`/`@anthropic-ai/sdk` — the CLI uses existing auth); it is **not** the deployed
entrypoint. (Source: [REPORT_AGENT_DECK.md](./REPORT_AGENT_DECK.md).)

## What a human verified — not the AI

- **The manual Freighter run.** A person installed the Freighter wallet, deployed their **own** Nulth
  account through the UI, funded it, and made a real payment — and confirmed an out-of-policy payment is
  refused. Account `CA5PGJ65…`, deploy `3e5094f7`, payment `f4dae3cb` (SUCCESS). This leg cannot run
  headless (a browser extension), so it was done by hand. (Source:
  [REPORT_CREATE_FLOW.md](./REPORT_CREATE_FLOW.md).)
- **Every on-chain transaction.** The settlements and rejections are real Stellar ledger entries. The AI
  reported them; the **chain produced them**. They are independently checkable — that is the point.

## What is mocked / self-hosted (also disclosed)

The agent service-payment path is a self-hosted, allowlisted path — **not** the strict x402 wire
protocol. The Tier-1 `regulatory_max` is self-provided (no real KYC oracle). A demo operator key pays
the XLM fees and submits transactions; it is **not** a prover and cannot authorize a spend. Details in
[SECURITY.md](./SECURITY.md) §7.
