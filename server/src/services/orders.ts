// #orders-service — primitives shared by both checkout paths (#checkout-route for a
// human, #agent-route for an AI agent): the products/orders schema, price lookup,
// the spend policy, and order creation/status. Kept in one place so the two sibling
// paths enforce identical rules and can't drift apart.

import { randomUUID } from "node:crypto";
import { pool } from "../db.js";

// Spend policy (USDC), applied identically on both paths.
export const PER_TX_CAP_USDC = 50;
export const DAILY_CAP_USDC = 200;
// Human path only: above this, an in-browser purchase needs an explicit confirm.
// The agent path always requires a personhood (selfie) check instead, so it ignores this.
export const AUTO_APPROVE_THRESHOLD_USDC = 10;

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
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );
    create index if not exists orders_user_created_idx on orders (user_id, created_at);
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

export async function getProductPrice(sku: string): Promise<number | null> {
  const { rows } = await pool.query<{ price_usdc: string }>(
    "select price_usdc from products where sku = $1",
    [sku],
  );
  return rows[0] ? Number(rows[0].price_usdc) : null;
}

export interface SpendPolicyResult {
  ok: boolean;
  cap?: "per_tx" | "daily";
  limitUsdc?: number;
}

// Per-tx and rolling-24h daily caps. Only submitted/confirmed orders count toward the
// daily total — failed/denied/cancelled ones don't.
export async function evaluateSpendPolicy(userId: string, amountUsdc: number): Promise<SpendPolicyResult> {
  if (amountUsdc > PER_TX_CAP_USDC) {
    return { ok: false, cap: "per_tx", limitUsdc: PER_TX_CAP_USDC };
  }
  const { rows } = await pool.query<{ total: string | null }>(
    `select sum(amount_usdc) as total from orders
     where user_id = $1 and status in ('submitted', 'confirmed') and created_at > now() - interval '1 day'`,
    [userId],
  );
  const dailyTotal = Number(rows[0]?.total ?? 0);
  if (dailyTotal + amountUsdc > DAILY_CAP_USDC) {
    return { ok: false, cap: "daily", limitUsdc: DAILY_CAP_USDC };
  }
  return { ok: true };
}

export interface CreateOrderInput {
  userId: string;
  sku: string;
  quantity: number;
  amountUsdc: number;
  destinationAddress: string;
}

export async function createOrder(input: CreateOrderInput): Promise<{ orderId: string; idempotencyKey: string }> {
  const idempotencyKey = randomUUID();
  const { rows } = await pool.query<{ id: string }>(
    `insert into orders (user_id, sku, quantity, amount_usdc, destination_address, idempotency_key)
     values ($1, $2, $3, $4, $5, $6) returning id`,
    [input.userId, input.sku, input.quantity, input.amountUsdc.toFixed(2), input.destinationAddress, idempotencyKey],
  );
  return { orderId: rows[0].id, idempotencyKey };
}

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
}

export async function getOrder(orderId: string): Promise<OrderRow | null> {
  const { rows } = await pool.query<OrderRow>(
    `select id, user_id, sku, quantity, amount_usdc, destination_address, idempotency_key,
            status, circle_transaction_id
     from orders where id = $1`,
    [orderId],
  );
  return rows[0] ?? null;
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
}
