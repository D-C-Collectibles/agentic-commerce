// #orders-service — primitives shared by both checkout paths (#checkout-route for a
// human, #agent-route for an AI agent): the products/orders schema, price lookup,
// the spend policy, idempotent order reservation, and order creation/status. Kept in
// one place so the two sibling paths enforce identical rules and can't drift apart.

import { randomUUID } from "node:crypto";
import { log } from "@a-company/paradigm-logger";
import type { PoolClient } from "pg";
import { pool } from "../db.js";

// Spend policy (USDC), applied identically on both paths.
export const PER_TX_CAP_USDC = 50;
export const DAILY_CAP_USDC = 200;
// Human path only: above this, an in-browser purchase needs an explicit confirm.
// The agent path always requires a personhood (selfie) check instead, so it ignores this.
export const AUTO_APPROVE_THRESHOLD_USDC = 10;

// A client resubmission (double-click, timed-out fetch retry, agent retry) for the same
// (user, sku, quantity, amount) within this window is treated as the *same* purchase
// attempt rather than a new one — see reserveOrder() and
// .paradigm/specs/wallet-checkout.md "Hardening".
export const DEDUP_WINDOW_SECONDS = 120;

// A 'pending' order under a client-supplied idempotency key with no circle_transaction_id
// set that's older than this is treated as abandoned (the payment call presumably threw
// before this hardening existed, or the process died mid-request) rather than a live
// in-flight attempt — see findDuplicateOrder(). A real transferUsdc()/executePayment()
// call submits synchronously within seconds; a few minutes is generous headroom above
// that before we reclaim the slot.
export const STALE_PENDING_SECONDS = 180;

export const ORDER_STATUS = {
  pending: "pending",
  submitted: "submitted",
  confirmed: "confirmed",
  failed: "failed",
  denied: "denied",
  cancelled: "cancelled",
} as const;
export type OrderStatus = (typeof ORDER_STATUS)[keyof typeof ORDER_STATUS];

// ponytail: CREATE TABLE IF NOT EXISTS instead of a migration framework — fine at hackathon scale.
export async function ensureOrderSchema(): Promise<void> {
  await pool.query(`
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
      circle_transaction_id text unique,
      status text not null default 'pending'
        check (status in ('pending','submitted','confirmed','failed','denied','cancelled')),
      -- No FK to agent_grants(id): null for human orders, and this table's
      -- ensureOrderSchema() may run before #agent-grants-service's ever does (the two
      -- services are siblings, not ordered relative to each other). Referential
      -- integrity here isn't load-bearing — #agent-grants-service.evaluateGrantScope()
      -- treats a dangling/missing grant id as a denial, not a crash.
      agent_grant_id uuid,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );
    create index if not exists orders_user_created_idx on orders (user_id, created_at);
    alter table orders add column if not exists agent_grant_id uuid;
    create index if not exists orders_agent_grant_idx on orders (agent_grant_id, created_at);
  `);
}

export interface CheckoutInput {
  sku: string;
  quantity: number;
}

// Validates the shared { sku, quantity } body used by both checkout paths.
export function parseCheckoutInput(body: unknown): CheckoutInput | null {
  const { sku, quantity } = (body ?? {}) as { sku?: unknown; quantity?: unknown };
  if (typeof sku !== "string" || !sku) return null;
  if (!Number.isInteger(quantity) || (quantity as number) < 1) return null;
  return { sku, quantity: quantity as number };
}

// Optional client-supplied idempotency token, shared by both checkout paths (see
// reserveOrder()). Kept loose (any non-empty string) — the client can pass a UUID, a
// request-scoped nonce, whatever it already generates for retry-safety.
export function parseClientIdempotencyKey(body: unknown): string | undefined {
  const { idempotencyKey } = (body ?? {}) as { idempotencyKey?: unknown };
  return typeof idempotencyKey === "string" && idempotencyKey ? idempotencyKey : undefined;
}

export async function getProductPrice(sku: string): Promise<number | null> {
  const { rows } = await pool.query<{ price_usdc: string }>(
    "select price_usdc from products where sku = $1",
    [sku],
  );
  return rows[0] ? Number(rows[0].price_usdc) : null;
}

export interface SpendPolicyResult {
  ok: boolean;
  cap?: "per_tx" | "daily" | "circle_policy";
  limitUsdc?: number;
}

// A queryable is either the shared pool or a checked-out client already inside a
// transaction — lets evaluateSpendPolicy run against the same transaction/lock as the
// order insert in reserveOrder() below, instead of a second unlocked round-trip.
type Queryable = Pick<PoolClient, "query">;

// Per-tx and rolling-24h daily caps. Every order that hasn't (yet) failed/been-denied/
// been-cancelled counts toward the daily total — including 'pending' ones. That's
// deliberate: reserveOrder() inserts a 'pending' order atomically as part of this same
// check, and that reservation must count immediately, before the payment settles to
// 'submitted'/'confirmed'. Counting only settled orders is what let the old TOCTOU race
// through — two concurrent requests could both see "$0 pending" and both pass the cap
// before either had settled. A failed/denied/cancelled order frees the capacity it held.
export async function evaluateSpendPolicy(
  userId: string,
  amountUsdc: number,
  queryable: Queryable = pool,
): Promise<SpendPolicyResult> {
  if (amountUsdc > PER_TX_CAP_USDC) {
    log.gate("^checkout-authorized").warn("Per-tx spend cap exceeded", { userId, amountUsdc });
    return { ok: false, cap: "per_tx", limitUsdc: PER_TX_CAP_USDC };
  }
  const { rows } = await queryable.query<{ total: string | null }>(
    `select sum(amount_usdc) as total from orders
     where user_id = $1 and status not in ('failed', 'denied', 'cancelled')
       and created_at > now() - interval '1 day'`,
    [userId],
  );
  const dailyTotal = Number(rows[0]?.total ?? 0);
  if (dailyTotal + amountUsdc > DAILY_CAP_USDC) {
    log.gate("^checkout-authorized").warn("Daily spend cap exceeded", { userId, amountUsdc, dailyTotal });
    return { ok: false, cap: "daily", limitUsdc: DAILY_CAP_USDC };
  }
  return { ok: true };
}

// #circle-policy-hook — currently a no-op. Circle's server-side Policy Engine (velocity
// limits, destination allow-listing, transaction screening) is mainnet-only account
// configuration in Circle's console — it isn't something this codebase can enable or
// simulate. This is the call site (same point as the app-level spend caps, before an
// order is reserved) where the app would enforce/verify a Circle Policy Engine verdict
// once that account-side config exists — e.g. checking a policy decision surfaced on
// the transaction response, or calling a policy pre-check endpoint before transferUsdc().
// TODO(ops): enable Circle Policy Engine on the mainnet entity, then replace this stub.
export async function checkCirclePolicy(_input: {
  userId: string;
  amountUsdc: number;
  destinationAddress: string;
}): Promise<SpendPolicyResult> {
  return { ok: true };
}

const ORDER_COLUMNS_SQL = `id, user_id, sku, quantity, amount_usdc, destination_address,
  idempotency_key, status, circle_transaction_id, agent_grant_id, created_at`;

export interface OrderRow {
  id: string;
  user_id: string;
  sku: string;
  quantity: number;
  amount_usdc: string;
  destination_address: string;
  idempotency_key: string;
  status: OrderStatus;
  circle_transaction_id: string | null;
  // Set only for agent-initiated orders, to the #agent-grants-service row minted
  // alongside the agent grant that reserved this order. Null for human (#checkout-route)
  // orders — those aren't scoped to a grant at all.
  agent_grant_id: string | null;
  created_at: Date;
}

export async function getOrder(orderId: string): Promise<OrderRow | null> {
  const { rows } = await pool.query<OrderRow>(
    `select ${ORDER_COLUMNS_SQL} from orders where id = $1`,
    [orderId],
  );
  return rows[0] ?? null;
}

// A client-supplied idempotency token is scoped to (user, token) so two different users
// can't collide on the same client-generated string, and stored with a prefix so it can
// never collide with a server-generated randomUUID() key either.
function scopedIdempotencyKey(userId: string, clientIdempotencyKey: string): string {
  return `client:${userId}:${clientIdempotencyKey}`;
}

function isStalePendingOrder(order: OrderRow): boolean {
  if (order.status !== ORDER_STATUS.pending || order.circle_transaction_id) return false;
  const ageSeconds = (Date.now() - new Date(order.created_at).getTime()) / 1000;
  return ageSeconds > STALE_PENDING_SECONDS;
}

// Reclaims a stale pending order (see STALE_PENDING_SECONDS): marks it failed so it
// immediately stops eating into the daily spend cap, and rewrites its idempotency_key
// so the original client-supplied key is freed up for a fresh attempt (the column is
// unique, so the stale row can't just be left holding it). Must run inside the caller's
// per-user advisory-locked transaction.
async function reclaimStalePendingOrder(client: PoolClient, order: OrderRow): Promise<void> {
  const staleKey = `${order.idempotency_key}:stale:${randomUUID()}`;
  await client.query(
    "update orders set status = $1, idempotency_key = $2, updated_at = now() where id = $3",
    [ORDER_STATUS.failed, staleKey, order.id],
  );
  log.component("#orders-service").warn("Reclaimed stale pending order stuck under an idempotency key", {
    orderId: order.id,
  });
}

async function findDuplicateOrder(
  client: PoolClient,
  input: { userId: string; sku: string; quantity: number; amountUsdc: number; clientIdempotencyKey?: string },
): Promise<OrderRow | null> {
  if (input.clientIdempotencyKey) {
    const key = scopedIdempotencyKey(input.userId, input.clientIdempotencyKey);
    const { rows } = await client.query<OrderRow>(
      `select ${ORDER_COLUMNS_SQL} from orders where idempotency_key = $1`,
      [key],
    );
    const existing = rows[0];
    if (!existing) return null;
    if (isStalePendingOrder(existing)) {
      // A payment attempt that never came back (e.g. the process died before the
      // try/catch around executePayment()/transferUsdc() could mark it failed). Reclaim
      // it so this retry isn't wedged behind a dead order forever.
      await reclaimStalePendingOrder(client, existing);
      return null;
    }
    return existing;
  }

  // No client-supplied token: fall back to a short dedup window on (user, sku,
  // quantity, amount) so a double-click or a timed-out client retry with no way to
  // pass a token still doesn't create a second order + a second real Circle transfer.
  // Failed/denied/cancelled attempts don't count — a genuinely failed purchase should
  // be retryable immediately, not blocked by its own dedup window.
  const { rows } = await client.query<OrderRow>(
    `select ${ORDER_COLUMNS_SQL} from orders
     where user_id = $1 and sku = $2 and quantity = $3 and amount_usdc = $4
       and status not in ('failed', 'denied', 'cancelled')
       and created_at > now() - interval '${DEDUP_WINDOW_SECONDS} seconds'
     order by created_at desc
     limit 1`,
    [input.userId, input.sku, input.quantity, input.amountUsdc.toFixed(2)],
  );
  return rows[0] ?? null;
}

export interface ReserveOrderInput {
  userId: string;
  sku: string;
  quantity: number;
  amountUsdc: number;
  destinationAddress: string;
  clientIdempotencyKey?: string;
  // #agent-route only: the #agent-grants-service row for the grant that's reserving
  // this order, so #verify-route's settlement can later check it against that grant's
  // scoped policy. Undefined for human (#checkout-route) orders.
  agentGrantId?: string;
}

export interface ReserveOrderResult {
  // false whenever an order was NOT (newly) created: either a spend-cap/policy denial
  // (order is null) or a deduped resubmission (order is the existing row). Callers must
  // only call transferUsdc()/executePayment() when isNew is true.
  isNew: boolean;
  policy: SpendPolicyResult;
  order: OrderRow | null;
}

// The single write path for both checkout legs: dedups a resubmission, then atomically
// checks the spend policy (app caps + the Circle Policy Engine hook) and inserts the
// order, all under a per-user Postgres advisory lock so two concurrent requests near a
// cap can't both read "under the cap" before either commits (see
// .paradigm/specs/wallet-checkout.md "Hardening").
export async function reserveOrder(input: ReserveOrderInput): Promise<ReserveOrderResult> {
  const tracker = log.component("#orders-service").start("Reserving order", {
    userId: input.userId,
    sku: input.sku,
    quantity: input.quantity,
  });
  const client = await pool.connect();
  try {
    await client.query("begin");
    // Advisory lock keyed on the user id, scoped to this transaction (released
    // automatically on commit/rollback). Serializes every reserveOrder() call for the
    // same user so the check-then-insert below is atomic without a table-level lock.
    await client.query("select pg_advisory_xact_lock(hashtext($1))", [input.userId]);

    const duplicate = await findDuplicateOrder(client, input);
    if (duplicate) {
      await client.query("commit");
      tracker.success("Deduped resubmission", { orderId: duplicate.id });
      return { isNew: false, policy: { ok: true }, order: duplicate };
    }

    const policy = await evaluateSpendPolicy(input.userId, input.amountUsdc, client);
    if (!policy.ok) {
      await client.query("commit");
      tracker.error("Spend cap denied", { cap: policy.cap });
      return { isNew: false, policy, order: null };
    }

    const circlePolicy = await checkCirclePolicy({
      userId: input.userId,
      amountUsdc: input.amountUsdc,
      destinationAddress: input.destinationAddress,
    });
    if (!circlePolicy.ok) {
      await client.query("commit");
      tracker.error("Circle policy denied", { cap: circlePolicy.cap });
      return { isNew: false, policy: circlePolicy, order: null };
    }

    const idempotencyKey = input.clientIdempotencyKey
      ? scopedIdempotencyKey(input.userId, input.clientIdempotencyKey)
      : randomUUID();

    const { rows } = await client.query<OrderRow>(
      `insert into orders (user_id, sku, quantity, amount_usdc, destination_address, idempotency_key, agent_grant_id)
       values ($1, $2, $3, $4, $5, $6, $7)
       returning ${ORDER_COLUMNS_SQL}`,
      [
        input.userId,
        input.sku,
        input.quantity,
        input.amountUsdc.toFixed(2),
        input.destinationAddress,
        idempotencyKey,
        input.agentGrantId ?? null,
      ],
    );
    await client.query("commit");
    tracker.success("Order reserved", { orderId: rows[0].id });
    return { isNew: true, policy, order: rows[0] };
  } catch (error) {
    await client.query("rollback");
    tracker.error("Order reservation failed", { error: (error as Error).message });
    throw error;
  } finally {
    client.release();
  }
}

export async function markOrderPaid(
  orderId: string,
  transactionId: string,
  status: OrderStatus,
): Promise<void> {
  await pool.query(
    "update orders set circle_transaction_id = $1, status = $2, updated_at = now() where id = $3",
    [transactionId, status, orderId],
  );
  log.component("#orders-service").info("Order marked paid", { orderId, status });
}

// Called whenever executePayment()/transferUsdc() (or the markOrderPaid() write right
// after it) throws for an order reserveOrder() already inserted. Moves it straight to
// 'failed' so it stops (a) counting toward the caller's rolling daily spend cap
// (evaluateSpendPolicy excludes failed/denied/cancelled) and (b) wedging its
// idempotency key against a dead order forever (findDuplicateOrder only dedupes against
// non-failed/denied/cancelled rows). Leaving a payment exception unhandled — letting the
// order sit at 'pending' — was the HIGH-severity bug this closes.
export async function markOrderFailed(orderId: string, reason: string): Promise<void> {
  await pool.query(
    "update orders set status = $1, updated_at = now() where id = $2",
    [ORDER_STATUS.failed, orderId],
  );
  log.component("#orders-service").error("Order marked failed", { orderId, reason });
}
