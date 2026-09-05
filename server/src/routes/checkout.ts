// #checkout-route — see .purpose in this directory. Implements $checkout-flow.

import { randomUUID } from "node:crypto";
import { Router } from "express";
import { pool } from "../db.js";
import { verifyToken } from "../services/auth.js";
import { getOrCreateUserWallet, transferUsdc } from "../services/wallet.js";

export const checkoutRouter = Router();

const PER_TX_CAP_USDC = 50;
const DAILY_CAP_USDC = 200;
const AUTO_APPROVE_THRESHOLD_USDC = 10;

// ponytail: CREATE TABLE IF NOT EXISTS instead of a migration framework — fine at hackathon scale.
async function ensureSchema(): Promise<void> {
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

// ^authenticated — the bearer token is now a signed JWT issued by #auth-service.
// verifyToken checks the signature + expiry and returns the user id (the `sub`
// claim), or null for a missing/invalid/expired token. Backed by the `users`
// table (email + bcrypt password_hash); this replaces the earlier Bearer=userId
// stand-in. Still tech-demo grade — see #auth-service for what's intentionally omitted.
function requireUserId(authHeader: string | undefined): string | null {
  const token = authHeader?.startsWith("Bearer ") ? authHeader.slice("Bearer ".length).trim() : "";
  return verifyToken(token || undefined);
}

checkoutRouter.post("/checkout", async (req, res) => {
  const userId = requireUserId(req.header("authorization"));
  if (!userId) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }

  const { sku, quantity, checkoutConfirmed } = req.body ?? {};
  if (typeof sku !== "string" || !Number.isInteger(quantity) || quantity < 1) {
    res.status(400).json({ error: "invalid_request" });
    return;
  }

  await ensureSchema();

  const destinationAddress = process.env.MERCHANT_PAYOUT_ADDRESS;
  if (!destinationAddress) {
    throw new Error("MERCHANT_PAYOUT_ADDRESS is not set (see server/.env.example)");
  }

  const { rows: productRows } = await pool.query<{ price_usdc: string }>(
    "select price_usdc from products where sku = $1",
    [sku],
  );
  if (!productRows[0]) {
    res.status(404).json({ error: "unknown_sku" });
    return;
  }
  const amountUsdc = Number(productRows[0].price_usdc) * quantity;

  // ^checkout-authorized: per-tx cap
  if (amountUsdc > PER_TX_CAP_USDC) {
    res.status(402).json({
      error: "spend_cap_exceeded",
      cap: "per_tx",
      limit: PER_TX_CAP_USDC.toFixed(2),
      amountUsdc: amountUsdc.toFixed(2),
    });
    return;
  }

  // ^checkout-authorized: daily cap (submitted/confirmed orders only — failed/denied don't count)
  const { rows: dailyRows } = await pool.query<{ total: string | null }>(
    `select sum(amount_usdc) as total from orders
     where user_id = $1 and status in ('submitted', 'confirmed') and created_at > now() - interval '1 day'`,
    [userId],
  );
  const dailyTotal = Number(dailyRows[0]?.total ?? 0);
  if (dailyTotal + amountUsdc > DAILY_CAP_USDC) {
    res.status(402).json({
      error: "spend_cap_exceeded",
      cap: "daily",
      limit: DAILY_CAP_USDC.toFixed(2),
      amountUsdc: amountUsdc.toFixed(2),
    });
    return;
  }

  // ^checkout-authorized: explicit confirmation above auto-approve threshold
  if (amountUsdc > AUTO_APPROVE_THRESHOLD_USDC && checkoutConfirmed !== true) {
    res.status(428).json({
      error: "confirmation_required",
      amountUsdc: amountUsdc.toFixed(2),
      threshold: AUTO_APPROVE_THRESHOLD_USDC.toFixed(2),
    });
    return;
  }

  await getOrCreateUserWallet(userId);

  const idempotencyKey = randomUUID();
  const { rows: orderRows } = await pool.query<{ id: string }>(
    `insert into orders (user_id, sku, quantity, amount_usdc, destination_address, idempotency_key)
     values ($1, $2, $3, $4, $5, $6) returning id`,
    [userId, sku, quantity, amountUsdc.toFixed(2), destinationAddress, idempotencyKey],
  );
  const orderId = orderRows[0].id;

  const transfer = await transferUsdc({
    userId,
    destinationAddress,
    amountUsdc: amountUsdc.toFixed(2),
    idempotencyKey,
  });

  await pool.query(
    "update orders set circle_transaction_id = $1, status = 'submitted', updated_at = now() where id = $2",
    [transfer.circleTransactionId, orderId],
  );

  // !payment-submitted
  res.json({
    orderId,
    circleTransactionId: transfer.circleTransactionId,
    amountUsdc: amountUsdc.toFixed(2),
    state: transfer.state,
  });
});
