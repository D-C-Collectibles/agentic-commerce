# $checkout-flow — agent-initiated wallet checkout

Produced by the architect/security/reviewer pass (`.paradigm/orchestrations/orch-2026-09-04-mtncz8r1-zp5a*`),
run 2026-09-04. Prompts for this work are logged in `prompts.jsonl` per the repo's hackathon
AI-usage rule.

## Goal

Let a Claude Code agent session complete an e-commerce checkout on behalf of a signed-in user,
paying in USDC, without the agent ever holding funds or private keys itself.

## Custody model

- **Circle Developer-Controlled Wallets SDK** — one wallet per user, created and held server-side.
- Entity secret lives only in `server/.env` (never committed, never sent to the LLM). Registered
  manually by a human per Circle's docs — not something an agent should do on a developer's behalf.
- Settlement chain: Arc (testnet first — chain id `5042002`, `rpc.testnet.arc.io`), gas paid in
  USDC natively.
- Rejected alternative: Circle Agent Wallets (agent-stack `circle wallet` CLI). That product gives
  one wallet *to the agent identity itself* — right for agent-to-API micropayments (x402), wrong
  shape for "agent spends a specific user's money."

## Flow

```
#cart
  -> #price-check        (server recomputes total server-side, never trusts agent/client input)
  -> ^checkout-authorized (spending-policy + confirmation check, see below)
  -> #circle-wallet-transfer (Developer-Controlled Wallets SDK, idempotencyKey per attempt)
  -> !payment-submitted
  -> (Circle webhook, signature-verified) !payment-confirmed | !payment-failed
  -> #order-confirmation
```

## Guardrails (`^checkout-authorized`)

Circle's built-in spending policies are mainnet-only and scoped to agent-owned wallets, so they
don't apply to per-user Developer-Controlled wallets. Guardrails here are app-level:

- Per-user, per-tx/daily USDC caps checked before every transfer.
- Amounts under a small auto-approve threshold proceed without interruption; amounts above it
  require an explicit `!checkout-confirmed` signal from the user (never inferred from agent
  free-text) before the transfer fires.
- `^authenticated` required upstream on all checkout routes.

## Webhooks

- Public HTTPS endpoint registered in Circle's console.
- Verify `X-Circle-Signature` / `X-Circle-Key-Id` — protected by `^webhook-signature-verified`,
  not `^authenticated` (no user session on a webhook call).
- Webhook payload — not the initial API response — is the source of truth for terminal transaction
  state (`COMPLETE` / `FAILED` / `DENIED` / `CANCELLED`). Order updates are idempotent, keyed by
  the Circle transaction id.

## Rollout

1. Arc testnet + Circle sandbox API key, full checkout dry run with test USDC.
2. Only after that passes: register a mainnet entity secret and fund real wallets.

## Open follow-ups (not in this scaffold)

- Refund/dispute handling (Arc's `arc-escrow` sample app + Refund Protocol) — worth revisiting once
  the happy path works, not needed for v1.
- Actual Circle SDK wiring, entity secret registration, and portal gate middleware implementation.
