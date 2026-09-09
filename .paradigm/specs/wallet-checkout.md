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

## Hardening (2026-09-09)

Follow-up pass fixing four issues raised by an architect/security review of the checkout
path above. Prompts for this work are logged in `prompts/darren.jsonl`.

1. **Checkout idempotency/dedup.** `POST /checkout` and `POST /agent/checkout` previously
   generated a fresh `idempotency_key` on every `createOrder()` call, so a double-click, a
   timed-out client retry, or an agent retry each created a brand-new order row and (in
   `PAYMENTS_MODE=circle`) a brand-new real Circle transfer. Fixed by
   `#orders-service.reserveOrder()`: the request body may carry an optional
   `idempotencyKey` string, which is scoped per-user (`client:<userId>:<token>`) and
   checked against the `orders` table before inserting; with no client token, a
   `DEDUP_WINDOW_SECONDS = 120` fallback dedups on `(user_id, sku, quantity, amount_usdc)`
   for any order not already `failed`/`denied`/`cancelled`. Both routes now treat a
   deduped resubmission as "no new charge": `/checkout` returns the existing order's
   current state instead of calling `executePayment()` again; `/agent/checkout` reuses
   the existing order and its still-usable verification session instead of minting a
   second one.
2. **Spend-cap TOCTOU race.** `evaluateSpendPolicy()` and the order insert were two
   separate, unlocked round-trips, so two concurrent requests near the daily cap could
   both read "under the cap" before either committed. Fixed by wrapping the dedup check,
   the spend-cap check, and the insert in one Postgres transaction holding
   `pg_advisory_xact_lock(hashtext(userId))` (`reserveOrder()`), serializing concurrent
   reservations for the same user so the check-then-insert is atomic. The daily-cap sum
   also now counts `pending` orders (previously only `submitted`/`confirmed`) — a
   `pending` order is inserted as part of this same atomic check, before payment
   settles, and must reserve its capacity immediately or the lock alone wouldn't close
   the race (two serialized-but-still-concurrent requests would each see "$0 pending"
   and both pass). A `failed`/`denied`/`cancelled` order frees the capacity it held.
   Verified with a concurrency test that fires several simultaneous requests near the
   daily cap and asserts the accepted total never exceeds it (see
   `server/src/services/orders.test.ts`).
3. **Secrets-manager-ready config.** `CIRCLE_API_KEY`/`CIRCLE_ENTITY_SECRET`,
   `JWT_SECRET`, and `WORLD_RP_SIGNING_KEY` now go through
   `server/src/config/secrets.ts` (`getSecret`/`requireSecret`) instead of a bare
   `process.env.X` at each call site (#wallet-service, #auth-service,
   #worldid-service). **This is a seam, not a real secrets-manager integration** — the
   module still just reads env vars. It exists so a real backend (AWS Secrets Manager,
   GCP Secret Manager, Vault, ...) can be dropped in behind `getSecret()` later without
   touching any call site.
4. **Circle Policy Engine hook.** `#orders-service.checkCirclePolicy()` is a new,
   currently no-op extension point, called from `reserveOrder()` at the same point the
   app-level spend caps are checked. Circle's server-side Policy Engine (velocity
   limits, destination allow-listing, transaction screening) is mainnet-only account
   configuration in Circle's console and can't be enabled or simulated from this
   codebase alone; this is the call site where the app would enforce/verify a Policy
   Engine verdict once that account-side config exists.

### Manual/ops follow-up (not doable from code alone)

- **Secrets manager provisioning.** Stand up a real secrets-manager backend (AWS
  Secrets Manager / GCP Secret Manager / Vault) and point `getSecret()` at it; requires
  cloud/infra access this session doesn't have.
- **Circle Policy Engine enablement.** Turn on velocity limits and destination
  allow-listing for the mainnet entity in Circle's console, then wire
  `checkCirclePolicy()` to actually check/enforce that verdict.
- **Entity-secret rotation runbook.** Document (and eventually automate) rotating
  `CIRCLE_ENTITY_SECRET` per Circle's recovery-file process
  (`pnpm register-entity-secret`) without downtime — not attempted here.

## Sharding (2026-09-09)

Follow-up to the "Hardening" pass's #secrets-service seam, implementing the next step
an architect/security review recommended: bound the blast radius of a compromised
Circle API key/entity secret by sharding wallets across multiple key scopes instead of
one key for every user's wallet. Scoped to what's buildable without external
provisioning — real per-shard scoped Circle API keys still have to be created by hand
in Circle's console (see "Manual/ops follow-up" below); the code is written so it works
today with the single existing key and starts using scoped keys the moment they exist,
with no further code change.

1. **Deterministic shard assignment.** `#wallet-service.walletShardId(userId)` =
   `sha256(userId) mod SHARD_COUNT` (env, default `1`). No randomness or lookup table —
   a user always lands on the same shard, in any process, forever. `SHARD_COUNT=1`
   (the default) means every user maps to shard 0, which is exactly today's behavior.
2. **One Circle wallet set per shard.** `wallet_sets` is now keyed by shard (`'default'`
   for shard 0 — reusing the pre-sharding row so an existing deployment's shard-0
   lookups don't change — `'shard-<N>'` for shard `N > 0`), instead of a single
   `'default'` row for the whole app. `user_wallets` gained a `wallet_shard_id integer
   not null default 0` column recording which shard a user's wallet belongs to.
3. **Per-shard Circle client.** `#secrets-service.getShardedSecret(base, shardId)`
   reads `${base}_${shardId}` (e.g. `CIRCLE_API_KEY_2`, `CIRCLE_ENTITY_SECRET_2`),
   falling back to the plain `CIRCLE_API_KEY`/`CIRCLE_ENTITY_SECRET` when no
   shard-specific credential is set. `#wallet-service` resolves and caches one Circle
   client per shard via this seam; wallet creation, transfers, and transaction-status
   polling for a given user all go through that user's shard's client. Until real
   per-shard keys are provisioned, every shard transparently shares the one existing
   key/secret — sharding the *data* (which wallet set a user's wallet lives in) doesn't
   require sharding the *credential* first, but is ready to the moment it is.
4. **Auto-sweep.** `#wallet-service.sweepShardBalances(shardId)` moves any wallet's USDC
   balance above `SWEEP_THRESHOLD_USDC` (env) down to that threshold, transferring the
   excess to `TREASURY_ADDRESS` (env). This bounds a compromised shard key's exposure to
   roughly `SWEEP_THRESHOLD_USDC * (wallets in that shard)` of in-flight funds, instead
   of every balance the shard's wallets have ever held. Unset/non-positive
   `SWEEP_THRESHOLD_USDC` disables sweeping (no-op). **Not wired to a live cron** — this
   repo has no cron/scheduler infrastructure. An ops job would call
   `sweepShardBalances(shardId)` for each of the `SHARD_COUNT` shards on an interval
   (e.g. every few minutes) once one exists; the call site is intentionally a plain
   exported async function so it's trivial to invoke from whatever scheduler a real
   deployment adds (a hosted cron, a queue consumer, etc.).
5. **Backward compatibility is the design constraint, not an afterthought.**
   `SHARD_COUNT=1` must — and does, per `wallet.test.ts` — produce identical behavior to
   pre-sharding: every user resolves to shard 0, shard 0 reuses the `'default'`
   wallet-set row, and shard 0's Circle client falls back to the plain
   `CIRCLE_API_KEY`/`CIRCLE_ENTITY_SECRET`. Sharding is opt-in behind `SHARD_COUNT`.

### Manual/ops follow-up (not doable from code alone)

- **Provision real per-shard Circle API keys/entity secrets.** Create `SHARD_COUNT`
  scoped API keys in Circle's console (one per shard, least-privilege where Circle's
  key scoping allows it) and set `CIRCLE_API_KEY_<N>`/`CIRCLE_ENTITY_SECRET_<N>` per
  shard — requires Circle account/dashboard access this session doesn't have.
- **Wire `sweepShardBalances` to a real cron/scheduler** once this deploys somewhere
  with one (this repo has none).
- **Choose and fund `TREASURY_ADDRESS`**, and decide the operating `SWEEP_THRESHOLD_USDC`
  per the expected in-flight balance per wallet.
- **Backfill `wallet_shard_id` for any pre-existing `user_wallets` rows** if sharding is
  turned on (`SHARD_COUNT > 1`) after users already have shard-0 wallets — today's
  default column value (`0`) already puts them on shard 0, which is correct as long as
  they stay there; migrating an existing user to a different shard (moving their Circle
  wallet, not just the row) is out of scope here.

## Secrets backend (2026-09-09)

Follow-up to the "Hardening" pass's #secrets-service seam. Closes the security finding
that today `CIRCLE_ENTITY_SECRET`/`CIRCLE_API_KEY` are plain env vars — one shared
secret compromise means every user's wallet is compromised, with no encryption at rest.
Adds a `SECRETS_BACKEND` mode to `getSecret()` rather than changing any call site.

1. **`SECRETS_BACKEND=env` (default).** Unchanged — reads `process.env` exactly like
   before this pass.
2. **`SECRETS_BACKEND=ledger-ring`.** For a given secret name, `getSecret()` shells out
   to `wallet-cli ring decrypt --key <name>` via `node:child_process` (no interactive
   prompt — stdout is captured directly) to retrieve the decrypted value, then caches it
   in-memory per key for the rest of the process's life (same lazy-cache shape as the
   rest of #secrets-service). This is backed by Ledger's `wallet-cli ring` tooling,
   verified by architect research this session: `ring init` is a one-time,
   device-present provisioning step (password sourced from an OS keychain via command
   substitution, never typed by an agent); after that, `ring encrypt`/`ring decrypt` run
   with **no device present**, only network access to restore the "trustchain," using an
   AES-256-GCM domain key derived from the ring.
3. **Failure handling never leaks anything but the key name.** If `wallet-cli` isn't
   installed, the named key doesn't exist in the ring, the process exits non-zero, or
   decrypt returns empty output, `getSecret()` throws an error naming only the secret and
   a static hint — never the CLI's stdout or stderr, which could contain partial
   decrypted output or ring diagnostics naming other keys.
4. **Testable without hardware.** This repo does not take `@ledgerhq/wallet-cli` as a
   dependency and no test invokes a real device or binary — `server/src/config/secrets.test.ts`
   mocks `node:child_process`'s `execFileSync`, following the same `vi.hoisted` +
   `vi.mock` pattern `wallet.test.ts` uses for the Circle SDK.

### Manual/ops follow-up (not doable from code alone)

- **`wallet-cli ring init`** — the one-time, device-present enrollment step. A human
  with the physical Ledger device runs this once; the password comes from an OS
  keychain via command substitution (e.g. `--password "$(security find-generic-password ...)"`),
  never typed by an agent or committed anywhere. Not scripted here.
- **`wallet-cli ring encrypt -i <file> -o <name>.enc --key <name>`** per secret
  (`JWT_SECRET`, `CIRCLE_API_KEY`, `CIRCLE_ENTITY_SECRET`, `WORLD_RP_SIGNING_KEY`, ...) —
  also device-present, also a manual ops step. See `server/.env.example`.
- **Choose which secrets actually move to `ledger-ring`** vs. stay on `env` per
  deployment/environment — this pass makes the switch available per-secret-name lookup
  (the backend choice today is process-wide via one `SECRETS_BACKEND` var, not
  per-secret; a mixed setup would need a small follow-up to key the backend choice off
  `SecretName` instead of being global).

## Session-scoped agent grants (2026-09-09)

Follow-up to an architect/security review that recommended migrating per-user Circle
wallets from plain EOAs toward Smart Contract Accounts (SCA) with on-chain session keys
scoped to agent grants, so that even a compromised server/entity-secret is independently
bounded by something other than app-level Postgres checks. **Full on-chain ERC-4337
session-key contract deployment (a real Solidity module + audit) is explicitly OUT OF
SCOPE for this pass** — that needs real infra/audit this session doesn't have. What
shipped instead is the realistic, buildable slice: SDK groundwork for SCA wallets, and
an app-level "session key" abstraction (a revocable, expiring, scoped spend policy)
layered on the existing agent-grant JWTs.

1. **Circle SDK SCA support — confirmed, not guessed.** `@circle-fin/developer-controlled-wallets@10.8.0`'s
   type definitions (`dist/types/clients/developer-controlled-wallets.d.ts`) declare
   `AccountType = { Eoa: "EOA", Sca: "SCA" }`, and `CreateWalletRequest.accountType`
   (used by `createWallets()`) is typed `AccountType`. This is clear, first-class SDK
   support — not ambiguous — so `#wallet-service.walletAccountType()` (env
   `WALLET_ACCOUNT_TYPE`, default `"EOA"`, unchanged behavior) now opts wallet creation
   into `"SCA"` when set. This alone does not attach any on-chain session-key policy
   module to the SCA wallet — it only requests the account *type* Circle creates, which
   is a prerequisite for (not the same as) the deferred on-chain follow-up below.
2. **App-level "session key" for agent grants (#agent-grants-service).** `POST
   /agent/grant` now mints, alongside the existing 365d agent-grant JWT (whose `jti`
   claim identifies it), a Postgres `agent_grants` row recording a scoped spend policy:
   `destination_address` (always `merchantPayoutAddress()`, never client-supplied),
   `per_tx_cap_usdc`/`rolling_cap_usdc` (default to #orders-service's existing
   `PER_TX_CAP_USDC`/`DAILY_CAP_USDC`), and `expires_at` (env
   `AGENT_GRANT_SESSION_TTL_SECONDS`, default 24h) — deliberately much shorter than the
   JWT's own 365d lifetime, so a leaked/long-lived JWT's *ability to spend* is bounded on
   its own, shorter schedule. `POST /agent/checkout` tags the reserved order with its
   originating grant's scoped-policy id (`orders.agent_grant_id`, nullable, no FK since
   the two schemas aren't creation-ordered relative to each other) and does an early,
   best-effort rejection (403) if that grant is already revoked/expired. The
   authoritative check is at settlement: `#verify-route`'s `settleVerifiedSession()`
   calls `#agent-grants-service.evaluateGrantScope()` right before `executePayment()`
   for any order with a non-null `agent_grant_id`, checking revocation, expiry,
   destination match, the per-tx cap, and a rolling-24h sum of that grant's
   non-failed/denied/cancelled orders against the rolling cap — **in addition to, not
   instead of**, `^checkout-authorized`'s app-wide caps. A denial marks the order failed
   (never charges) and surfaces as `grant_scope_denied` (403). This re-check at
   settlement (not just at initiation) matters because the grant can be revoked in the
   window between `/agent/checkout` and the human completing the personhood check.
   Human (`#checkout-route`) orders have no `agent_grant_id` and are completely
   unaffected — see `server/src/services/orders.test.ts` / `agent-grants.test.ts` for
   the tests asserting that.
3. **Early revocation.** `POST /agent/grant/:grantId/revoke` (requires the human's own
   `^authenticated` user token, scoped to the grant's owner) sets `agent_grants.revoked_at`,
   letting a compromised/leaked agent grant be cut off immediately rather than waiting
   out its session TTL (or its much longer JWT expiry). Idempotent — revoking an
   already-revoked grant is a no-op success, not an error.
4. **This is explicitly a pre-chain groundwork, not the on-chain follow-up.** Nothing
   here changes what happens on Arc if the server's Circle API key/entity secret itself
   is compromised — the scoped policy is enforced by this same server, using the same
   Postgres it already trusts. It bounds *accidental or residual* exposure from a leaked
   agent-grant JWT specifically, and is a stepping stone (SCA wallets + a documented
   scope model) toward the real fix.

### Manual/ops + deferred follow-up (not doable from code alone)

- **On-chain ERC-4337 session keys.** Deploy a session-key module (e.g. a Safe/Kernel
  session-key plugin, or a bespoke ERC-4337 validator) on each user's SCA wallet, scoped
  to the merchant payout address / per-tx / rolling caps / expiry — mirroring
  `#agent-grants-service`'s policy shape, but enforced by the chain itself rather than
  by this server. Needs a real Solidity module and a security audit; out of scope here.
- **Migrate existing EOA wallets to SCA.** `WALLET_ACCOUNT_TYPE=SCA` only affects
  *newly created* wallets going forward; migrating a user who already has an EOA wallet
  (moving funds, re-registering the address) is a separate, unattempted ops task.
- **Make the scoped per-tx/rolling caps independently configurable per grant** (today
  they default to the same `PER_TX_CAP_USDC`/`DAILY_CAP_USDC` constants the app-wide
  policy uses) — e.g. a human choosing a stricter cap for one agent than another.

## Ledger confirmation gate (2026-09-09)

`^ledger-confirmed` adds a physical-hardware step-up, on top of everything above, for a
user who has enrolled a Ledger device. It **authorizes** the server to proceed with a
charge — it does not itself submit the on-chain Circle transfer, which still goes
through `#payment-service`/`#wallet-service` exactly as before.

1. **EIP-712 struct.** The device signs a typed-data message binding `{orderId, sku,
   quantity, amountUsdc, destinationAddress, nonce, expiresAt, chainId}` — built by
   `#ledger-confirm-service.buildApprovalTypedData()`. `chainId` defaults to the Arc
   testnet id (env `LEDGER_CONFIRM_CHAIN_ID`); `expiresAt` defaults to
   `LEDGER_APPROVAL_TTL_SECONDS` (300s) from issuance. Binding `orderId` + `nonce` into
   the signed payload, and always reconstructing the hash server-side from the **stored**
   `ledger_approvals.order_snapshot` row (never anything echoed back by the caller in
   `POST /ledger/approvals/:approvalId`), is what makes a tampered amount/destination in
   the request body harmless — the signature simply won't recover to the enrolled
   device's address against the real stored snapshot.
2. **Mock vs. real mode.** `LEDGER_CONFIRM_MODE=mock` (default) exposes `GET
   /ledger/mock/:approvalId`, a click-through auto-approve — the same shape as
   `#worldid-service`'s `VERIFICATION_MODE=mock` page — for demoing without hardware;
   it 409s outside mock mode so it can never stand in for a real device.
   `LEDGER_CONFIRM_MODE=ledger` expects a genuine signature submitted through the normal
   `POST /ledger/approvals/:approvalId` path. **Out of scope for this pass**: the
   companion `ledger-approver/` daemon (a human-run process, sibling to `mcp/`/
   `client/`/`server/`, that would poll `GET /ledger/pending-approvals` and post back a
   real device signature) and the real `@ledgerhq/*` Device Management Kit integration —
   only the server-side gate and a mock/stub boundary were built here.
3. **Structural enforcement.** `#payment-service.executePayment()` takes the full
   `OrderRow` (not discrete order fields) and itself calls
   `getEnrolledDevice()`/`getApprovalForOrder()` before proceeding, throwing
   `LedgerConfirmationRequiredError` otherwise — so there is no plain-argument call path
   that skips the check; a caller cannot construct a `PaymentRequest` that bypasses it.
4. **Fail closed, atomic nonce consumption.** `verifyApproval()` resolves a `pending`
   row to `approved`/`denied`/`expired` (and consumes its nonce) inside one Postgres
   transaction — never left dangling `pending`. `requestApproval(order)` is
   advisory-locked and idempotent per order (mirrors `#orders-service.reserveOrder()`'s
   pattern): a resubmission sharing the order's idempotency key reuses the same
   approval row rather than requiring or accepting a second one.
5. **Replaces, not alongside, for the human path.** For `#checkout-route`, above the
   $10 auto-approve threshold, `^ledger-confirmed` **replaces** the spoofable
   `checkoutConfirmed` boolean for a user with an enrolled device — that user's request
   is never allowed to satisfy the threshold via `checkoutConfirmed` alone. A user with
   no enrolled device keeps today's behavior unchanged.
6. **Runs alongside, not instead of, for the agent path.** For `#verify-route`'s
   `settleVerifiedSession()`, an enrolled-device user's ledger check runs alongside
   `^grant-scope-valid` and `^personhood-verified` — all must pass. A still-pending
   approval reports `pending_ledger_confirmation` and leaves the order `pending` so the
   same verification link can be revisited once the device approves, without re-running
   the selfie check; a denial marks the order failed outright.

### Deferred follow-ups

- **`ledger-approver/` companion daemon.** A human-run process (new top-level package)
  that polls `GET /ledger/pending-approvals`, prompts for a physical tap on the device,
  and posts the resulting signature to `POST /ledger/approvals/:approvalId`. Not built
  this pass — `LEDGER_CONFIRM_MODE=mock`'s click-through page stands in for it.
- **Real `@ledgerhq/*` Device Management Kit integration**, used by the daemon above to
  actually talk to the hardware over WebHID/WebUSB/BLE.
- **Clear Signing spike.** Before relying on a real device for this in production, spend
  a pass validating on-device Clear Signing of the custom EIP-712 fields
  (`sku`/`destinationAddress`/etc., not just a raw hash) against Ledger's partner-program
  requirements — otherwise the human is approving an opaque hash on-screen, which
  defeats much of the point of a hardware step-up.

## Open follow-ups (not in this scaffold)

- Refund/dispute handling (Arc's `arc-escrow` sample app + Refund Protocol) — worth revisiting once
  the happy path works, not needed for v1.
- Real auth (see `^authenticated` above) — the bearer-token-as-user-id stand-in must not reach any
  real deployment.
- Making the $50/$200/$10 thresholds env-configurable instead of hardcoded constants, once there's
  more than one merchant/tenant.
- Circle public-key cache invalidation strategy (currently: cache forever per process lifetime —
  fine for a hackathon demo, not for long-running production processes).
