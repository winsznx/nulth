# Give an AI agent a spend-safe account

Autonomous agents increasingly need to pay for things — APIs, data, services. The problem is trust: hand an agent a key and a jailbreak or a bad tool call can drain the wallet. Nulth gives an agent an account it can **spend from but cannot drain**.

## The setup

1. **Create an account** whose allowlist is exactly the services the agent is allowed to pay, and whose cap is the most it may spend per payment. (See [Create & fund](create-and-fund.md).)
2. **Fund it** with only what the agent should be able to work with.
3. **Let the agent spend** by generating proofs for payments to allowlisted services. Each payment carries a proof that it's within cap and to an allowed destination.

## Why a compromised agent can't drain it

The guarantee is structural, not behavioral:

- A payment to a **non-allowlisted** address (an attacker) is **unprovable** — the circuit is unsatisfiable, so no transaction can be formed. Prompt-inject the agent all you like; it cannot construct authorization for a destination you didn't allow.
- A payment **over the cap** is likewise unprovable.
- The agent holds **no key** that can move funds by itself — only the ability to prove policy-compliant payments.

You can watch this live in the app's **Agent Desk**: a real agent runs, and a jailbreak attempt to redirect funds to an attacker produces no proof and no transfer — while its legitimate, allowlisted payments settle normally.

## Honest bounds

Nulth converts "an agent can lose everything" into "an agent can lose at most, to only whom you allowed." Two things to hold in view:

- Whatever process proves on the agent's behalf **holds the policy secret**; if that is compromised, the attacker can still make *policy-compliant* payments (allowlisted destinations, under cap). The loss is **bounded to your policy**, not unbounded.
- The **admin** can `freeze()` the account instantly if something looks wrong (see [Governance](../how-it-works/governance.md)).

This is the right shape for agentic payments: bounded, allowlisted, revocable — with the bound enforced by the chain, not by hoping the agent behaves.
