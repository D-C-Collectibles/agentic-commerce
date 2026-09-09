// Integration tests for #orders-service's money-handling paths: idempotency/dedup and
// the atomic spend-cap check. Runs against the real dev Postgres in DATABASE_URL (no
// mocking layer exists yet in this repo) using a throwaway product/user per test run so
// it never collides with real data, and cleans up everything it inserts.

import { randomUUID } from "node:crypto";
import "dotenv/config";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "../db.js";
import {
  DAILY_CAP_USDC,
  ensureOrderSchema,
  evaluateSpendPolicy,
  markOrderFailed,
  PER_TX_CAP_USDC,
  reserveOrder,
} from "./orders.js";

describe("#orders-service reserveOrder", () => {
  const sku = `test-sku-${randomUUID()}`;
  const userId = `test-user-${randomUUID()}`;
  const destinationAddress = "TEST_MERCHANT";

  beforeAll(async () => {
    await ensureOrderSchema();
    await pool.query(
      "insert into products (sku, name, price_usdc) values ($1, $2, $3)",
      [sku, "Test Product", "45.00"],
    );
  });

  afterAll(async () => {
    await pool.query("delete from orders where user_id = $1", [userId]);
    await pool.query("delete from products where sku = $1", [sku]);
    await pool.end();
  });

  it("dedups a resubmission that reuses the same client-supplied idempotency key", async () => {
    const clientIdempotencyKey = randomUUID();
    const first = await reserveOrder({
      userId,
      sku,
      quantity: 1,
      amountUsdc: 5,
      destinationAddress,
      clientIdempotencyKey,
    });
    expect(first.isNew).toBe(true);
    expect(first.order).not.toBeNull();

    const second = await reserveOrder({
      userId,
      sku,
      quantity: 1,
      amountUsdc: 5,
      destinationAddress,
      clientIdempotencyKey,
    });
    expect(second.isNew).toBe(false);
    expect(second.order?.id).toBe(first.order?.id);

    const { rows } = await pool.query(
      "select count(*) as count from orders where user_id = $1 and sku = $2 and amount_usdc = $3",
      [userId, sku, "5.00"],
    );
    expect(Number(rows[0].count)).toBe(1);
  });

  it("dedups a resubmission with no client key via the (user, sku, quantity, amount) window", async () => {
    const first = await reserveOrder({
      userId,
      sku,
      quantity: 2,
      amountUsdc: 6,
      destinationAddress,
    });
    expect(first.isNew).toBe(true);

    const second = await reserveOrder({
      userId,
      sku,
      quantity: 2,
      amountUsdc: 6,
      destinationAddress,
    });
    expect(second.isNew).toBe(false);
    expect(second.order?.id).toBe(first.order?.id);
  });

  it("does not dedup a genuinely distinct purchase (different quantity)", async () => {
    const first = await reserveOrder({
      userId,
      sku,
      quantity: 3,
      amountUsdc: 7,
      destinationAddress,
    });
    const second = await reserveOrder({
      userId,
      sku,
      quantity: 4,
      amountUsdc: 7,
      destinationAddress,
    });
    expect(first.isNew).toBe(true);
    expect(second.isNew).toBe(true);
    expect(second.order?.id).not.toBe(first.order?.id);
  });

  it("enforces the daily spend cap atomically under concurrent requests for the same user", async () => {
    const raceUserId = `test-race-user-${randomUUID()}`;
    const amountUsdc = 45; // under the $50 per-tx cap; DAILY_CAP_USDC / 45 = 4 max acceptable
    const attempts = 6;

    try {
      const results = await Promise.all(
        Array.from({ length: attempts }, () =>
          reserveOrder({
            userId: raceUserId,
            sku,
            quantity: 1,
            amountUsdc,
            destinationAddress,
            clientIdempotencyKey: randomUUID(), // distinct purchase attempts, not dedup targets
          }),
        ),
      );

      const accepted = results.filter((result) => result.isNew);
      const denied = results.filter((result) => !result.isNew && result.policy.cap === "daily");

      expect(accepted.length + denied.length).toBe(attempts);
      expect(accepted.length).toBeLessThanOrEqual(Math.floor(DAILY_CAP_USDC / amountUsdc));
      expect(accepted.length * amountUsdc).toBeLessThanOrEqual(DAILY_CAP_USDC);
      // At least one request must have been denied — this is the case the old
      // unlocked check-then-insert would have let all 6 pass.
      expect(denied.length).toBeGreaterThan(0);

      const policy = await evaluateSpendPolicy(raceUserId, 0.01);
      expect(policy.ok).toBe(true); // sanity: policy still evaluable after the race
    } finally {
      await pool.query("delete from orders where user_id = $1", [raceUserId]);
    }
  });

  it("marks an order failed on a simulated payment failure, freeing its daily-cap headroom", async () => {
    const failureUserId = `test-failure-user-${randomUUID()}`;
    try {
      const reserved = await reserveOrder({
        userId: failureUserId,
        sku,
        quantity: 1,
        amountUsdc: 8,
        destinationAddress,
        clientIdempotencyKey: randomUUID(),
      });
      expect(reserved.isNew).toBe(true);
      const orderId = reserved.order!.id;

      // Simulates what checkout.ts / verify.ts's settleVerifiedSession now do when
      // executePayment()/transferUsdc() throws: mark the order failed instead of
      // leaving it stuck 'pending' forever.
      await markOrderFailed(orderId, "simulated Circle API error");

      const { rows } = await pool.query<{ status: string }>(
        "select status from orders where id = $1",
        [orderId],
      );
      expect(rows[0].status).toBe("failed");

      // A failed order must not count toward the daily cap — a fresh purchase up to the
      // per-tx cap should be accepted immediately, as if the failed order never happened.
      const policy = await evaluateSpendPolicy(failureUserId, PER_TX_CAP_USDC);
      expect(policy.ok).toBe(true);
    } finally {
      await pool.query("delete from orders where user_id = $1", [failureUserId]);
    }
  });

  it("reclaims a stale pending order under a client idempotency key so retries aren't blocked forever", async () => {
    const staleUserId = `test-stale-user-${randomUUID()}`;
    const clientIdempotencyKey = randomUUID();
    try {
      const first = await reserveOrder({
        userId: staleUserId,
        sku,
        quantity: 1,
        amountUsdc: 9,
        destinationAddress,
        clientIdempotencyKey,
      });
      expect(first.isNew).toBe(true);
      const staleOrderId = first.order!.id;

      // Backdate it past STALE_PENDING_SECONDS to simulate a payment attempt that never
      // came back (e.g. the process died before a try/catch could mark it failed).
      await pool.query(
        "update orders set created_at = now() - interval '10 minutes' where id = $1",
        [staleOrderId],
      );

      const retry = await reserveOrder({
        userId: staleUserId,
        sku,
        quantity: 1,
        amountUsdc: 9,
        destinationAddress,
        clientIdempotencyKey,
      });
      expect(retry.isNew).toBe(true);
      expect(retry.order?.id).not.toBe(staleOrderId);

      const { rows } = await pool.query<{ status: string }>(
        "select status from orders where id = $1",
        [staleOrderId],
      );
      expect(rows[0].status).toBe("failed");
    } finally {
      await pool.query("delete from orders where user_id = $1", [staleUserId]);
    }
  });

  it("still dedups a fresh (non-stale) pending order under a client idempotency key", async () => {
    const freshUserId = `test-fresh-user-${randomUUID()}`;
    const clientIdempotencyKey = randomUUID();
    try {
      const first = await reserveOrder({
        userId: freshUserId,
        sku,
        quantity: 1,
        amountUsdc: 9,
        destinationAddress,
        clientIdempotencyKey,
      });
      expect(first.isNew).toBe(true);

      const second = await reserveOrder({
        userId: freshUserId,
        sku,
        quantity: 1,
        amountUsdc: 9,
        destinationAddress,
        clientIdempotencyKey,
      });
      expect(second.isNew).toBe(false);
      expect(second.order?.id).toBe(first.order?.id);
      expect(second.order?.status).toBe("pending");
    } finally {
      await pool.query("delete from orders where user_id = $1", [freshUserId]);
    }
  });
});
