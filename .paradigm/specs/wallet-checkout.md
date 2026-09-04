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

## `^authenticated` (concrete design)

No session system exists in this repo (hackathon scale — no users table, no login flow). Stand-in:

- Header `Authorization: Bearer <userId>` where `<userId>` is literally the user's id — no signing,
  no expiry, no lookup. Middleware just extracts it and rejects (`401`) if the header is missing or
  empty.
- **This is explicitly not real auth.** It proves nothing about who's holding the token — anyone who
  knows/guesses a user id can act as that user. A real implementation needs: an actual login flow
  issuing opaque or signed (JWT) session tokens, a sessions/users table, token expiry, and revocation.
  Flag this loudly in code (`// HACKATHON STAND-IN — see .paradigm/specs/wallet-checkout.md`) so it's
  never mistaken for production auth.

## `^checkout-authorized` (concrete design)

Circle's built-in spending policies are mainnet-only and scoped to agent-owned wallets, so they
don't apply to per-user Developer-Controlled wallets. Guardrails here are app-level, enforced in the
`POST /checkout` handler after `^authenticated`, before `transferUsdc()` is called:

1. **Server-side price recompute.** The client never sends an amount. Request identifies what's
   being bought (`sku` + `quantity`); the server looks up price from a `products` table and computes
   `amountUsdc = price_usdc * quantity`. The destination address is also never client-supplied — it
   comes from a server-side `MERCHANT_PAYOUT_ADDRESS` env var (add to `server/.env.example`).
2. **Spend caps** (simple numeric defaults, app constants — not env-configurable yet):
   - Per-tx cap: **$50 USDC**. Reject (do not transfer) if `amountUsdc > 50`.
   - Per-user daily cap: **$200 USDC**. Reject if `amountUsdc` + sum of that user's `submitted`/
     `confirmed` orders' `amount_usdc` in the trailing 24h would exceed 200.
   - Both checks read from the `orders` table (see below) — no separate counter table, just a `SUM`
     query scoped to `user_id` and a rolling 24h window (`created_at > now() - interval '1 day'`).
3. **Explicit confirmation above a small auto-approve threshold**: **$10 USDC**. If
   `amountUsdc <= 10`, proceed without requiring confirmation. If `amountUsdc > 10`, the request body
   must include `"checkoutConfirmed": true` (an explicit `!checkout-confirmed` flag from the caller,
   never inferred from free text) or the handler responds `428 Precondition Required` without calling
   `transferUsdc()`.

### Postgres tables (new — created via `create table if not exists`, matching the pattern in
`server/src/services/wallet.ts`)

```sql
create table if not exists products (
  sku text primary key,
  name text not null,
  price_usdc numeric(12,2) not null
);

create table if not exists orders (
  id uuid primary key default gen_random_uuid(),
  user_id text not null,
  sku text not null references products(sku),
  quantity integer not null,
  amount_usdc numeric(12,2) not null,
  destination_address text not null,
  idempotency_key text not null unique,
  circle_transaction_id text unique,        -- set once transferUsdc() returns
  status text not null default 'pending'
    check (status in ('pending','submitted','confirmed','failed','denied','cancelled')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists orders_user_created_idx on orders (user_id, created_at);
```

- `orders` is both the idempotency ledger and the spend-cap source of truth (`SUM(amount_usdc)`
  over trailing 24h, filtered to `status in ('submitted','confirmed')` so failed/denied attempts
  don't count against the cap).
- Row lifecycle: insert as `pending` with a freshly generated `idempotency_key` (passed through to
  `transferUsdc()`) → on success set `circle_transaction_id` and `status = 'submitted'` → webhook
  later flips `status` to `confirmed`/`failed`/`denied`/`cancelled`.
- `products` needs at least one seed row for a demo SKU; seeding is a builder/ops task, not part of
  this spec.

### `POST /checkout` request/response shape

Request:
```json
{
  "sku": "widget-1",
  "quantity": 2,
  "checkoutConfirmed": false
}
```
Header: `Authorization: Bearer <userId>`

Responses:
- `200` — transfer submitted:
  `{ "orderId": "...", "circleTransactionId": "...", "amountUsdc": "20.00", "state": "INITIATED" }`
- `401` — missing/empty bearer token.
- `404` — unknown `sku`.
- `428 Precondition Required` — amount above $10 and `checkoutConfirmed` missing/false:
  `{ "error": "confirmation_required", "amountUsdc": "20.00", "threshold": "10.00" }`
- `402 Payment Required` — a spend cap would be exceeded:
  `{ "error": "spend_cap_exceeded", "cap": "per_tx" | "daily", "limit": "50.00" | "200.00", "amountUsdc": "..." }`

## Webhooks (`^webhook-signature-verified`, concrete design)

- Public HTTPS endpoint registered in Circle's console: `POST /webhooks/circle`.
- Circle signs webhook payloads: verify using the `X-Circle-Signature` (base64 ECDSA signature over
  the raw request body) and `X-Circle-Key-Id` headers. Fetch Circle's public key for that key id
  (`GET https://api.circle.com/v2/notifications/publicKey/{keyId}` — cache in-process, keys don't
  rotate per-request) and verify with `crypto.verify` (ES256 / SHA-256) over the **raw** body bytes.
  Reject with `401` on any failure (missing headers, unknown key id, bad signature) before touching
  the payload.
  - **Implementation note for the builder:** `server/src/index.ts` currently mounts a global
    `express.json()` before both routers, which discards the raw bytes needed for signature
    verification. The webhook route needs access to the raw body (e.g. `express.json({ verify: (req,
    _res, buf) => { req.rawBody = buf } })` applied globally, or a route-specific `express.raw()` +
    manual JSON.parse after verification). Pick one; either can coexist with `/checkout`'s normal
    JSON parsing.
- Payload identifies the Circle transaction (`transactionId`) and its new `state`. Look up the order
  by `circle_transaction_id`, and idempotently `update orders set status = $1, updated_at = now()
  where circle_transaction_id = $2` (map Circle's `COMPLETE` → `confirmed`, `FAILED`/`DENIED`/
  `CANCELLED` → the matching lowercase status). Running the same webhook delivery twice is safe:
  the update is a no-op the second time since it sets the same terminal value. Emit
  `!payment-confirmed` / `!payment-failed` after the row update, not before.
- Webhook payload — not the initial API response — is the source of truth for terminal transaction
  state (`COMPLETE` / `FAILED` / `DENIED` / `CANCELLED`).

## Rollout

1. Arc testnet + Circle sandbox API key, full checkout dry run with test USDC.
2. Only after that passes: register a mainnet entity secret and fund real wallets.

## Open follow-ups (not in this scaffold)

- Refund/dispute handling (Arc's `arc-escrow` sample app + Refund Protocol) — worth revisiting once
  the happy path works, not needed for v1.
- Real auth (see `^authenticated` above) — the bearer-token-as-user-id stand-in must not reach any
  real deployment.
- Making the $50/$200/$10 thresholds env-configurable instead of hardcoded constants, once there's
  more than one merchant/tenant.
- Circle public-key cache invalidation strategy (currently: cache forever per process lifetime —
  fine for a hackathon demo, not for long-running production processes).
